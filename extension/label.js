// Das ganze erste Zeichen eines Textes. Intl.Segmenter liefert es vollständig. s[0] wäre
// bei einem Emoji nur dessen erste Hälfte, und zusammengesetzte Emoji würden zerteilt:
// Eine Familie aus vier Personen besteht aus elf UTF-16-Einheiten, eine Flagge wie die
// von Schottland aus vierzehn. Das Emoji eines Workspace ist immer sein erstes Zeichen,
// bei der Eingabe im Popup wie beim Import.
function firstChar(s) {
  const [first] = new Intl.Segmenter().segment(s.trim());
  return first?.segment || '';
}

// Zeichen im Symbol eines Workspace: sein Emoji, sonst der Anfang des Namens.
function wsLabel(ws) {
  return ws.emoji || (firstChar(ws.name) || '?').toUpperCase();
}
