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

// Workspaces und Sicherung, aus denen die Symbole entstehen. Bei Aktualisierungen
// mehrerer Tabs einmal geladen und an setTabIcon übergeben.
async function iconSource() {
  const { workspaces } = await getConfig();
  const { backup } = await getBackup();
  return { workspaces, backup };
}

async function setTabIcon(tabId, wsId, src) {
  src ??= await iconSource();
  const ws = src.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  // Unvollständig wiederhergestellt: Zahl der fehlenden Tabs als Plakette
  const missing = src.backup[wsId]?.failed?.length || 0;
  let title = missing ? tr('iconTitleMissing', ws.name, plural(missing, 'tabsNotRestored')) : tr('iconTitle', ws.name);
  // Speicher fast voll (sessionUsage): „!“, wenn keine Zahl fehlender Tabs dasteht
  if (sessionFull) title += '\n' + tr('iconTitleStorageFull');
  const badge = missing ? String(missing) : sessionFull ? '!' : '';
  await chrome.action.setIcon({ tabId, imageData: iconFor(ws) }).catch(() => {});
  await chrome.action.setTitle({ tabId, title }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: badge }).catch(() => {});
  if (badge) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => {});
}

async function updateIcons(windowId, src) {
  const s = await sess();
  const wsId = s.windowWs[windowId];
  if (!wsId) return;
  const tabs = await chrome.tabs.query({ windowId });
  src ??= await iconSource();
  await Promise.all(tabs.map((t) => setTabIcon(t.id, wsId, src)));
}

async function updateAllIcons() {
  const s = await sess();
  const src = await iconSource();
  await Promise.all(Object.keys(s.windowWs).map((id) => updateIcons(Number(id), src)));
}
