// Hintergrundlogik: Tabs entladen
//
// Entladen (tabs.discard) gibt den Arbeitsspeicher eines Tabs frei. Er bleibt mit Adresse,
// Titel und Gruppe stehen und lädt neu, sobald er aktiv wird. Chromium gibt ihm dabei eine
// neue ID (tabs.onReplaced, siehe replaceTabId). Vor dem ersten Eintrag in den Verlauf
// entladen, verlöre er seine Adresse; ein solcher Tab bleibt deshalb geladen.

// Aus der Sicherung angelegte Tabs, die nach dem ersten vollständigen Laden entladen werden.
// Die Liste steht in storage.session, damit sie einen Neustart des Service Workers zwischen
// Anlegen und Laden übersteht (#125). Gearbeitet wird auf einer Kopie im Speicher, die der
// Worker beim ersten Zugriff einmal liest; jede Änderung wird in der Reihenfolge gespeichert,
// in der sie geschah. So gehen gleichzeitige Änderungen nicht verloren.
let unloadLaterP = null;
let unloadLaterSaved = Promise.resolve();

function unloadLaterIds() {
  unloadLaterP ??= chrome.storage.session
    .get('unloadLater')
    .then(({ unloadLater }) => new Set(unloadLater || []))
    .catch(() => new Set());
  return unloadLaterP;
}

function saveUnloadLater(ids) {
  const list = [...ids];
  const area = chrome.storage.session;
  unloadLaterSaved = unloadLaterSaved
    .then(() => (list.length ? area.set({ unloadLater: list }) : area.remove('unloadLater')))
    .catch((e) => console.warn('[workspaces] unloadLater nicht gespeichert:', e));
  return unloadLaterSaved;
}

async function unloadLaterAdd(tabId) {
  const ids = await unloadLaterIds();
  ids.add(tabId);
  loadingSince.set(tabId, Date.now());
  await saveUnloadLater(ids);
}

// true, wenn der Tab auf der Liste stand; er wird dabei gestrichen
async function unloadLaterTake(tabId) {
  const ids = await unloadLaterIds();
  if (!ids.delete(tabId)) return false;
  await saveUnloadLater(ids);
  return true;
}

// Aus der Sicherung laden höchstens LOAD_AT_ONCE Tabs gleichzeitig, sonst rufen 80 Tabs
// eines Workspace 80 Seiten auf einmal auf (#158). Ein Tab zählt, bis er fertig geladen
// hat, höchstens LOAD_TIMEOUT lang. Seit wann er lädt, steht nur im Speicher; nach einem
// Neustart des Service Workers zählt er ab dem ersten Blick.
const LOAD_AT_ONCE = 6;
const LOAD_TIMEOUT = 15000;
const loadingSince = new Map();

// Wie viele aus der Sicherung angelegte Tabs noch laden (n) und in wie vielen ms der
// älteste davon nicht mehr zählt (wait)
async function restoredLoading() {
  const ids = await unloadLaterIds();
  const now = Date.now();
  for (const id of loadingSince.keys()) if (!ids.has(id)) loadingSince.delete(id);
  let n = 0;
  let wait = Infinity;
  const gone = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id).catch(() => null);
    // Geschlossen, solange der Service Worker nicht lief, oder von Chromium entladen und
    // dabei mit neuer ID versehen: der Tab lädt nie mehr fertig
    if (!t) {
      gone.push(id);
      continue;
    }
    if (!loadingSince.has(id)) loadingSince.set(id, now);
    const left = loadingSince.get(id) + LOAD_TIMEOUT - now;
    if (left <= 0 || t.status !== 'loading') continue;
    n++;
    wait = Math.min(wait, left);
  }
  for (const id of gone) await unloadLaterTake(id);
  return { n, wait };
}

