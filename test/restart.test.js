'use strict';
// Browserstart mit und ohne Sitzungswiederherstellung, verlorene Tabs und Ablagen,
// Neuladen der Erweiterung und Neustart des Service Workers

const test = require('node:test');
const assert = require('node:assert/strict');
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

// Wechselt im ersten Hauptfenster durch alle Workspaces und prüft danach jeweils alles
async function cycle(env, expected = ALL, names = ['B', 'C', 'A']) {
  const main = env.b.mains()[0].id;
  for (const name of names) {
    await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids[name] }));
    assert.equal(shows(env, main), name);
    check(env, expected);
  }
}

test('Neustart mit Sitzungswiederherstellung: Fenster werden über ihre Tabs wiedererkannt', async () => {
  const env = await setup(SPEC);
  env.b.restart();
  const w = env.b.startWorker('startup');
  await w.settle();
  assert.equal(env.b.mains().length, 1);
  assert.equal(shows(env, env.b.mains()[0].id), 'A');
  check(env, ALL);
  const ids = tabIds(env);
  await cycle(env);
  assert.deepEqual(tabIds(env), ids, 'nach dem Neustart wurden Tabs neu angelegt');
});

test('Neustart mit zwei Hauptfenstern ordnet jedes Fenster seinem Workspace zu', async () => {
  const env = await setup(SPEC);
  const { b, ids } = env;
  const win2 = (await b.chrome.windows.create({ url: url('a1').replace('a1', 'x0'), focused: true })).id;
  await env.w.settle();
  await ok(env.w.request({ type: 'switch', windowId: win2, wsId: ids.C }));
  await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: ids.B }));
  // x0 wanderte mit dem Wechsel von Fenster 2 in die Ablage von A
  const expected = { ...ALL, A: [...SPEC.workspaces.A, 'x0'] };
  check(env, expected);

  b.restart();
  const w = b.startWorker('startup');
  await w.settle();
  const mains = b.mains();
  assert.equal(mains.length, 2);
  assert.deepEqual(mains.map((x) => shows(env, x.id)).sort(), ['B', 'C']);
  assert.equal(where(env, 'b1').win.id, mains.find((x) => shows(env, x.id) === 'B').id);
  check(env, expected);
});

test('Beim Wiederherstellen verlorene Tabs werden an ihrer Stelle und in ihrer Gruppe ergänzt', async () => {
  const env = await setup(SPEC);
  const lost = new Set([url('a3'), url('b1'), url('c2')]);
  env.b.restart({ loseTab: (t) => lost.has(t.url) });
  const w = env.b.startWorker('startup');
  await w.settle();
  check(env, ALL);
  const main = env.b.windows.find((x) => x.id === env.b.mains()[0].id);
  assert.deepEqual(
    main.tabs.map((t) => t.url),
    [url('p1'), url('p2'), url('a1'), url('a2'), url('a3'), url('a4')],
    'verlorener Tab steht nicht an seiner alten Stelle',
  );
  await cycle(env);
});

test('Start ohne Sitzungswiederherstellung baut den letzten Workspace aus der Sicherung auf', async () => {
  for (const keepPinned of [false, true]) {
    const env = await setup(SPEC);
    await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: env.ids.B }));
    env.b.restart({ restore: 'none', keepPinned });
    const w = env.b.startWorker('startup');
    await w.settle();
    assert.equal(env.b.windows.length, 1);
    const main = env.b.windows[0];
    assert.equal(shows(env, main.id), 'B');
    // Die neue Tab-Seite des Starts wird durch die gesicherten Tabs ersetzt
    assert.equal(main.tabs.filter((t) => t.url === NEWTAB).length, 0);
    check(env, ALL);
    // Die übrigen Workspaces kommen beim Wechseln aus der Sicherung, samt Gruppen
    await cycle(env, ALL, ['A', 'C', 'B', 'A']);
  }
});

