// Titel "HWS-Ablage <Schlüssel> · <Name>". Das KWin-Skript versteckt nur Fenster mit
// diesem geräteeigenen Schlüssel (von background.js erzeugt), damit Webseiten sich
// nicht per document.title als Ablage ausgeben können.
const wsId = location.hash.slice(1);
localize();

async function setTitle() {
  const { workspaces, token } = await chrome.storage.local.get(['workspaces', 'token']);
  const ws = (workspaces || []).find((w) => w.id === wsId);
  document.title = `HWS-Ablage ${token || ''} · ${ws ? ws.name : wsId}`;
}

setTitle();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.workspaces || changes.token) setTitle();
});
