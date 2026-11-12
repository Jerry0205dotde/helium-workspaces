'use strict';
// Export und Import: Rundlauf in ein leeres Profil, abgelehnte Dateien, Zusammenführen
// und Ersetzen

const test = require('node:test');
const assert = require('node:assert/strict');
const { Browser } = require('./fake-browser');
const { setup, check, ok, url, where, shows, tabIds, NEWTAB } = require('./harness');

const SPEC = {
  pinned: ['p1', 'p2'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    // b0 ist beim Wechsel aktiv; die eingeklappte Gruppe bleibt so eingeklappt
    B: ['b0', { url: 'b1', group: 'Lesen', color: 'red', collapsed: true }, { url: 'b2', group: 'Lesen', color: 'red', collapsed: true }, 'b3'],
    C: ['c1', 'c2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };
const OLD_URLS = Object.values(SPEC.workspaces).flat().map((i) => url(i.url || i));

// Antworten stammen aus dem Kontext des Service Workers. Erst als JSON kopiert lassen
// sie sich mit deepEqual vergleichen, und so kommen sie auch beim Popup an.
const plain = (v) => JSON.parse(JSON.stringify(v));
const request = async (env, msg) => plain(await ok(env.w.request(msg)));
const importFile = (env, file, mode, confirmed) => request(env, { type: 'import', text: JSON.stringify(file), mode, confirmed });
// Zwei Exporte unterscheiden sich immer im Zeitpunkt
const content = ({ exported, ...rest }) => rest;

// Ein Tab der Export-Datei; die nachgebildeten Tabs tragen ihre Adresse als Titel
const tab = (name, group) => ({ url: url(name), title: url(name), ...(group ? { group } : {}) });
const fileOf = (workspaces, pinned = []) => ({ format: 'helium-workspaces', version: 1, pinned, workspaces });

// Umgebung zu einem Browser, deren Workspace-IDs immer dem aktuellen Stand entsprechen
const envOf = (b) => ({
  b,
  get win() { return b.mains()[0].id; },
  get ids() { return Object.fromEntries(b.local.data.workspaces.map((w) => [w.name, w.id])); },
  get w() { return b.worker; },
});

// Frisches Profil: ein Fenster mit neuer Tab-Seite und der Workspace „Standard“
async function fresh() {
  const b = new Browser();
  b.createWindow({ url: NEWTAB });
  await b.startWorker('installed').settle();
  return envOf(b);
}

// Ausgangsprofil für den Export: C steht vorn, B hat eigene Farbe und Emoji
async function source() {
  const env = await setup(SPEC);
  const { ids } = env;
  await ok(env.w.request({ type: 'update', wsId: ids.B, patch: { color: '#123abc', emoji: '📚' } }));
  await ok(env.w.request({ type: 'reorder', ids: [ids.C, ids.A, ids.B] }));
  return env;
}

const exportedFrom = (ids) => ({
  format: 'helium-workspaces',
  version: 1,
  pinned: [tab('p1'), tab('p2')],
  workspaces: [
    { id: ids.C, name: 'C', color: '#22c55e', emoji: '', groups: [], tabs: [tab('c1'), tab('c2')] },
    {
      id: ids.A,
      name: 'A',
      color: '#3b82f6',
      emoji: '',
      groups: [{ id: '1', title: 'Mathe', color: 'blue', collapsed: false }],
      tabs: [tab('a1'), tab('a2', '1'), tab('a3', '1'), tab('a4')],
    },
    {
      id: ids.B,
      name: 'B',
      color: '#123abc',
      emoji: '📚',
      groups: [{ id: '1', title: 'Lesen', color: 'red', collapsed: true }],
      tabs: [tab('b0'), tab('b1', '1'), tab('b2', '1'), tab('b3')],
    },
  ],
});

// Alles, was ein abgelehnter Import nicht anfassen darf
const stateOf = (b) => JSON.stringify({ windows: b.windows, groups: [...b.groups], local: b.local.data, session: b.session.data });

async function rejected(env, msg, error) {
  const before = stateOf(env.b);
  const calls = env.b.calls.length;
  const r = await env.w.request(msg);
  assert.ok(r, 'keine Antwort vom Service Worker');
  assert.equal(r.ok, false, `${msg.type} wurde angenommen`);
  assert.match(r.error, error);
  assert.equal(stateOf(env.b), before, `${msg.type} hat trotz Ablehnung etwas geändert`);
  const writes = env.b.calls.slice(calls).filter((c) => !/\.(get|getAll|getLastFocused|query)$/.test(c.name));
  assert.deepEqual(writes.map((c) => c.name), [], `${msg.type} hat trotz Ablehnung geschrieben`);
}

// Wechselt das Hauptfenster durch die Workspaces und prüft Bestand und Tab-Reihenfolge
async function cycle(env, names, expected) {
  for (const name of names) {
    await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: env.ids[name] }));
    assert.equal(shows(env, env.win), name);
    check(env, expected);
    const urls = env.b.mains()[0].tabs.map((t) => t.url).filter((u) => u !== NEWTAB);
    assert.deepEqual(urls, [...expected.pinned, ...expected[name].map((i) => i.url || i)].map(url), `Reihenfolge der Tabs von ${name}`);
  }
}

