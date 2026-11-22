// Titel "HWS-Ablage <Schlüssel> · <Name>". Das KWin-Skript versteckt nur Fenster mit
// diesem geräteeigenen Schlüssel (von background.js erzeugt), damit Webseiten sich
// nicht per document.title als Ablage ausgeben können. Mit ?shown fehlt der Schlüssel,
// die Ablage bleibt sichtbar (Sicherung beim Schließen fehlgeschlagen, reconcile.js).
// Übernimmt ein Import mit Ersetzen die Ablage, zeigt ihr Anker danach auf den neuen
// Workspace, ohne dass die Seite neu lädt (#248).
let wsId = location.hash.slice(1);
const shown = new URLSearchParams(location.search).has('shown');
localize();

async function setTitle() {
  const { workspaces, token } = await chrome.storage.local.get(['workspaces', 'token']);
  const ws = (workspaces || []).find((w) => w.id === wsId);
  document.title = `HWS-Ablage ${shown ? '' : `${token || ''} `}· ${ws ? ws.name : wsId}`;
}

setTitle();
window.addEventListener('hashchange', () => {
  wsId = location.hash.slice(1);
  setTitle();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.workspaces || changes.token) setTitle();
});