// Chromium vergisst dabei die Stummschaltung, deshalb wird sie danach wieder gesetzt. Die
// neue ID wird gleich nachgezogen, nicht erst über tabs.onReplaced: Eine Aktion, die schon
// in serial() wartet, liefe sonst noch mit der alten. Bis sie in stashWins steht, steht die
// alte ID in 'discarding'. Lädt die Erweiterung in dieser Lücke neu, erkennt repairStashes
// daran die Ablage, deren letzter gemerkter Tab gerade entladen wurde (#272).
// Gibt den entladenen Tab zurück, sonst null
async function discard(t) {
  if (t.active || t.discarded || !t.url) return null;
  await chrome.storage.local.set({ discarding: t.id });
  ownDiscards.set(t.id, null);
  const d = await chrome.tabs.discard(t.id).catch((e) => console.warn('[workspaces] Tab nicht entladbar:', t.url, e));
  if (d && d.id !== t.id) {
    ownDiscards.set(t.id, d.id);
    await replaceTabId(t.id, d.id);
  } else ownDiscards.delete(t.id);
  await chrome.storage.local.remove('discarding');
  if (!d) return null;
  if (t.mutedInfo?.muted) await chrome.tabs.update(d.id, { muted: true }).catch(() => {});
  return d;
}

// Alte ID → neue ID der Tabs, die discard() entlädt (null, solange tabs.discard läuft).
// Für sie zieht tabs.onReplaced die ID nicht ein zweites Mal nach und sichert nicht je Tab;
// das tut der Aufrufer von discard() einmal mit scheduleSnapshot (#302). Ob das Ereignis zu
// discard() gehört, steht erst fest, wenn tabs.discard fertig ist, deshalb entscheidet es
// sich in der Warteschlange: Hat Chromium den Tab vorher selbst entladen, scheitert
// tabs.discard, und die neue ID wird hier nachgezogen. Chromium 151 behält die ID beim
// Entladen; dann kommt kein tabs.onReplaced, und es gibt nichts zu sichern.
const ownDiscards = new Map();

async function replacedWhileDiscarding(from, to) {
  if (ownDiscards.get(from) === to) return void ownDiscards.delete(from);
  await replaceTabId(from, to);
  scheduleSnapshot();
}

// Ein entladener Tab lädt sonst neu, sobald er aktiv wird. Wechselt das Popup den
// Workspace, bleibt er manchmal aktiv und entladen stehen, der Inhalt grau (#217).
async function loadIfDiscarded(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t?.active && t.discarded) await chrome.tabs.reload(tabId).catch((e) => console.warn('[workspaces] Tab lädt nicht:', t.url, e));
}

async function unloadRestored(tabId) {
  if (await getPending()) return;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  const d = t && (await discard(t));
  if (d && d.id !== t.id) scheduleSnapshot();
}

// Option „Ablagen entladen nach“: Minuten, 0 = nie
const UNLOAD_CHOICES = [0, 5, 15, 30, 60, 120];

async function getUnloadAfter() {
  const { unloadAfter } = await chrome.storage.local.get('unloadAfter');
  return UNLOAD_CHOICES.includes(unloadAfter) ? unloadAfter : 0;
}

// Ein Wecker prüft jede Minute, solange die Option eingeschaltet ist
async function scheduleUnload() {
  if (!(await getUnloadAfter())) return chrome.alarms.clear('unload');
  if (!(await chrome.alarms.get('unload'))) await chrome.alarms.create('unload', { periodInMinutes: 1 });
}

async function setUnloadAfter(minutes) {
  if (!UNLOAD_CHOICES.includes(minutes)) throw new Error(tr('unloadInvalid'));
  await chrome.storage.local.set({ unloadAfter: minutes });
  await scheduleUnload();
}

