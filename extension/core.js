// Hintergrundlogik, Grundlagen: Speicher, Ablauf, Fenster erkennen, Tabs bewegen

const STASH_PAGE = chrome.runtime.getURL('stash.html');
// Ablage-Seite mit ?shown#<id>: Titel ohne Schlüssel, das KWin-Skript versteckt sie nicht (stash.js)
const SHOWN = 'shown';
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];

let switching = 0; // > 0, solange wir selbst Tabs verschieben
// Dabei selbst angelegte Tabs; dropStartCopies merkt sie sich als nicht wiederhergestellt
const ownTabs = new Set();

// Führt fn aus, während die Tab-Ereignisse die eigenen Änderungen übergehen
async function moving(fn) {
  switching++;
  try {
    return await fn();
  } finally {
    switching--;
    if (!switching && changedMoving) {
      changedMoving = false;
      snapshotSoon();
    }
  }
}

// ---------------------------------------------------------------- Speicher

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

async function getConfig() {
  let { workspaces, lastWs } = await chrome.storage.local.get(['workspaces', 'lastWs']);
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    workspaces = [{ id: newId(), name: tr('defaultWorkspace'), color: COLORS[0], emoji: '' }];
    await chrome.storage.local.set({ workspaces });
  }
  if (!workspaces.some((w) => w.id === lastWs)) lastWs = workspaces[0].id;
  return { workspaces, lastWs };
}

// Geräteeigener Schlüssel im Titel der Ablage-Fenster (stash.js). Das KWin-Skript
// versteckt nur Fenster mit diesem Schlüssel, install.sh trägt ihn in kwinrc ein.
async function ensureToken() {
  let { token } = await chrome.storage.local.get('token');
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ token });
  }
  return token;
}

// install.sh meldet native-host.sh unter diesem Namen als Native-Messaging-Host an. Er schreibt
// auch die automatischen Sicherungen (autobackup.js). Ihm schickt die Erweiterung ihren
// Schlüssel, und er trägt ihn in kwinrc ein, falls er dort fehlt. Das klappt einmal je
// Browsersitzung; bis dahin versucht sie es bei jedem Start des Service
// Workers und jedem Öffnen des Popups. Ohne angemeldeten Host (install.sh noch nicht
// ausgeführt, anderer Browser) bleibt der Weg über das Popup und install.sh <Schlüssel>.
const NATIVE_HOST = 'helium_workspaces';
let delivering = null;
function deliverKey(token) {
  delivering ??= (async () => {
    try {
      const { keyDelivered } = await chrome.storage.session.get('keyDelivered');
      if (keyDelivered === token) return;
      const r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { key: token });
      if (r?.ok) await chrome.storage.session.set({ keyDelivered: token });
      else console.warn('[workspaces] Schlüssel nicht eingetragen', r);
    } catch (e) {
      console.debug('[workspaces] Kein Host für den Schlüssel', e);
    } finally {
      delivering = null;
    }
  })();
  return delivering;
}

async function saveWorkspaces(workspaces) {
  await chrome.storage.local.set({ workspaces });
  await buildMenus();
}

// Laufzeitzustand (überlebt Neustarts des Service Workers, nicht des Browsers)
async function sess() {
  // prevWs: je Hauptfenster der Workspace, den es vor dem jetzigen zeigte
  const s = await chrome.storage.session.get(['windowWs', 'prevWs', 'lastTab', 'tabOrigin']);
  return { windowWs: s.windowWs || {}, prevWs: s.prevWs || {}, lastTab: s.lastTab || {}, tabOrigin: s.tabOrigin || {} };
}

async function saveSess(s) {
  await chrome.storage.session.set(s);
}

// storage.session hat eine feste Größe: 10 MB, in Chrome vor Version 112 nur 1 MB. Ist sie
// voll, scheitert jedes Speichern des Laufzeitzustands: Wechsel brechen ab, und neue
// Fenster kommen nicht mehr in die Sicherung. Bei 1 MB zeigt das Popup einen Hinweis,
// ab 98 % warnen Popup und Plakette.
const SESSION_ROOMY = 10 * 1024 * 1024;
const SESSION_FULL = 0.98;
let sessionFull = false;