// ---------------------------------------------------------------- Rundlauf

test('Export enthält Workspaces in ihrer Reihenfolge mit Tabs, Gruppen und angehefteten Tabs', async () => {
  const env = await source();
  // Eine Seite der Erweiterung, die als gewöhnlicher Tab in A offen ist
  await env.b.chrome.tabs.create({ windowId: env.win, url: `${env.b.origin}popup.html`, active: false });
  await env.w.settle();
  const before = stateOf(env.b);
  const file = await request(env, { type: 'export' });
  assert.ok(!Number.isNaN(Date.parse(file.exported)), 'Zeitpunkt des Exports fehlt');
  // Seiten der Erweiterung, auch die Ablage-Seiten von B und C, und alle Fenster-, Tab-
  // und Gruppen-IDs fehlen
  assert.deepEqual(content(file), exportedFrom(env.ids));
  assert.equal(stateOf(env.b), before, 'der Export hat etwas geändert');
});

test('Rundlauf: Export ersetzt ein leeres Profil, alles kommt gleich an', async () => {
  const src = await source();
  const file = await request(src, { type: 'export' });
  const dst = await fresh();

  const res = await importFile(dst, file, 'replace', true);
  assert.deepEqual(res, { created: 3, merged: 0, added: 8 + 2, skipped: 0, failed: 0, removed: 1, closed: 1, pinned: 2, pinnedSkipped: 0 });
  // Namen, Farben, Emojis, Reihenfolge und sogar die IDs sind die der Datei
  assert.deepEqual(dst.b.local.data.workspaces, file.workspaces.map(({ id, name, color, emoji }) => ({ id, name, color, emoji })));
  assert.equal(shows(dst, dst.win), 'C');
  check(dst, ALL);
  assert.deepEqual(content(await request(dst, { type: 'export' })), content(file), 'erneuter Export weicht ab');

  // Die Tabs entstehen beim Wechseln aus der Sicherung, in ihrer Reihenfolge und ihren Gruppen
  await cycle(dst, ['A', 'B', 'C'], ALL);
  assert.deepEqual(content(await request(dst, { type: 'export' })), content(file), 'Export der geöffneten Workspaces weicht ab');
});

test('Rundlauf: Export in ein leeres Profil zusammenführen lässt „Standard“ stehen', async () => {
  const src = await source();
  const file = await request(src, { type: 'export' });
  const dst = await fresh();

  const res = await importFile(dst, file, 'merge');
  assert.deepEqual(res, { created: 3, merged: 0, added: 8 + 2, skipped: 0, failed: 0, removed: 0, closed: 0, pinned: 2, pinnedSkipped: 0 });
  assert.deepEqual(dst.b.local.data.workspaces.map((w) => w.name), ['Standard', 'C', 'A', 'B']);
  assert.equal(shows(dst, dst.win), 'Standard');
  check(dst, { ...ALL, Standard: [] });
  const again = await request(dst, { type: 'export' });
  assert.deepEqual(again.workspaces.slice(1), file.workspaces);
  assert.deepEqual(again.pinned, file.pinned);
  await cycle(dst, ['C', 'A', 'B'], { ...ALL, Standard: [] });
});

