// Hintergrundlogik: Sicherung der Tabs aller Workspaces

// Tab-Änderungen werden verzögert gesichert. Wird vorher das letzte Hauptfenster
// geschlossen, sind seine Tabs nicht mehr abfragbar. Deshalb wird bei jeder Änderung
// sofort ein Abbild der Hauptfenster (Tabs und ihre Gruppen) aufgefrischt, aus dem
// onWindowRemoved die fällige Sicherung nachholt.
const image = new Map(); // Fenster-ID → { win, groups }
// Fenster, die gerade schließen (Zeitpunkt): ihr Abbild bleibt, wie es war. Wird das
// Schließen abgebrochen (etwa im Dialog „Seite verlassen?“), gilt das nach 10 s nicht mehr.
const closing = new Map();
const isClosing = (id) => Date.now() - (closing.get(id) ?? -Infinity) < 10000;
let changes = 0; // Tab-Änderungen seit dem Start des Service Workers
let savedChanges = 0; // davon in der Sicherung enthalten
// Selbst geschlossene Tabs, die die Sicherung noch enthält ({ windowId, url, at }, at ist
// der Stand von changes). repairFromBackup ergänzt sie nicht wieder (#150). Die Adresse
// kommt aus dem Abbild; fehlt sie dort, ist sie null.
const closedTabs = [];

let knownGroups = []; // letzte Antwort der Gruppenabfrage

// Ohne groups behält ein Fenster die bisher bekannten Gruppen, ergänzt aus knownGroups
function remember(wins, groups, replace = false) {
  if (replace) for (const id of image.keys()) if (!isClosing(id)) image.delete(id);
  for (const w of wins) {
    if (w.incognito || stashWsOf(w) || isClosing(w.id)) continue;
    const own = (list) => list.filter((g) => g.windowId === w.id).map((g) => [g.id, g]);
    image.set(w.id, { win: w, groups: new Map(groups ? own(groups) : [...own(knownGroups), ...(image.get(w.id)?.groups || [])]) });
  }
}

let imaging = false;
let imageAgain = false;
async function refreshImage() {
  if (imaging) {
    imageAgain = true;
    return;
  }
  imaging = true;
  try {
    do {
      imageAgain = false;
      // Die Gruppen ergänzen, wenn sie kommen: die Tabs warten nicht auf sie
      chrome.tabGroups.query({}).then((groups) => {
        knownGroups = groups;
        for (const g of groups) if (!isClosing(g.windowId)) image.get(g.windowId)?.groups.set(g.id, g);
      }, () => {});
      remember(await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }));
    } while (imageAgain);
  } catch (e) {
    console.warn('[workspaces] Abbild der Fenster', e);
  } finally {
    imaging = false;
  }
}

function scheduleSnapshot() {
  changes++;
  refreshImage();
  debounce('snapshot', 300, () => snapshot().finally(checkSession), 2000);
}

function noteClosed(tabId, windowId) {
  const t = image.get(windowId)?.win.tabs.find((x) => x.id === tabId);
  closedTabs.push({ windowId, url: t ? urlOf(t) : null, at: changes });
}

function serTab(t, groups) {
  const e = { url: urlOf(t) || '', title: t.title || '' };
  if (typeof t.groupId === 'number' && t.groupId >= 0) {
    const g = groups.get(t.groupId);
    e.g = String(t.groupId);
    e.gt = g?.title || '';
    e.gc = g?.color || 'grey';
    e.gx = !!g?.collapsed;
  }
  return e;
}

// Angeheftete Tabs aller Hauptfenster, jede Adresse so oft, wie sie in einem einzelnen
// Fenster höchstens vorkommt: dieselbe Adresse in zwei Fenstern zählt einmal.
function pinnedOf(mains, groups) {
  const out = [];
  const most = new Map();
  for (const w of mains) {
    const own = new Map();
    for (const e of w.tabs.filter((t) => t.pinned).map((t) => serTab(t, groups))) {
      const n = (own.get(e.url) || 0) + 1;
      own.set(e.url, n);
      if (n > (most.get(e.url) || 0)) {
        most.set(e.url, n);
        out.push(e);
      }
    }
  }
  return out;
}

// Sichert den Inhalt aller Workspaces, falls ein Fenster verloren geht
// (z. B. wenn das Hauptfenster per X geschlossen wird). gone: das gerade geschlossene
// letzte Hauptfenster aus dem Abbild ({ win, groups, ws }), das noch mitgesichert wird.
async function snapshot(gone) {
  if (await getPending()) return; // Wechsel noch nicht abgeschlossen
  const at = changes;
  const cfg = await getConfig();
  const s = await sess();
  const { stash, mains: live } = await scan();
  const groupList = await chrome.tabGroups.query({});
  // Ein schließendes Fenster verliert seine Tabs einzeln: stattdessen sein Abbild sichern
  const mains = live.map((w) => (isClosing(w.id) && image.get(w.id)?.win) || w);
  const imageGroups = live.filter((w) => isClosing(w.id)).flatMap((w) => [...(image.get(w.id)?.groups || [])]);
  if (gone) {
    mains.push(gone.win);
    s.windowWs[gone.win.id] = gone.ws;
  }
  // Ohne (zugeordnete) Hauptfenster ist der Zustand im Übergang (Start, Beenden,
  // neues Fenster): alte Sicherung behalten, reconcile sichert danach.
  if (!mains.length || mains.some((w) => !s.windowWs[w.id])) return;
  if (!gone) remember(live, groupList, true);
  const { backup } = await getBackup();
  const groups = new Map([...(gone?.groups || []), ...imageGroups, ...groupList.map((g) => [g.id, g])]);

  for (const ws of cfg.workspaces) {
    const { sw, showing } = windowsOf(ws.id, s, stash, mains);
    if (!sw && !showing.length) continue; // nichts Lebendes → alten Stand behalten
    const failed = backup[ws.id]?.failed;
    backup[ws.id] = {
      stash: sw ? stashTabsOf(sw).map((t) => serTab(t, groups)) : [],
      shown: showing.flatMap((w) => movableTabsOf(w).map((t) => serTab(t, groups))),
      ...(failed?.length ? { failed } : {}),
    };
  }
  for (const k of Object.keys(backup)) {
    if (!cfg.workspaces.some((w) => w.id === k)) delete backup[k];
  }
  // Ablage-Fenster merken, um sie nach einem Neuladen der Erweiterung zu reparieren
  const stashWins = {};
  for (const [ws, w] of stash) stashWins[w.id] = { ws, tabs: stashTabsOf(w).map((t) => t.id) };

  const backupWindows = mains.map((w) => ({
    id: w.id,
    ws: s.windowWs[w.id],
    urls: movableTabsOf(w).map(urlOf),
  }));

  try {
    await chrome.storage.local.set({ backup, stashWins, backupWindows, backupPinned: pinnedOf(mains, groups) });
  } catch (e) {
    // Etwa wegen voller Speichergrenze. Die Sicherung bleibt auf dem alten Stand, das
    // Popup weist darauf hin, bis wieder eine gelingt.
    const { backupError } = await chrome.storage.session.get('backupError');
    await chrome.storage.session.set({ backupError: { since: backupError?.since ?? Date.now(), message: String(e?.message || e) } });
    throw e;
  }
  savedChanges = Math.max(savedChanges, at);
  for (let i = closedTabs.length - 1; i >= 0; i--) if (closedTabs[i].at <= savedChanges) closedTabs.splice(i, 1);
  await chrome.storage.session.remove('backupError');
}
