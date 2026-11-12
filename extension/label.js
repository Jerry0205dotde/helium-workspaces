// Zeichen im Symbol eines Workspace: sein Emoji, sonst der Anfang des Namens.
// Intl.Segmenter liefert das ganze erste Zeichen. name[0] wäre bei einem Emoji nur
// dessen erste Hälfte, und zusammengesetzte Emoji wie Flaggen würden zerteilt.
function wsLabel(ws) {
  const [first] = new Intl.Segmenter().segment(ws.name.trim());
  return ws.emoji || (first?.segment || '?').toUpperCase();
}
