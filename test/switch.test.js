'use strict';
// Workspace-Wechsel mit Gruppen und angehefteten Tabs, Tastenkürzel und Tab verschieben

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, where, shows, tabIds } = require('./harness');

const SPEC = {
  pinned: ['p1', 'p2'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    B: [{ url: 'b1', group: 'Lesen', color: 'red', collapsed: true }, { url: 'b2', group: 'Lesen', color: 'red', collapsed: true }, 'b3'],
    C: ['c1'],
  },
};

test('Aufbau: jeder Workspace hat seine Tabs, Gruppen und die angehefteten Tabs', async () => {
  const env = await setup(SPEC);
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
  assert.equal(shows(env, env.win), 'A');
  assert.equal(where(env, 'b1').stash, true);
  assert.equal(where(env, 'c1').ws, env.ids.C);
});

test('Wechsel hin und zurück verschiebt Tabs, ohne sie neu zu laden', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  const before = tabIds(env);
  for (const name of ['B', 'C', 'A', 'C', 'B', 'A']) {
    await ok(w.request({ type: 'switch', windowId: win, wsId: ids[name] }));
    assert.equal(shows(env, win), name);
    check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
    for (const it of SPEC.workspaces[name]) {
      const u = typeof it === 'string' ? it : it.url;
      const at = where(env, u);
      assert.equal(at.win.id, win, `${u} ist nicht im Hauptfenster`);
      assert.equal(at.tab.pinned, false);
    }
    // Angeheftete Tabs bleiben im Fenster und vorne
    assert.deepEqual(env.b.windows.find((x) => x.id === win).tabs.slice(0, 2).map((t) => t.url), [url('p1'), url('p2')]);
  }
  assert.deepEqual(tabIds(env), before, 'Tabs wurden neu angelegt statt verschoben');
});

test('Der zuletzt aktive Tab eines Workspace ist nach dem Zurückwechseln wieder aktiv', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await b.chrome.tabs.update(where(env, 'a3').tab.id, { active: true });
  await w.settle();
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  assert.equal(where(env, 'a3').tab.active, true);
});

test('Tastenkürzel wechseln reihum zum nächsten und vorherigen Workspace', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const tab = { id: b.windows.find((x) => x.id === win).tabs[0].id, windowId: win };
  const order = [];
  for (const cmd of ['next-workspace', 'next-workspace', 'next-workspace', 'prev-workspace']) {
    b.fire('commands.onCommand', cmd, tab);
    await w.settle();
    order.push(shows(env, win));
  }
  assert.deepEqual(order, ['B', 'C', 'A', 'C']);
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
});

test('Tab über das Kontextmenü in einen anderen Workspace verschieben', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const tab = where(env, 'a1').tab;
  b.fire('contextMenus.onClicked', { menuItemId: `move:${ids.B}` }, tab);
  await w.settle();
  assert.equal(where(env, 'a1').ws, ids.B);
  const [first, ...rest] = SPEC.workspaces.A;
  check(env, { ...SPEC.workspaces, A: rest, B: [...SPEC.workspaces.B, first], pinned: SPEC.pinned });

  // Auch der letzte Tab eines Workspace lässt sich verschieben, das Fenster bleibt offen
  for (const u of ['a2', 'a3', 'a4']) await ok(w.request({ type: 'moveTab', tabId: where(env, u).tab.id, wsId: ids.C }));
  assert.equal(shows(env, env.win), 'A');
  check(env, {
    A: [],
    B: [...SPEC.workspaces.B, 'a1'],
    C: ['c1', 'a2', 'a3', 'a4'],
    pinned: SPEC.pinned,
  });
});

test('Löschen eines angezeigten Workspace wechselt vorher weg und entfernt seine Tabs', async () => {
  const env = await setup(SPEC);
  const { w, ids } = env;
  await ok(w.request({ type: 'delete', wsId: ids.A }));
  assert.equal(shows(env, env.win), 'B');
  delete env.ids.A;
  check(env, { B: SPEC.workspaces.B, C: SPEC.workspaces.C, pinned: SPEC.pinned });
  assert.equal(env.b.local.data.workspaces.length, 2);
});
