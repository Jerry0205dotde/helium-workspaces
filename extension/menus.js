// Hintergrundlogik: Kontextmenü „Tab in Workspace verschieben“

async function buildMenus() {
  const cfg = await getConfig();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'move',
    title: 'Tab in Workspace verschieben',
    contexts: ['page', 'action'],
  });
  for (const ws of cfg.workspaces) {
    chrome.contextMenus.create({
      id: `move:${ws.id}`,
      parentId: 'move',
      title: `${ws.emoji ? ws.emoji + ' ' : ''}${ws.name}`,
      contexts: ['page', 'action'],
    });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !String(info.menuItemId).startsWith('move:')) return;
  const wsId = String(info.menuItemId).slice(5);
  userAction(() => moveTabToWs(tab.id, wsId));
});
