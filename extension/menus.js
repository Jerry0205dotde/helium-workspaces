// Hintergrundlogik: Kontextmenü „Tab in Workspace verschieben“ und, wenn der Tab in einer
// Gruppe ist, „Gruppe in Workspace verschieben“

const MENUS = { move: tr('menuMove'), group: tr('menuGroup') };

// Auf Links, Bildern, Videos und markiertem Text ebenso wie auf einer freien Stelle der
// Seite und am Symbol der Erweiterung; verschoben wird immer der Tab, nicht der Link
const CONTEXTS = ['page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'action'];

async function buildMenus() {
  const cfg = await getConfig();
  await chrome.contextMenus.removeAll();
  for (const [kind, title] of Object.entries(MENUS)) {
    chrome.contextMenus.create({ id: kind, title, contexts: CONTEXTS, visible: kind === 'move' });
    for (const ws of cfg.workspaces) {
      chrome.contextMenus.create({
        id: `${kind}:${ws.id}`,
        parentId: kind,
        title: `${ws.emoji ? ws.emoji + ' ' : ''}${ws.name}`,
        contexts: CONTEXTS,
      });
    }
  }
  await updateMenus();
}

// Passt die Menüs an den aktiven Tab an: Anzahl der markierten Tabs, Gruppe ja oder nein
async function updateMenus() {
  try {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true, highlighted: true });
    const active = tabs.find((t) => t.active);
    const n = active ? tabs.length : 1;
    await chrome.contextMenus.update('move', { title: n > 1 ? tr('menuMoveMarked', n) : MENUS.move });
    await chrome.contextMenus.update('group', { visible: !!active && active.groupId >= 0 });
  } catch {
    // Das Menü wird gerade neu gebaut, buildMenus ruft das danach selbst auf
  }
}

chrome.tabs.onHighlighted.addListener(() => updateMenus());
chrome.windows.onFocusChanged.addListener(() => updateMenus());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.groupId !== undefined) updateMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  const kind = id.slice(0, id.indexOf(':'));
  const wsId = id.slice(kind.length + 1);
  if (!tab || !wsId || !Object.hasOwn(MENUS, kind)) return;
  userAction(() => moveTabToWs(tab.id, wsId, kind === 'group'));
});
