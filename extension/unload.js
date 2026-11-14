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
  await saveUnloadLater(ids);
}

// true, wenn der Tab auf der Liste stand; er wird dabei gestrichen
async function unloadLaterTake(tabId) {
  const ids = await unloadLaterIds();
  if (!ids.delete(tabId)) return false;
  await saveUnloadLater(ids);
  return true;
}

// Chromium vergisst dabei die Stummschaltung, deshalb wird sie danach wieder gesetzt. Die
// neue ID wird gleich nachgezogen, nicht erst über tabs.onReplaced: Eine Aktion, die schon
// in serial() wartet, liefe sonst noch mit der alten.
async function discard(t) {
  if (t.active || t.discarded || !t.url) return;
  const d = await chrome.tabs.discard(t.id).catch((e) => console.warn('[workspaces] Tab nicht entladbar:', t.url, e));
  if (!d) return;
  if (d.id !== t.id) await replaceTabId(t.id, d.id);
  if (t.mutedInfo?.muted) await chrome.tabs.update(d.id, { muted: true }).catch(() => {});
}

async function unloadRestored(tabId) {
  if (await getPending()) return;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t) await discard(t);
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

// Entlädt die Tabs der Ablagen, deren Workspace seit unloadAfter Minuten nicht mehr
// gezeigt wird. Seit wann, steht in stashedAt (finishSwitch); eine Ablage ohne Eintrag
// (nach Start oder Neuladen der Erweiterung) zählt ab jetzt. Tabs, deren Ton zu hören
// ist, bleiben geladen.
async function unloadStashes() {
  const minutes = await getUnloadAfter();
  if (!minutes || (await getPending())) return;
  const { stash } = await scan();
  const { stashedAt = {} } = await chrome.storage.session.get('stashedAt');
  const now = Date.now();
  const next = {};
  for (const [ws, w] of stash) {
    next[ws] = stashedAt[ws] ?? now;
    if (now - next[ws] < minutes * 60000) continue;
    for (const t of stashTabsOf(w)) if (!t.audible || t.mutedInfo?.muted) await discard(t);
  }
  await chrome.storage.session.set({ stashedAt: next });
}

// Ein Tab hat durch Entladen eine neue ID bekommen: gemerkte IDs nachziehen. Ein zweiter
// Aufruf für dasselbe Paar ändert nichts mehr.
async function replaceTabId(from, to) {
  const swap = (id) => (id === from ? to : id);
  if (ownTabs.delete(from)) ownTabs.add(to);
  const s = await sess();
  for (const [ws, id] of Object.entries(s.lastTab)) s.lastTab[ws] = swap(id);
  if (from in s.tabOrigin) {
    s.tabOrigin[to] = s.tabOrigin[from];
    delete s.tabOrigin[from];
  }
  await saveSess(s);
  const { pendingSwitch: p, startCopies, startSeen, startNew = {} } = await chrome.storage.session.get(['pendingSwitch', 'startCopies', 'startSeen', 'startNew']);
  if (p) await setPending({ ...p, oldTabs: p.oldTabs.map(swap) });
  if (startCopies) {
    await chrome.storage.session.set({
      startCopies: startCopies.map((c) => ({ ...c, id: swap(c.id) })),
      startSeen: (startSeen || []).map(swap),
      startNew: Object.fromEntries(Object.entries(startNew).map(([id, at]) => [swap(+id), at])),
    });
  }
  const { stashMuted } = await chrome.storage.local.get('stashMuted');
  if (stashMuted?.includes(from)) await chrome.storage.local.set({ stashMuted: stashMuted.map(swap) });
}
