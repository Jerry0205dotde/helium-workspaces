// Hintergrundlogik: Symbol, Titel und Plakette des Workspace-Knopfs

const iconCache = new Map();

function drawIcon(ws, size) {
  const c = new OffscreenCanvas(size, size);
  const x = c.getContext('2d');
  const r = size * 0.24;
  x.fillStyle = ws.color || COLORS[0];
  x.beginPath();
  x.roundRect(0, 0, size, size, r);
  x.fill();
  const label = wsLabel(ws);
  x.fillStyle = '#ffffff';
  x.font = `600 ${Math.round(size * (ws.emoji ? 0.7 : 0.64))}px system-ui, sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(label, size / 2, size / 2 + size * 0.05);
  return x.getImageData(0, 0, size, size);
}

function iconFor(ws) {
  const key = `${ws.id}|${ws.color}|${ws.emoji}|${ws.name}`;
  if (!iconCache.has(key)) iconCache.set(key, { 16: drawIcon(ws, 16), 32: drawIcon(ws, 32) });
  return iconCache.get(key);
}

// Workspaces und gescheiterte Tabs, aus denen die Symbole entstehen. Bei Aktualisierungen
// mehrerer Tabs einmal geladen und an setTabIcon übergeben.
async function iconSource() {
  const { workspaces, lastWs } = await getConfig();
  return { workspaces, lastWs, failed: await failedCounts() };
}

// Was zuletzt je Tab gesetzt wurde (Schlüssel aus Workspace, Farbe, Name, Emoji, Titel und
// Plakette), damit ein Wechsel nur Tabs neu setzt, die etwas anderes tragen. Chromium behält
// die Werte, wenn ein Tab das Fenster wechselt, und setzt sie nur beim Laden einer Seite
// zurück; dann verwirft forgetTabIcon den Eintrag. Nach einem Neustart des Service Workers
// ist die Map leer, und alles wird neu gesetzt.
const tabIconSet = new Map();

function forgetTabIcon(tabId) {
  tabIconSet.delete(tabId);
}

// Ohne tabId gilt die Einstellung für alle Tabs ohne eigene (siehe setGlobalIcon)
async function setTabIcon(tabId, wsId, src) {
  src ??= await iconSource();
  const ws = src.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  // Unvollständig wiederhergestellt: Zahl der fehlenden Tabs als Plakette
  const missing = src.failed.get(wsId) || 0;
  let title = missing ? tr('iconTitleMissing', ws.name, plural(missing, 'tabsNotRestored')) : tr('iconTitle', ws.name);
  // Speicher fast voll (sessionUsage): „!“, wenn keine Zahl fehlender Tabs dasteht
  if (sessionFull) title += '\n' + tr('iconTitleStorageFull');
  const badge = missing ? String(missing) : sessionFull ? '!' : '';
  const key = JSON.stringify([ws.id, ws.color, ws.emoji, ws.name, title, badge]);
  if (tabIconSet.get(tabId) === key) return;
  // Vor den Aufrufen eingetragen: Bei zwei Aufrufen kurz hintereinander gilt im Browser wie
  // hier der spätere
  tabIconSet.set(tabId, key);
  const tab = tabId === undefined ? {} : { tabId };
  // Mit Promise lehnt setIcon nicht ab, wenn der Tab inzwischen geschlossen ist, sondern
  // meldet „Unchecked runtime.lastError: No tab with id“ unter chrome://extensions. Mit
  // Callback, der lastError liest, bleibt der Fehler still.
  const ok = await Promise.all([
    new Promise((done) =>
      chrome.action.setIcon({ ...tab, imageData: iconFor(ws) }, () => done(!chrome.runtime.lastError)),
    ),
    chrome.action.setTitle({ ...tab, title }).then(() => true, () => false),
    chrome.action.setBadgeText({ ...tab, text: badge }).then(() => true, () => false),
    !badge || chrome.action.setBadgeBackgroundColor({ ...tab, color: '#dc2626' }).then(() => true, () => false),
  ]);
  // Nicht gesetzt: beim nächsten Mal erneut versuchen
  if (ok.includes(false) && tabIconSet.get(tabId) === key) tabIconSet.delete(tabId);
}

// Chromium setzt Symbol, Titel und Plakette eines Tabs zurück, sobald er eine Seite
// übernimmt; die Erweiterung setzt sie erst nach dem Laden neu. Bis dahin gilt die
// Einstellung ohne tabId: der Workspace des zuletzt fokussierten Fensters (lastWs).
// Diese Einstellung teilen sich die normale und die Inkognito-Instanz, deshalb setzt sie nur
// die normale.
async function setGlobalIcon(src) {
  if (INCOGNITO) return;
  src ??= await iconSource();
  await setTabIcon(undefined, src.lastWs, src);
}

async function updateIcons(windowId, src) {
  src ??= await iconSource();
  await Promise.all([updateWindowIcons(windowId, src), setGlobalIcon(src)]);
}

async function updateWindowIcons(windowId, src) {
  const s = await sess();
  const wsId = s.windowWs[windowId];
  if (!wsId) return;
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(tabs.map((t) => setTabIcon(t.id, wsId, src)));
}

async function updateAllIcons() {
  const s = await sess();
  const src = await iconSource();
  await Promise.all([...Object.keys(s.windowWs).map((id) => updateWindowIcons(Number(id), src)), setGlobalIcon(src)]);
}