async function sessionUsage() {
  const area = chrome.storage.session;
  const quota = area.QUOTA_BYTES || SESSION_ROOMY;
  let used;
  try {
    used = await area.getBytesInUse(null);
  } catch {
    // Ohne getBytesInUse wie Chromium schätzen: Schlüssel, Wert als JSON und etwa 64 Byte je Eintrag
    used = Object.entries(await area.get(null)).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length + 64, 0);
  }
  const full = used >= quota * SESSION_FULL;
  if (full !== sessionFull) {
    sessionFull = full;
    await updateAllIcons();
  }
  return { used, quota, tight: quota < SESSION_ROOMY, full };
}

// Nach jeder Sicherung; ein Fehler beim Messen soll nichts anderes aufhalten
const checkSession = () => sessionUsage().catch((e) => console.warn('[workspaces] Speicher messen', e));

// Gesicherte Tabs eines Workspace: erst die gezeigten, dann die der Ablage, dann die
// beim Aufbau zurückgestellten (keepLater)
const savedOf = (b) => [...(b?.shown || []), ...(b?.stash || []), ...(b?.later || [])];

// Vermerke begonnener Aktionen (pendingSwitch und die anderen, siehe dort). snapshot() und
// resumeSwitch() lesen sie vor jeder Aktion und Sicherung, gebündelt in einem Zugriff je
// Speicher statt einzeln nacheinander (#305).
async function getMarks() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['pendingSwitch', 'pendingStash', 'pendingMove', 'pendingDelete', 'pendingFeed', 'discarding']),
    chrome.storage.session.get(['pendingSwitch', 'pendingStart', 'pendingRetry']),
  ]);
  return { local, session };
}

// Zahl der gescheiterten Tabs je Workspace für die Plakette (icons.js). Jedes fertige Laden
// einer Seite setzt das Symbol des Tabs neu, und die Sicherung kann mit vielen Tabs Hunderte
// KB groß sein; sie wird deshalb nur nach dem Start des Service Workers gelesen (#304).
// Danach übernimmt setLocal die Zahlen aus der Sicherung, die es schreibt. Das genügt, weil
// nur dieser Service Worker sie schreibt, die Seiten schicken Nachrichten.
let failedCache = null;
let backupGen = 0;
const countFailed = (backup) => new Map(Object.entries(backup || {}).map(([id, b]) => [id, b?.failed?.length || 0]));

async function failedCounts() {
  if (failedCache?.gen === backupGen) return failedCache.counts;
  // Stand vor dem Lesen: Wird währenddessen gespeichert, gilt das Gelesene nicht mehr
  const gen = backupGen;
  const counts = countFailed((await getBackup()).backup);
  if (gen === backupGen) failedCache = { gen, counts };
  return counts;
}

// Jedes Speichern der Sicherung läuft hierüber. backupGen steigt davor und danach: So
// verwirft failedCounts, was es um ein Speichern herum gelesen hat, und von zwei Speichern
// zählt das spätere.
async function setLocal(items) {
  if (!('backup' in items)) return chrome.storage.local.set(items);
  const gen = ++backupGen;
  await chrome.storage.local.set(items);
  if (gen === backupGen) failedCache = { gen: ++backupGen, counts: countFailed(items.backup) };
}

async function getBackup() {
  const { backup, backupPinned, pinnedLater } = await chrome.storage.local.get(['backup', 'backupPinned', 'pinnedLater']);
  return { backup: backup || {}, backupPinned: backupPinned || [], pinnedLater: pinnedLater || [] };
}

// ---------------------------------------------------------------- Ablauf

// Alle Änderungen laufen nacheinander, damit sich nichts überschneidet.
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error('[workspaces]', e));
  return p;
}