// Zweites Hauptfenster mit C, in dem q1 und (wie in Fenster 1) p1 angeheftet sind
async function secondWindowWithPinned(env) {
  const { b } = env;
  const win2 = (await b.chrome.windows.create({ focused: true })).id;
  await env.w.settle();
  await ok(env.w.request({ type: 'switch', windowId: win2, wsId: env.ids.C }));
  for (const p of ['q1', 'p1']) {
    const t = await b.chrome.tabs.create({ windowId: win2, url: url(p), active: false });
    await b.chrome.tabs.update(t.id, { pinned: true });
  }
  await env.w.settle();
  assert.deepEqual(b.local.data.backupPinned.map((e) => e.url), ['p1', 'p2', 'q1'].map(url));
  return win2;
}

test('Angeheftete Tabs eines zweiten Hauptfensters kommen nach einem Start ohne Sitzungswiederherstellung zurück', async () => {
  for (const keepPinned of [false, true]) {
    const env = await setup(SPEC);
    await secondWindowWithPinned(env);
    env.b.restart({ restore: 'none', keepPinned });
    const w = env.b.startWorker('startup');
    await w.settle();
    assert.equal(env.b.windows.length, 1);
    assert.equal(shows(env, env.b.windows[0].id), 'C');
    const all = { ...ALL, pinned: [...SPEC.pinned, 'q1'] };
    check(env, all);
    await cycle(env, all, ['A', 'B', 'C']);
  }
});

test('Neuaufbau des Hauptfensters bringt die angehefteten Tabs aller Hauptfenster zurück', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  await secondWindowWithPinned(env);
  // Chromium stellt nur die Ablagen wieder her, keins der beiden Hauptfenster
  b.restart({ loseWindow: (x) => !x.tabs.some((t) => t.url.startsWith(b.origin)) });
  const w = b.startWorker('startup');
  await w.settle();
  assert.equal(b.mains().length, 1);
  const all = { ...ALL, pinned: [...SPEC.pinned, 'q1'] };
  check(env, all);
  await cycle(env, all);
});

test('Start, bei dem Chromium die Fenster erst nach dem Service Worker wiederherstellt', async () => {
  const env = await setup(SPEC);
  env.b.restart({ restore: 'later', loseTab: (t) => t.url === url('b2') });
  const w = env.b.startWorker('startup');
  await w.advance(500);
  env.b.finishRestore();
  await w.settle();
  check(env, ALL);
  await cycle(env);
});

test('Nicht wiederhergestellte Ablage: ihr Workspace kommt beim Wechseln aus der Sicherung', async () => {
  const env = await setup(SPEC);
  const stashB = env.b.windows.find((x) => env.b.stashOf(x) === env.ids.B);
  env.b.restart({ loseWindow: (s) => s.tabs.some((t) => t.url.endsWith(`#${env.ids.B}`)) && stashB });
  const w = env.b.startWorker('startup');
  await w.settle();
  assert.equal(env.b.windows.some((x) => env.b.stashOf(x) === env.ids.B), false);
  check(env, ALL);
  await cycle(env);
});

test('Neuladen der Erweiterung: geschlossene Ablage-Seiten werden ersetzt, kein Tab geht verloren', async () => {
  const env = await setup({ ...SPEC, workspaces: { ...SPEC.workspaces, D: [] } });
  const expected = { ...ALL, D: [] };
  await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: env.ids.C }));
  const ids = tabIds(env);
  const w = env.b.reloadExtension();
  // Ohne Ablage-Seite sähen die Ablagen wie Hauptfenster aus
  assert.equal(env.b.windows.filter((x) => env.b.stashOf(x)).length, 0);
  await w.settle();
  assert.equal(env.b.mains().length, 1);
  assert.equal(shows(env, env.b.mains()[0].id), 'C');
  check(env, expected);
  assert.deepEqual(tabIds(env), ids, 'Tabs wurden neu angelegt');
  await cycle(env, expected, ['D', 'A', 'B', 'C']);
});

