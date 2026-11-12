// Das ganze erste Zeichen eines Textes. Intl.Segmenter liefert es vollständig. s[0] wäre
// bei einem Emoji nur dessen erste Hälfte, und zusammengesetzte Emoji würden zerteilt:
// Eine Familie aus vier Personen besteht aus elf UTF-16-Einheiten, eine Flagge wie die
// von Schottland aus vierzehn. Das Emoji eines Workspace ist immer sein erstes Zeichen,
// bei der Eingabe im Popup wie beim Import.
function firstChar(s) {
  const [first] = new Intl.Segmenter().segment(s.trim());
  return first?.segment || '';
}

// Höchstlänge eines Workspace-Namens in UTF-16-Einheiten. So viel nimmt das Namensfeld
// im Popup an, und länger wird kein gespeicherter, exportierter oder importierter Name.
const NAME_MAX = 200;

// Ein Workspace-Name, wie er gespeichert wird: ohne Leerraum außen, höchstens NAME_MAX
// Einheiten lang, ohne dabei ein Zeichen zu zerteilen, und nie leer. Dieselbe Regel gilt
// beim Speichern aus dem Popup, beim Export und beim Import, damit jeder eigene Export
// wieder importierbar ist.
function wsName(s) {
  let name = '';
  for (const { segment } of new Intl.Segmenter().segment(s.trim())) {
    if (name.length + segment.length > NAME_MAX) break;
    name += segment;
  }
  return name.trim() || 'Workspace';
}

// Zeichen im Symbol eines Workspace: sein Emoji, sonst der Anfang des Namens.
function wsLabel(ws) {
  return ws.emoji || (firstChar(ws.name) || '?').toUpperCase();
}
