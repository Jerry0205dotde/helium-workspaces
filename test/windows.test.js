'use strict';
// Mehrere Hauptfenster: eigene Workspaces je Fenster, derselbe Workspace in zwei
// Fenstern, Schließen einzelner Fenster und des letzten Fensters per X

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, where, shows, tabIds, openTabs, NEWTAB } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [{ url: 'b1', group: 'Lesen', color: 'red' }, 'b2'],
    C: ['c1', 'c2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

// Neues Fenster wie mit Strg+N; gibt seine ID zurück, sobald es zugeordnet ist
async function newWindow(env) {
  const win = await env.b.chrome.windows.create({ focused: true });
  await env.w.settle();
  return win.id;
}

test('Strg+N zeigt den zuletzt benutzten Workspace, jedes Fenster wechselt für sich', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  const before = tabIds(env);
  const win2 = await newWindow(env);
  assert.equal(shows(env, win2), 'A');

  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.C }));
  assert.equal(shows(env, win), 'C');
  assert.equal(shows(env, win2), 'B');
  assert.equal(where(env, 'b1').win.id, win2);
  assert.equal(where(env, 'c1').win.id, win);
  check(env, ALL);

  // Beide zurück zu A: die Tabs kommen dorthin, wo zuerst gewechselt wird
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.A }));
  assert.equal(where(env, 'a1').win.id, win2);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  assert.equal(where(env, 'a1').win.id, win2, 'Tabs von A wurden aus dem anderen Fenster weggenommen');
  check(env, ALL);
  for (const [u, id] of Object.entries(before)) assert.equal(tabIds(env)[u], id, `${u} wurde neu angelegt`);
});

test('Wechsel zu einem Workspace, der schon in einem anderen Fenster offen ist, verdoppelt nichts', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  const win2 = await newWindow(env);
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  // Fenster 1 wechselt zu B, dessen Tabs lebend in Fenster 2 liegen: keine Kopie aus der Sicherung
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  assert.equal(shows(env, win), 'B');
  assert.equal(where(env, 'b1').win.id, win2);
  const own = env.b.windows.find((x) => x.id === win).tabs.filter((t) => !t.pinned);
  assert.deepEqual(own.map((t) => t.url), [NEWTAB]);
  check(env, ALL);

  // Ein Tab, der in einem der beiden Fenster dazukommt, gehört zu B
  await openTabs(env.b, win, ['b3']);
  await w.settle();
  check(env, { ...ALL, B: [...SPEC.workspaces.B, 'b3'] });
});

test('Workspace ohne Ablage-Fenster, der schon anderswo offen ist, kommt nicht aus der Sicherung', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const win2 = await newWindow(env);
  // E hat noch nie eine Ablage gehabt: neu angelegt und nur in Fenster 1 angezeigt
  env.ids.E = (await ok(w.request({ type: 'create', name: 'E' }))).id;
  await ok(w.request({ type: 'switch', windowId: win, wsId: env.ids.E }));
  await openTabs(b, win, ['e1', 'e2']);
  await w.settle();
  assert.equal(b.windows.some((x) => b.stashOf(x) === env.ids.E), false);
  assert.ok(b.local.data.backup[env.ids.E].shown.some((e) => e.url.includes('e1')));
  await ok(w.request({ type: 'switch', windowId: win2, wsId: env.ids.E }));
  assert.equal(where(env, 'e1').win.id, win);
  check(env, { ...ALL, E: ['e1', 'e2'] });
});

test('Schließen eines von zwei Fenstern verwirft nur dessen Tabs', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const win2 = await newWindow(env);
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  await b.chrome.windows.remove(win2);
  await w.settle();
  check(env, { ...ALL, B: [] });
  assert.equal(shows(env, win), 'A');

  // Zeigen zwei Fenster denselben Workspace, bleibt beim Schließen des einen alles erhalten
  const win3 = await newWindow(env);
  await openTabs(b, win3, ['a4']);
  await w.settle();
  await b.chrome.windows.remove(win3);
  await w.settle();
  check(env, { ...ALL, B: [] });
});

test('Letztes Fenster per X geschlossen: nach dem Start ist alles wieder da', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await b.chrome.windows.remove(win);
  await w.settle();
  assert.equal(b.windows.length, 0, 'Ablage-Fenster wurden nicht geschlossen');

  // Chromium stellt nur das zuletzt geschlossene (Ablage-)Fenster wieder her
  b.restart();
  const w2 = b.startWorker('startup');
  await w2.settle();
  assert.equal(b.mains().length, 1);
  const main = b.mains()[0].id;
  assert.equal(shows(env, main), 'B');
  check(env, ALL);
  for (const name of ['A', 'C', 'B']) {
    await ok(w2.request({ type: 'switch', windowId: main, wsId: ids[name] }));
    check(env, ALL);
  }
});
