'use strict';
// Jede Aktion an jeder Stelle abgebrochen (#247): Endet der Service Worker oder lädt die
// Erweiterung neu, nachdem die Aktion n Aufrufe weit gekommen ist, fehlt danach kein Tab, keiner
// steht doppelt da, und die Sicherung entspricht dem Bestand. Die Aktion ist dann entweder
// ganz ausgeführt oder gar nicht, nur das Ersetzen beim Import darf halb fertig sein.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ok, url, where, interruptEverywhere } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [{ url: 'b1', group: 'Lesen', color: 'red' }, 'b2'],
    C: ['c1'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

// Ein Test je Art des Abbruchs. todo nennt je Art die Issues zu bekannten Fehlern: Solange sie
// offen sind, scheitert der Test, ohne den Lauf scheitern zu lassen. Ist alles behoben, den
// Eintrag streichen, damit der Test wieder zählt.
function everywhere(name, spec, todo = {}) {
  for (const [kind, label] of [['worker', 'Service Worker endet'], ['reload', 'Erweiterung lädt neu']]) {
    test(`${name}, an jeder Stelle: ${label}`, { todo: todo[kind] }, async () => {
      assert.deepEqual(await interruptEverywhere(kind, spec), []);
    });
  }
}

// Ein Tab der Export-Datei
const tab = (name, group) => ({ url: url(name), title: url(name), ...(group ? { group } : {}) });

// Workspace-IDs nach dem aktuellen Stand: Der Import legt neue an
const byName = (env) =>
  Object.defineProperty(env, 'ids', {
    get() {
      return Object.fromEntries(this.b.local.data.workspaces.map((x) => [x.name, x.id]));
    },
  });

everywhere('Tab verschieben', {
  make: () => setup(SPEC),
  act: (env) => env.w.send({ type: 'moveTab', tabId: where(env, 'a1').tab.id, wsId: env.ids.B }),
  outcomes: {
    unverändert: ALL,
    verschoben: { ...ALL, A: SPEC.workspaces.A.slice(1), B: [...SPEC.workspaces.B, 'a1'] },
  },
}, { worker: '#268' });

everywhere('Import mit Zusammenführen', {
  // Der eigene Export mit weiteren Tabs
  make: async () => {
    const env = await setup(SPEC);
    const file = JSON.parse(JSON.stringify(await ok(env.w.request({ type: 'export' }))));
    file.workspaces.find((x) => x.name === 'A').tabs.push(tab('a4'), tab('a5'));
    file.workspaces.find((x) => x.name === 'B').tabs.push(tab('b3'));
    file.pinned.push(tab('p2'));
    return Object.assign(env, { text: JSON.stringify(file) });
  },
  act: (env) => env.w.send({ type: 'import', mode: 'merge', text: env.text }),
  outcomes: {
    unverändert: ALL,
    zusammengeführt: { ...ALL, A: [...SPEC.workspaces.A, 'a4', 'a5'], B: [...SPEC.workspaces.B, 'b3'], pinned: ['p1', 'p2'] },
  },
});

// Ersetzen legt erst die neuen Workspaces an und löscht dann die alten: Abgebrochen bleiben
// alte neben den neuen stehen, jeder mit all seinen Tabs. Gelöschte lassen sich zurückholen.
const REPLACEMENT = {
  X: ['x1', { url: 'x2', group: 'G', color: 'pink' }, { url: 'x3', group: 'G', color: 'pink' }],
  Y: ['y1'],
};
const REPLACEMENT_FILE = JSON.stringify({
  format: 'helium-workspaces',
  version: 1,
  pinned: [tab('p1'), tab('p9')],
  workspaces: [
    { name: 'X', color: '#abcdef', groups: [{ id: 'g', title: 'G', color: 'pink' }], tabs: [tab('x1'), tab('x2', 'g'), tab('x3', 'g')] },
    { name: 'Y', color: '#fedcba', tabs: [tab('y1')] },
  ],
});
everywhere('Import mit Ersetzen', {
  make: async () => byName(await setup(SPEC)),
  act: (env) => env.w.send({ type: 'import', mode: 'replace', confirmed: true, text: REPLACEMENT_FILE }),
  outcomes: {
    unverändert: ALL,
    'ganz oder teilweise ersetzt': (env) => ({
      ...Object.fromEntries(Object.entries({ ...SPEC.workspaces, ...REPLACEMENT }).filter(([n]) => n in env.ids)),
      pinned: ['p1', 'p9'],
    }),
  },
}, { worker: '#271', reload: '#269, #270, #271' });

// B hat eine Gruppe, die beim Löschen vor dem Schließen der Ablage aufgelöst wird
everywhere('Workspace löschen', {
  make: () => setup(SPEC),
  act: (env) => env.w.send({ type: 'delete', wsId: env.ids.B }),
  outcomes: {
    unverändert: ALL,
    gelöscht: { A: SPEC.workspaces.A, C: SPEC.workspaces.C, pinned: SPEC.pinned },
  },
}, { worker: '#271', reload: '#271' });

everywhere('Link in Workspace öffnen', {
  make: () => setup(SPEC),
  act: (env) => env.b.fire('contextMenus.onClicked', { menuItemId: `link:${env.ids.B}`, linkUrl: url('l1') }, where(env, 'a1').tab),
  outcomes: {
    unverändert: ALL,
    geöffnet: { ...ALL, B: [...SPEC.workspaces.B, 'l1'] },
  },
}, { worker: '#268' });

// Der Wecker entlädt die Tabs der Ablagen. Sie bekommen dabei neue IDs (tabs.onReplaced).
everywhere('Ablagen entladen', {
  make: async () => {
    const env = await setup(SPEC);
    await ok(env.w.request({ type: 'unloadAfter', minutes: 5 }));
    env.b.now += 10 * 60000;
    return env;
  },
  act: (env) => env.b.fire('alarms.onAlarm', { name: 'unload' }),
  outcomes: { unverändert: ALL },
}, { reload: '#272' });

// Nach einem Start ohne Sitzungswiederherstellung liegt B nur in der Sicherung. Beim Wechsel
// zu B laden höchstens sechs Tabs zugleich, der Rest wird zurückgestellt und nachgelegt.
const BIG = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1'],
    B: Array.from({ length: 8 }, (_, i) => (i >= 3 && i < 7 ? { url: `b${i + 1}`, group: 'Mathe', color: 'blue' } : `b${i + 1}`)),
  },
};
everywhere('Wechsel mit Nachlegen aus der Sicherung', {
  make: async () => {
    const env = await setup(BIG);
    env.b.restart({ restore: 'none' });
    await env.b.startWorker('startup').settle();
    return env;
  },
  act: (env) => env.w.send({ type: 'switch', windowId: env.b.mains()[0].id, wsId: env.ids.B }),
  outcomes: { vollständig: { ...BIG.workspaces, pinned: BIG.pinned } },
}, { reload: '#269, #270' });