test('Import übernimmt vom Emoji das ganze erste Zeichen, wie die Eingabe im Popup', async () => {
  const env = await fresh();
  // Familie aus vier Personen (11 UTF-16-Einheiten), Flagge von Schottland mit Tag-Folge
  // (14), Familie mit Hauttönen (19); dazu Text nach dem Emoji und nur Leerzeichen
  const emojis = ['👨‍👩‍👧‍👦', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👨🏻‍👩🏻‍👧🏻‍👦🏻', ' 🎓 Uni', '   '];
  const file = fileOf(emojis.map((emoji, i) => ({ name: `W${i}`, color: '#abcdef', emoji, tabs: [tab(`w${i}`)] })));
  const preview = await request(env, { type: 'importPreview', text: JSON.stringify(file) });
  const stored = ['👨‍👩‍👧‍👦', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👨🏻‍👩🏻‍👧🏻‍👦🏻', '🎓', ''];
  assert.deepEqual(preview.workspaces.map((w) => w.emoji), stored);
  await importFile(env, file, 'merge');
  assert.deepEqual(env.b.local.data.workspaces.slice(1).map((w) => w.emoji), stored);
  // Dieselbe Regel, mit der das Popup die Eingabe speichert
  assert.deepEqual(emojis.map((e) => env.w.eval(`firstChar(${JSON.stringify(e)})`)), stored);
});

// ---------------------------------------------------------------- Abgelehnte Dateien

test('Abgelehnte Dateien ändern nichts, weder in der Vorschau noch beim Import', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  const valid = () =>
    fileOf(
      [
        { id: 'neu1', name: 'Neu', color: '#abcdef', groups: [{ id: 'g', title: 'G', color: 'pink' }], tabs: [tab('n1'), tab('n2', 'g')] },
        { id: 'neu2', name: 'Mehr', color: '#abcdef', tabs: [tab('m1')] },
      ],
      [tab('p9')],
    );
  const broken = (change) => {
    const f = valid();
    change(f);
    return JSON.stringify(f);
  };
  const cases = [
    ['kein JSON', '{ "format": "helium-workspaces", ', /kein gültiges JSON/],
    ['falsches Format', broken((f) => (f.format = 'andere-erweiterung')), /keine Export-Datei von Helium Workspaces/],
    ['kein Objekt', JSON.stringify([valid()]), /keine Export-Datei von Helium Workspaces/],
    ['zu neue Version', broken((f) => (f.version = 2)), /Format-Version 2, diese Erweiterung kennt nur Version 1/],
    ['javascript:-Adresse', broken((f) => (f.workspaces[1].tabs[0].url = 'javascript:alert(1)')), /Workspace 2 \(„Mehr“\), Tab 1: javascript:-Adressen/],
    ['angeheftete javascript:-Adresse', broken((f) => (f.pinned[0].url = 'JavaScript:alert(1)')), /Angehefteter Tab 1: javascript:-Adressen/],
    ['Seite der Erweiterung', broken((f) => (f.workspaces[0].tabs[0].url = `${b.origin}stash.html#neu1`)), /Tab 1: Seiten der Erweiterung/],
    ['Seite der Erweiterung in anderer Schreibweise', broken((f) => (f.pinned[0].url = `${b.origin.toUpperCase()}x/../popup.html`)), /Seiten der Erweiterung/],
    ['unbekannte Gruppe', broken((f) => (f.workspaces[0].tabs[1].group = 'fehlt')), /Tab 2: Gruppe „fehlt“ ist nicht unter „groups“ aufgeführt/],
    ['doppelte Workspace-ID', broken((f) => (f.workspaces[1].id = 'neu1')), /Workspace 2 \(„Mehr“\): Die ID „neu1“ kommt mehrfach vor/],
  ];
  for (const [name, text, error] of cases) {
    await test(name, async () => {
      await rejected(env, { type: 'importPreview', text }, error);
      await rejected(env, { type: 'import', text, mode: 'merge' }, error);
      await rejected(env, { type: 'import', text, mode: 'replace', confirmed: true }, error);
    });
  }
  check(env, ALL);

  // Gegenprobe: Ohne die eingebauten Fehler wird dieselbe Datei angenommen
  const res = await importFile(env, valid(), 'merge');
  assert.equal(res.created, 2);
  check(envOf(b), { ...ALL, Neu: ['n1', { url: 'n2', group: 'G', color: 'pink' }], Mehr: ['m1'], pinned: [...SPEC.pinned, 'p9'] });
});

// ---------------------------------------------------------------- Zusammenführen

test('Zusammenführen: Treffer über ID und Name, vorhandene Adressen übersprungen, neue Tabs in der offenen Gruppe', async () => {
  const env = await setup(SPEC);
  const { b, ids } = env;
  const file = fileOf(
    [
      // Die ID entscheidet, auch wenn der Workspace in der Datei wie ein anderer heißt
      {
        id: ids.A,
        name: 'B',
        color: '#000000',
        groups: [{ id: 'm', title: 'Mathe', color: 'blue' }],
        tabs: [tab('a1'), tab('a2', 'm'), tab('a9', 'm')],
      },
      // Ohne ID zählt der Name; B liegt gerade in seiner Ablage
      {
        name: 'B',
        color: '#000000',
        groups: [
          { id: 'l', title: 'Lesen', color: 'red', collapsed: true },
          { id: 'n', title: 'Neu', color: 'green' },
        ],
        tabs: [tab('b1', 'l'), tab('b9', 'l'), tab('b8', 'n'), tab('b7', 'n'), tab('b3')],
      },
      { name: 'Neu', color: '#abcdef', emoji: '🆕', groups: [{ id: 'g', title: 'G', color: 'pink' }], tabs: [tab('n1'), tab('n2', 'g')] },
    ],
    [tab('p1'), tab('p9')],
  );
  const text = JSON.stringify(file);

  const before = stateOf(b);
  const preview = await request(env, { type: 'importPreview', text });
  assert.equal(stateOf(b), before, 'die Vorschau hat etwas geändert');
  assert.deepEqual(
    preview.workspaces.map((w) => [w.name, w.target, w.tabs, w.add]),
    [
      ['B', { name: 'A', by: 'id' }, 3, 1],
      ['B', { name: 'B', by: 'name' }, 5, 3],
      ['Neu', null, 2, 2],
    ],
  );
  assert.deepEqual([preview.pinned, preview.pinnedAdd], [2, 1]);
  assert.deepEqual(preview.current, [
    { name: 'A', open: 4, failed: 0 },
    { name: 'B', open: 4, failed: 0 },
    { name: 'C', open: 2, failed: 0 },
  ]);

  const open = tabIds(env);
  const res = await importFile(env, file, 'merge');
  assert.deepEqual(res, { created: 1, merged: 2, added: 1 + 3 + 2, skipped: 2 + 2, failed: 0, removed: 0, closed: 0, pinned: 1, pinnedSkipped: 1 });

  // Vorhandene Workspaces behalten Namen, Farbe und ihre Tabs; nichts wurde geschlossen
  const now = envOf(b);
  assert.deepEqual(b.local.data.workspaces.map((w) => [w.name, w.color, w.emoji]), [
    ['A', '#3b82f6', ''],
    ['B', '#ef4444', ''],
    ['C', '#22c55e', ''],
    ['Neu', '#abcdef', '🆕'],
  ]);
  assert.deepEqual(Object.fromEntries(Object.keys(open).map((u) => [u, tabIds(env)[u]])), open, 'vorhandene Tabs wurden neu angelegt');
  check(now, {
    A: [...SPEC.workspaces.A, { url: 'a9', group: 'Mathe', color: 'blue' }],
    B: [
      ...SPEC.workspaces.B,
      { url: 'b9', group: 'Lesen', color: 'red', collapsed: true },
      { url: 'b8', group: 'Neu', color: 'green' },
      { url: 'b7', group: 'Neu', color: 'green' },
    ],
    C: SPEC.workspaces.C,
    Neu: ['n1', { url: 'n2', group: 'G', color: 'pink' }],
    pinned: ['p1', 'p2', 'p9'],
  });
  // a9 liegt in derselben Gruppe wie a2, es gibt keine zweite Gruppe „Mathe“
  assert.equal(where(env, 'a9').tab.groupId, where(env, 'a2').tab.groupId);
  assert.equal(where(env, 'b9').tab.groupId, where(env, 'b1').tab.groupId);
  assert.deepEqual([...b.groups.values()].map((g) => g.title).sort(), ['Lesen', 'Mathe', 'Neu']);

  // Derselbe Import noch einmal findet alles vor, auch den neuen Workspace über seinen Namen
  const second = await importFile(env, file, 'merge');
  assert.deepEqual(second, { created: 0, merged: 0, added: 0, skipped: 10, failed: 0, removed: 0, closed: 0, pinned: 0, pinnedSkipped: 2 });
  assert.equal(b.local.data.workspaces.length, 4);
});

test('Zusammenführen in einen Workspace ohne Fenster ergänzt seine Sicherung samt Gruppe', async () => {
  const env = await setup(SPEC);
  const { b, ids } = env;
  // Start ohne Sitzungswiederherstellung: B und C stehen nur noch in der Sicherung
  b.restart({ restore: 'none', keepPinned: true });
  await b.startWorker('startup').settle();
  assert.equal(b.windows.length, 1);
  check(env, ALL);

  const file = fileOf([
    {
      id: ids.B,
      name: 'B',
      color: '#000000',
      groups: [
        // b1 liegt hier in „Lesen“: Eine Gruppe mit anderem Namen übernimmt deren Platz nicht
        { id: 'a', title: 'Andere', color: 'red' },
        { id: 'l', title: 'Lesen', color: 'red', collapsed: true },
        { id: 'n', title: 'Neu', color: 'green' },
      ],
      tabs: [tab('b1', 'a'), tab('b7', 'a'), tab('b2', 'l'), tab('b9', 'l'), tab('b8', 'n'), tab('b0')],
    },
  ]);
  const res = await importFile(env, file, 'merge');
  assert.deepEqual(res, { created: 0, merged: 1, added: 3, skipped: 3, failed: 0, removed: 0, closed: 0, pinned: 0, pinnedSkipped: 0 });
  assert.equal(b.windows.length, 1, 'für den Import wurde ein Fenster geöffnet');

  // check() prüft auch, dass b9 in der Sicherung denselben Gruppenschlüssel trägt wie b1 und b2
  const expected = {
    ...ALL,
    B: [
      ...SPEC.workspaces.B,
      { url: 'b7', group: 'Andere', color: 'red' },
      { url: 'b9', group: 'Lesen', color: 'red', collapsed: true },
      { url: 'b8', group: 'Neu', color: 'green' },
    ],
  };
  check(env, expected);
  await ok(env.w.request({ type: 'switch', windowId: b.mains()[0].id, wsId: ids.B }));
  check(env, expected);
  assert.equal(where(env, 'b9').tab.groupId, where(env, 'b1').tab.groupId);
});

test('Zwei Importe mit derselben Gruppen-ID in der Datei ergeben getrennte Gruppen', async () => {
  const env = await fresh();
  const neu = (group, names) => fileOf([{ name: 'Neu', color: '#abcdef', groups: [{ id: 'g', ...group }], tabs: names.map((n) => tab(n, 'g')) }]);
  await importFile(env, neu({ title: 'G', color: 'pink' }, ['n1', 'n2']), 'merge');
  // Der Zeitpunkt des Imports macht die Gruppenschlüssel eindeutig; die Uhr des Tests steht sonst
  await env.w.advance(1000);
  const res = await importFile(env, neu({ title: 'H', color: 'green' }, ['n3', 'n4']), 'merge');
  assert.deepEqual([res.created, res.merged, res.added], [0, 1, 2]);
  const expected = {
    Standard: [],
    Neu: [
      { url: 'n1', group: 'G', color: 'pink' },
      { url: 'n2', group: 'G', color: 'pink' },
      { url: 'n3', group: 'H', color: 'green' },
      { url: 'n4', group: 'H', color: 'green' },
    ],
    pinned: [],
  };
  check(env, expected);
  await cycle(env, ['Neu'], expected);
});

// ---------------------------------------------------------------- Ersetzen

const REPLACEMENT = fileOf(
  [
    { name: 'X', color: '#abcdef', emoji: '✨', groups: [{ id: 'g', title: 'G', color: 'pink' }], tabs: [tab('x1'), tab('x2', 'g'), tab('x3', 'g')] },
    { name: 'Y', color: '#fedcba', tabs: [tab('y1')] },
  ],
  [tab('p1'), tab('p9')],
);

test('Ersetzen ohne Bestätigung oder mit unbekannter Import-Art wird abgelehnt', async () => {
  const env = await setup(SPEC);
  const text = JSON.stringify(REPLACEMENT);
  await rejected(env, { type: 'import', text, mode: 'replace' }, /muss bestätigt werden/);
  await rejected(env, { type: 'import', text, mode: 'replace', confirmed: false }, /muss bestätigt werden/);
  await rejected(env, { type: 'import', text, mode: 'alles', confirmed: true }, /Unbekannte Import-Art/);
  await rejected(env, { type: 'import', text, confirmed: true }, /Unbekannte Import-Art/);
  check(env, ALL);
});

test('Ersetzen mit Bestätigung: alte Workspaces samt Ablagen sind weg, die neuen da', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  const oldIds = Object.values(env.ids);
  for (const name of ['B', 'C']) assert.ok(b.windows.some((w) => b.stashOf(w) === env.ids[name]), `Ablage von ${name} fehlt vor dem Import`);

  const res = await importFile(env, REPLACEMENT, 'replace', true);
  assert.deepEqual(res, { created: 2, merged: 0, added: 4, skipped: 0, failed: 0, removed: 3, closed: 10, pinned: 1, pinnedSkipped: 1 });

  const now = envOf(b);
  assert.deepEqual(b.local.data.workspaces.map((w) => [w.name, w.color, w.emoji]), [
    ['X', '#abcdef', '✨'],
    ['Y', '#fedcba', ''],
  ]);
  assert.equal(b.local.data.lastWs, now.ids.X);
  assert.equal(shows(now, env.win), 'X');
  for (const id of oldIds) {
    assert.equal(id in b.local.data.backup, false, 'Sicherung eines alten Workspace ist noch da');
    assert.equal(b.windows.some((w) => b.stashOf(w) === id), false, 'Ablage eines alten Workspace ist noch offen');
    assert.equal(Object.values(b.session.data.windowWs).includes(id), false, 'ein Fenster zeigt noch einen alten Workspace');
  }
  assert.deepEqual(OLD_URLS.flatMap((u) => b.tabsByUrl(u)), [], 'Tabs der alten Workspaces sind noch offen');
  // Y hat noch kein Fenster, die angehefteten Tabs sind geblieben und um p9 ergänzt
  assert.equal(b.windows.length, 1);
  const expected = { X: ['x1', { url: 'x2', group: 'G', color: 'pink' }, { url: 'x3', group: 'G', color: 'pink' }], Y: ['y1'], pinned: ['p1', 'p2', 'p9'] };
  check(now, expected, { allowNewTab: false });
  await cycle(now, ['Y', 'X'], expected);
});

test('Ersetzen durch den eigenen Export legt jeden Tab genau einmal neu an', async () => {
  const env = await source();
  const { b } = env;
  const file = await request(env, { type: 'export' });
  const oldIds = Object.values(env.ids);

  const res = await importFile(env, file, 'replace', true);
  assert.deepEqual(res, { created: 3, merged: 0, added: 10, skipped: 0, failed: 0, removed: 3, closed: 10, pinned: 0, pinnedSkipped: 2 });
  // Die IDs der Datei sind noch vergeben, deshalb bekommen die neuen Workspaces eigene
  const now = envOf(b);
  assert.deepEqual(b.local.data.workspaces.map((w) => w.name), ['C', 'A', 'B']);
  assert.deepEqual(b.local.data.workspaces.filter((w) => oldIds.includes(w.id)), []);
  assert.deepEqual(Object.keys(b.local.data.backup).sort(), Object.values(now.ids).sort());
  check(now, ALL, { allowNewTab: false });
  await cycle(now, ['A', 'B', 'C'], ALL);
});