// Wann ein Tab zuletzt Ton abgespielt hat, steht in silentSince in storage.session: der
// Zeitpunkt, an dem audible auf false ging. Ein Videocall, in dem gerade niemand spricht,
// oder Musik zwischen zwei Titeln ist sonst genau beim Wecker still und würde entladen (#154).
// Der Zeitpunkt wird beim Ereignis genommen, gespeichert wird nacheinander mit dem Entladen,
// und nur, solange die Option eingeschaltet ist. Bis dahin steht er in silentPending, damit
// ein Wecker, der schon läuft, den gerade still gewordenen Tab nicht entlädt.
const silentPending = {};

function noteSilent(tabId) {
  const at = Date.now();
  silentPending[tabId] = at;
  serial(async () => {
    if (silentPending[tabId] === at) delete silentPending[tabId];
    if (!(await getUnloadAfter())) return;
    const { silentSince = {} } = await chrome.storage.session.get('silentSince');
    await chrome.storage.session.set({ silentSince: { ...silentSince, [tabId]: at } });
  });
}

// Ein Tab kam in die Ablage, nachdem sein Workspace weggewechselt wurde (Tab in Workspace
// verschieben, Link in Workspace öffnen). Für ihn läuft die Zeit ab jetzt, nicht ab
// stashedAt, sonst entlüde ihn schon der nächste Wecker (#291). Der Zeitpunkt steht in
// arrivedAt in storage.session; Einträge, die länger zurückliegen als die längste
// angebotene Zeit, verschonen niemanden mehr und fallen weg.
async function noteArrived(tabIds) {
  const now = Date.now();
  const { arrivedAt = {} } = await chrome.storage.session.get('arrivedAt');
  const keep = Object.fromEntries(Object.entries(arrivedAt).filter(([, at]) => now - at < Math.max(...UNLOAD_CHOICES) * 60000));
  for (const id of tabIds) keep[id] = now;
  await chrome.storage.session.set({ arrivedAt: keep });
}

// Entlädt die Tabs der Ablagen, deren Workspace seit unloadAfter Minuten nicht mehr
// gezeigt wird. Seit wann, steht in stashedAt (finishSwitch); eine Ablage ohne Eintrag
// (nach Start oder Neuladen der Erweiterung) zählt ab jetzt. Ein Tab, der erst später
// dazukam, zählt ab seinem Ankommen (arrivedAt). Tabs, deren Ton zu hören ist oder in den
// letzten unloadAfter Minuten zu hören war, bleiben geladen.
// Ein Schritt entlädt höchstens UNLOAD_BATCH Tabs und reiht für den Rest einen neuen ein. Ein
// Wechsel, der inzwischen wartet, kommt so dazwischen, statt hinter allen Tabs zu warten:
// 76 Tabs hielten die Warteschlange in Chromium 151 über 300 ms auf (#302).
const UNLOAD_BATCH = 10;

async function unloadStashes() {
  const minutes = await getUnloadAfter();
  if (!minutes || (await getPending())) return;
  const { stash } = await scan();
  const { stashedAt = {}, silentSince = {}, arrivedAt = {} } = await chrome.storage.session.get(['stashedAt', 'silentSince', 'arrivedAt']);
  const now = Date.now();
  const recent = (at) => now - at < minutes * 60000;
  // silentPending je Tab neu lesen: Es kann sich während des Entladens noch füllen
  const heard = (t) => !t.mutedInfo?.muted && (t.audible || recent(silentPending[t.id] ?? silentSince[t.id] ?? -Infinity));
  const next = {};
  let unloaded = 0;
  let replaced = false;
  for (const [ws, w] of stash) {
    next[ws] = stashedAt[ws] ?? now;
    if (recent(next[ws])) continue;
    for (const t of stashTabsOf(w)) {
      if (unloaded >= UNLOAD_BATCH || heard(t) || recent(arrivedAt[t.id] ?? -Infinity)) continue;
      const d = await discard(t);
      if (!d) continue;
      unloaded++;
      if (d.id !== t.id) replaced = true;
    }
  }
  if (replaced) scheduleSnapshot();
  // Ältere Zeitpunkte verschonen niemanden mehr
  const fresh = (o) => Object.fromEntries(Object.entries(o).filter(([, at]) => recent(at)));
  await chrome.storage.session.set({ stashedAt: next, silentSince: fresh({ ...silentSince, ...silentPending }), arrivedAt: fresh(arrivedAt) });
  if (unloaded >= UNLOAD_BATCH) serial(unloadStashes);
}

