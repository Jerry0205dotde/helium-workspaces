// Hintergrundlogik: Kontextmenü „Tab in Workspace verschieben“

// Auf Links, Bildern, Videos und markiertem Text ebenso wie auf einer freien Stelle der
// Seite und am Symbol der Erweiterung; verschoben wird immer der Tab, nicht der Link
const CONTEXTS = ['page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'action'];

async function buildMenus() {
  const cfg = await getConfig();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'move',
    title: 'Tab in Workspace verschieben',
    contexts: CONTEXTS,
  });
  for (const ws of cfg.workspaces) {
    chrome.contextMenus.create({
      id: `move:${ws.id}`,
      parentId: 'move',
      title: `${ws.emoji ? ws.emoji + ' ' : ''}${ws.name}`,
      contexts: CONTEXTS,
    });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !String(info.menuItemId).startsWith('move:')) return;
  const wsId = String(info.menuItemId).slice(5);
  userAction(() => moveTabToWs(tab.id, wsId));
});
