// Titel "HWS-Ablage <Schlüssel> · <Name>". Das KWin-Skript versteckt nur Fenster mit
// diesem geräteeigenen Schlüssel (token.js, von install.sh erzeugt), damit Webseiten
// sich nicht per document.title als Ablage ausgeben können.
const wsId = location.hash.slice(1);
const token = self.HWS_TOKEN || '';

async function setTitle() {
  const { workspaces } = await chrome.storage.local.get('workspaces');
  const ws = (workspaces || []).find((w) => w.id === wsId);
  document.title = `HWS-Ablage ${token} · ${ws ? ws.name : wsId}`;
}

setTitle();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.workspaces) setTitle();
});