// Ein Tab hat durch Entladen eine neue ID bekommen: gemerkte IDs nachziehen. Gespeichert
// wird nur, was die alte ID enthielt; ein zweiter Aufruf für dasselbe Paar ändert nichts mehr.
async function replaceTabId(from, to) {
  const swap = (id) => (id === from ? to : id);
  if (ownTabs.delete(from)) ownTabs.add(to);
  const sessionKeys = ['lastTab', 'tabOrigin', 'pendingSwitch', 'pendingRetry', 'pendingStart', 'startCopies', 'startSeen', 'startNew', 'startFed'];
  const localKeys = ['pendingSwitch', 'stashMuted', 'pendingFeed', 'stashWins', 'pendingMove', 'pendingDelete'];
  const [{ lastTab = {}, tabOrigin = {}, pendingSwitch, pendingRetry: r, pendingStart: ps, startCopies, startSeen, startNew = {}, startFed = [] }, local] = await Promise.all([
    chrome.storage.session.get(sessionKeys),
    chrome.storage.local.get(localKeys),
  ]);
  const changed = {};
  for (const [ws, id] of Object.entries(lastTab)) {
    if (id !== from) continue;
    lastTab[ws] = to;
    changed.lastTab = lastTab;
  }
  if (from in tabOrigin) {
    tabOrigin[to] = tabOrigin[from];
    delete tabOrigin[from];
    changed.tabOrigin = tabOrigin;
  }
  if (Object.keys(changed).length) await chrome.storage.session.set(changed);
  // wie getPending()
  const p = pendingSwitch || local.pendingSwitch || null;
  if (p?.oldTabs.includes(from)) await setPending({ ...p, oldTabs: p.oldTabs.map(swap) });
  if (r) await chrome.storage.session.set({ pendingRetry: { ...r, open: r.open.map((x) => ({ ...x, id: swap(x.id) })) } });
  if (ps) await chrome.storage.session.set({ pendingStart: { ...ps, known: ps.known.map(swap), blank: swap(ps.blank) } });
  if (startCopies) {
    await chrome.storage.session.set({
      startCopies: startCopies.map((c) => ({ ...c, id: swap(c.id) })),
      startFed: startFed.map((c) => ({ ...c, id: swap(c.id) })),
      startSeen: (startSeen || []).map(swap),
      startNew: Object.fromEntries(Object.entries(startNew).map(([id, at]) => [swap(+id), at])),
    });
  }
  const { stashMuted, pendingFeed: f, stashWins, pendingMove, pendingDelete: d } = local;
  if (stashMuted?.includes(from)) await chrome.storage.local.set({ stashMuted: stashMuted.map(swap) });
  if (f?.known.includes(from)) await chrome.storage.local.set({ pendingFeed: { ...f, known: f.known.map(swap) } });
  if (stashWins) {
    let hit = false;
    for (const rec of Object.values(stashWins)) {
      if (rec.tabs?.includes(from)) {
        rec.tabs = rec.tabs.map(swap);
        hit = true;
      }
    }
    if (hit) await chrome.storage.local.set({ stashWins });
  }
  if (pendingMove?.tabs?.includes(from)) await setPendingMove({ ...pendingMove, tabs: pendingMove.tabs.map(swap) });
  if (d?.groups.some((g) => g.tabIds.includes(from))) {
    await chrome.storage.local.set({ pendingDelete: { ...d, groups: d.groups.map((g) => ({ ...g, tabIds: g.tabIds.map(swap) })) } });
  }
}