test('Neuladen der Erweiterung: leere Ablage bleibt Ablage statt eines weiteren Hauptfensters', async () => {
  const env = await setup(SPEC);
  const { b, ids } = env;
  await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: ids.B }));
  await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: ids.A }));
  const stashA = b.windows.find((x) => b.stashOf(x) === ids.A);
  assert.equal(stashA.tabs.length, 1, 'Ablage von A enthält nur ihre Ablage-Seite');

  const w = b.reloadExtension();
  await w.settle();
  assert.equal(b.mains().length, 1);
  assert.equal(shows(env, env.win), 'A');
  assert.equal(b.stashOf(stashA), ids.A);
  assert.deepEqual(b.tabsByUrl(NEWTAB), [], 'neue Tab-Seite ist geblieben');
  check(env, ALL);
  await cycle(env);
});

test('Zweimaliges Neuladen hintereinander und danach ein Browserstart', async () => {
  const env = await setup(SPEC);
  let w = env.b.reloadExtension();
  await w.advance(100); // der erste Abgleich ist noch nicht gelaufen
  w = env.b.reloadExtension();
  await w.settle();
  check(env, ALL);
  env.b.restart();
  w = env.b.startWorker('startup');
  await w.settle();
  check(env, ALL);
  await cycle(env);
});

test('Neustart nur des Service Workers ändert nichts', async () => {
  const env = await setup(SPEC);
  await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: env.ids.B }));
  const layout = JSON.stringify(env.b.windows);
  const w = env.b.startWorker(null);
  await w.settle();
  assert.equal(JSON.stringify(env.b.windows), layout);
  check(env, ALL);
  await cycle(env);
});

test('Tastenkürzel direkt nach dem Neuladen nutzt den Workspace des Fensters, nicht den zuletzt benutzten', async () => {
  const env = await setup(SPEC);
  const { b, ids } = env;
  const win2 = (await b.chrome.windows.create({ url: url('x0'), focused: true })).id;
  await env.w.settle();
  await ok(env.w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  // Fenster 1 zeigt A, zuletzt benutzt wurde B
  assert.equal(shows(env, env.win), 'A');
  assert.equal(b.local.data.lastWs, ids.B);
  const expected = { ...ALL, A: [...SPEC.workspaces.A, 'x0'] };
  check(env, expected);

  const w = b.reloadExtension();
  b.fire('commands.onCommand', 'prev-workspace', { windowId: env.win }); // vor dem ersten Abgleich
  await w.settle();
  assert.equal(shows(env, env.win), 'C');
  assert.equal(shows(env, win2), 'B');
  assert.equal(where(env, 'a1').ws, ids.A);
  check(env, expected);
});

test('Neuladen der Erweiterung: Fenster nur mit neuem Tab behält seinen Workspace', async () => {
  const env = await setup({ ...SPEC, workspaces: { ...SPEC.workspaces, D: [] } });
  const { b, ids } = env;
  const expected = { ...ALL, D: [] };
  const win2 = (await b.chrome.windows.create({ url: NEWTAB, focused: true })).id;
  await env.w.settle();
  await ok(env.w.request({ type: 'switch', windowId: win2, wsId: ids.D }));
  await ok(env.w.request({ type: 'switch', windowId: env.win, wsId: ids.B }));
  assert.equal(shows(env, win2), 'D');
  assert.equal(b.local.data.lastWs, ids.B);

  const w = b.reloadExtension();
  await w.settle();
  assert.equal(shows(env, env.win), 'B');
  assert.equal(shows(env, win2), 'D');
  check(env, expected);
});

test('Nach einem Browserstart werden gespeicherte Fenster-IDs nicht mehr genutzt', async () => {
  const env = await setup(SPEC);
  await env.w.settle();
  assert.ok(env.b.local.data.backupWindows.every((e) => typeof e.id === 'number'));
  env.b.restart();
  const w = env.b.startWorker('startup');
  await w.advance(0);
  assert.ok(env.b.local.data.backupWindows.every((e) => e.id === undefined || env.b.mains().some((m) => m.id === e.id)));
  await w.settle();
  check(env, ALL);
});