// Für Aktionen (Popup, Tastenkürzel, Menü): Nach Browserstart oder Neuladen der
// Erweiterung ist storage.session leer, bis der erste Abgleich gelaufen ist. Bis dahin
// gälte jedes Fenster als lastWs, deshalb den Abgleich vorziehen. Er läuft nicht schon
// beim Laden des Skripts, damit onStartup vorher die veralteten Fenster-IDs verwirft.
function userAction(fn) {
  return serial(async () => {
    const { entriesUntil } = await chrome.storage.session.get('entriesUntil');
    if (entriesUntil === undefined) await reconcile();
    try {
      return await fn();
    } finally {
      await syncMute();
    }
  });
}

// Wie userAction, die Antwort kommt aber schon, wenn fn das übergebene shown() aufruft: Das
// Popup schließt, sobald der Wechsel zu sehen ist. Der Rest (Symbole, Sicherung, Stummschalten)
// läuft danach weiter in derselben serial()-Kette (#297).
function userActionShown(fn) {
  let shown;
  const early = new Promise((resolve) => (shown = resolve));
  return Promise.race([early, userAction(() => fn(shown))]);
}

// Zusammenfassen von Ereignissen, aber spätestens nach maxMs ausführen.
const timers = {};
const firstCall = {};
function debounce(name, ms, fn, maxMs = Infinity) {
  firstCall[name] ??= Date.now();
  clearTimeout(timers[name]);
  const wait = Math.max(0, Math.min(ms, firstCall[name] + maxMs - Date.now()));
  timers[name] = setTimeout(() => {
    delete firstCall[name];
    serial(fn);
  }, wait);
}

const scheduleReconcile = () => debounce('reconcile', 800, reconcile);

// ---------------------------------------------------------------- Fenster erkennen

const urlOf = (t) => t.url || t.pendingUrl;

function isStashTab(t) {
  return (urlOf(t) || '').startsWith(STASH_PAGE);
}

const isNewTab = (t) => /^chrome:\/\/(newtab|new-tab-page)\//.test(urlOf(t) || '');

function stashWsOf(win) {
  for (const t of win.tabs || []) {
    if (isStashTab(t)) return urlOf(t).split('#')[1] || null;
  }
  return null;
}

async function scan() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const stash = new Map();
  const mains = [];
  const dups = [];
  for (const w of wins) {
    // Die normale und die Inkognito-Instanz (incognito.js) führen je nur ihre eigenen Fenster
    if (w.incognito !== INCOGNITO) continue;
    const ws = stashWsOf(w);
    if (ws) {
      if (stash.has(ws)) dups.push(w);
      else stash.set(ws, w);
    } else {
      mains.push(w);
    }
  }
  return { stash, mains, dups };
}

// Die Tabs, die zu einem Workspace gehören: weder angeheftet noch die Ablage-Seite. Die
// Ablage-Seite ist nicht angeheftet, weil Helium ab 0.22 angeheftete Tabs mit allen Fenstern
// teilt: Sie stünde sonst in jedem Fenster, und jedes sähe wie die Ablage aus. Dafür legt
// Helium die angehefteten Tabs auch in jede Ablage; die bleiben dort liegen (#265).
const movableTabsOf = (win) => win.tabs.filter((t) => !t.pinned && !isStashTab(t));
const stashTabsOf = movableTabsOf;

// Ablage (sw) und Hauptfenster (showing), in denen die Tabs von wsId gerade liegen
const windowsOf = (wsId, s, stash, mains) => ({
  sw: stash.get(wsId),
  showing: mains.filter((w) => s.windowWs[w.id] === wsId),
});

// ---------------------------------------------------------------- Tabs bewegen

