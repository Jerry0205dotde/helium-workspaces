// Titel "HWS-Ablage · <Name>" – das KWin-Skript erkennt das Fenster an "HWS-Ablage".
const wsId = location.hash.slice(1);

async function setTitle() {
  const { workspaces } = await chrome.storage.local.get('workspaces');
  const ws = (workspaces || []).find((w) => w.id === wsId);
  document.title = `HWS-Ablage · ${ws ? ws.name : wsId}`;
}

setTitle();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.workspaces) setTitle();
});