// Verschiebt Tabs in ihrer Reihenfolge ans Ende von windowId. Gruppen werden als
// Ganzes verschoben, damit Titel/Farbe erhalten bleiben. Gibt die Tab-IDs zurück.
async function moveOrdered(tabs, windowId) {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const ids = [];
  const doneGroups = new Set();
  let seg = [];
  const flush = async () => {
    if (seg.length) {
      await chrome.tabs.move(seg, { windowId, index: -1 });
      seg = [];
    }
  };
  for (const t of sorted) {
    ids.push(t.id);
    if (typeof t.groupId === 'number' && t.groupId >= 0) {
      if (doneGroups.has(t.groupId)) continue;
      await flush();
      doneGroups.add(t.groupId);
      await chrome.tabGroups.move(t.groupId, { windowId, index: -1 });
    } else {
      seg.push(t.id);
    }
  }
  await flush();
  return ids;
}

// Während ein Tab gezogen wird, lehnt der Browser Änderungen an Tabs vorübergehend ab
// („Tabs cannot be edited right now (user may be dragging a tab).“). Solche Aufrufe
// werden nach kurzer Pause wiederholt, insgesamt etwa drei Sekunden lang.
const BUSY = /cannot be edited right now/i;
async function whenIdle(fn, tries = 15) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !BUSY.test(err?.message || '')) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// So meldet der Browser ein Fenster, das es nicht mehr gibt
const GONE = /no window with id/i;

// Hebt die Gruppen im Fenster w auf, bevor die Erweiterung es schließt und seine Tabs später
// aus der Sicherung neu anlegt. Chromium behält die Gruppe eines geschlossenen Fensters als
// gespeicherte Gruppe (Menü → Tabgruppen), eine aufgehobene löscht es. Sonst stünde jede
// Gruppe nach dem Neuanlegen ein weiteres Mal in der Liste (#218). Gibt eine Funktion
// zurück, die die Gruppen wieder anlegt, falls sich das Fenster nicht schließen lässt.
// before bekommt die Gruppen ({ title, color, collapsed, tabIds }) vor dem Aufheben, damit
// sie sich auch nach einem Ende des Service Workers mit regroup wieder anlegen lassen.
async function ungroupAll(w, before = async () => {}) {
  const tabs = w.tabs.filter((t) => t.groupId >= 0);
  const none = async () => {};
  if (!tabs.length) return none;
  try {
    const groups = (await chrome.tabGroups.query({ windowId: w.id })).map((g) => ({
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      tabIds: tabs.filter((t) => t.groupId === g.id).map((t) => t.id),
    }));
    await before(groups);
    await whenIdle(() => chrome.tabs.ungroup(tabs.map((t) => t.id)));
    return () => regroup(w.id, groups);
  } catch (err) {
    console.warn('[workspaces] Gruppen vor dem Schließen', err);
    return none;
  }
}

// Legt die Gruppen aus ungroupAll im Fenster windowId wieder an
async function regroup(windowId, groups) {
  for (const g of groups) {
    if (!g.tabIds.length) continue;
    try {
      const gid = await whenIdle(() => chrome.tabs.group({ tabIds: g.tabIds, createProperties: { windowId } }));
      await whenIdle(() => chrome.tabGroups.update(gid, { title: g.title, color: g.color, collapsed: g.collapsed }));
    } catch (err) {
      console.warn('[workspaces] Gruppe wieder anlegen', g.title, err);
    }
  }
}

const groupProps = (e) => ({ title: e.gt || '', color: e.gc || 'grey', collapsed: !!e.gx });

// Legt einen Tab im Hintergrund an, solange der Browser wegen Ziehens ablehnt erneut
const openTab = (props) => whenIdle(() => chrome.tabs.create({ active: false, ...props }));

// ---------------------------------------------------------------- Hilfen

// Einträge aus list, deren URL in have nicht (oft genug) vorkommt
function missingIn(list, have) {
  const n = new Map();
  for (const e of have) n.set(e.url, (n.get(e.url) || 0) + 1);
  return list.filter((e) => {
    const k = n.get(e.url) || 0;
    n.set(e.url, k - 1);
    return k <= 0;
  });
}
