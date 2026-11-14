'use strict';
// Workspace-Wechsel mit Gruppen und angehefteten Tabs, Tastenkürzel und Tab verschieben

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, where, shows, tabIds } = require('./harness');

const SPEC = {
  pinned: ['p1', 'p2'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    // b0 ist beim Wechsel aktiv; die eingeklappte Gruppe bleibt so eingeklappt
    B: ['b0', { url: 'b1', group: 'Lesen', color: 'red', collapsed: true }, { url: 'b2', group: 'Lesen', color: 'red', collapsed: true }, 'b3'],
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

test('Ein angehefteter Tab überschreibt nicht den zuletzt aktiven Tab des Workspace', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await b.chrome.tabs.update(where(env, 'a3').tab.id, { active: true });
  await w.settle();
  await b.chrome.tabs.update(where(env, 'p1').tab.id, { active: true });
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

test('Tastenkürzel wechseln direkt zu Workspace 1–9 und zum zuletzt benutzten', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const tab = { id: b.windows.find((x) => x.id === win).tabs[0].id, windowId: win };
  const order = [];
  // switch-9 bei drei Workspaces tut nichts
  for (const cmd of ['switch-3', 'switch-9', 'last-workspace', 'last-workspace', 'switch-2', 'last-workspace', 'switch-1']) {
    b.fire('commands.onCommand', cmd, tab);
    await w.settle();
    order.push(shows(env, win));
  }
  assert.deepEqual(order, ['C', 'C', 'A', 'C', 'B', 'C', 'A']);
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
});

test('Das Kontextmenü erscheint auch auf Links, Bildern, Videos und markiertem Text', async () => {
  const { b, ids } = await setup(SPEC);
  const sub = (kind) => Object.values(ids).map((id) => `${kind}:${id}`);
  assert.deepEqual(b.menus.map((m) => m.id), ['move', ...sub('move'), 'group', ...sub('group')]);
  for (const m of b.menus) {
    for (const c of ['page', 'link', 'image', 'video', 'audio', 'selection', 'frame', 'editable', 'action']) {
      assert.ok(m.contexts.includes(c), `${m.id} fehlt im Kontext ${c}`);
    }
  }
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

// Markiert die Tabs mit diesen URLs wie mit Strg+Klick, der erste wird aktiv
async function highlight(env, names) {
  await env.b.chrome.tabs.highlight({ windowId: env.win, tabs: names.map((n) => where(env, n).win.tabs.findIndex((t) => t.url === url(n))) });
  await env.w.settle();
}

const menu = (env, id) => env.b.menus.find((m) => m.id === id);

test('Markierte Tabs gehen gemeinsam in den Workspace, eine ganz markierte Gruppe bleibt erhalten', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const before = tabIds(env);
  // a2 allein aus der Gruppe „Mathe“: verlässt sie, a3 bleibt in A in seiner Gruppe
  await highlight(env, ['a1', 'a2', 'a4']);
  assert.equal(menu(env, 'move').title, '3 markierte Tabs in Workspace verschieben');
  b.fire('contextMenus.onClicked', { menuItemId: `move:${ids.B}` }, where(env, 'a1').tab);
  await w.settle();
  check(env, {
    ...SPEC.workspaces,
    A: [{ url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [...SPEC.workspaces.B, 'a1', 'a2', 'a4'],
    pinned: SPEC.pinned,
  });
  assert.equal(shows(env, env.win), 'A');

  // Über das Popup: die ganze Gruppe markiert, sie kommt samt Titel und Farbe an
  await ok(w.request({ type: 'switch', windowId: env.win, wsId: ids.B }));
  await highlight(env, ['b1', 'b2', 'b3']);
  await ok(w.request({ type: 'moveTab', tabId: where(env, 'b1').tab.id, wsId: ids.C }));
  check(env, {
    A: [{ url: 'a3', group: 'Mathe', color: 'blue' }],
    B: ['b0', 'a1', 'a2', 'a4'],
    C: ['c1', { url: 'b1', group: 'Lesen', color: 'red' }, { url: 'b2', group: 'Lesen', color: 'red' }, 'b3'],
    pinned: SPEC.pinned,
  });
  assert.deepEqual(tabIds(env), before, 'Tabs wurden neu angelegt statt verschoben');
});

test('Markierte angeheftete Tabs kommen in ihrer Reihenfolge an', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  await highlight(env, ['p1', 'p2']);
  b.fire('contextMenus.onClicked', { menuItemId: `move:${ids.C}` }, where(env, 'p1').tab);
  await w.settle();
  assert.deepEqual(where(env, 'c1').win.tabs.slice(1).map((t) => t.url), [url('c1'), url('p1'), url('p2')]);
  assert.equal(where(env, 'p1').tab.pinned, false);
});

test('„Gruppe in Workspace verschieben“ erscheint nur in einer Gruppe und nimmt sie ganz mit', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  await highlight(env, ['a1']);
  assert.equal(menu(env, 'group').visible, false);
  assert.equal(menu(env, 'move').title, 'Tab in Workspace verschieben');
  await highlight(env, ['a2']);
  assert.equal(menu(env, 'group').visible, true);
  assert.ok(menu(env, `group:${ids.C}`), 'Workspace fehlt im Gruppenmenü');

  b.fire('contextMenus.onClicked', { menuItemId: `group:${ids.C}` }, where(env, 'a2').tab);
  await w.settle();
  check(env, {
    ...SPEC.workspaces,
    A: ['a1', 'a4'],
    C: ['c1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    pinned: SPEC.pinned,
  });
  // Der nun aktive Tab ist in keiner Gruppe mehr
  assert.equal(menu(env, 'group').visible, false);

  // Ohne Gruppe verschiebt der Eintrag nur den Tab
  b.fire('contextMenus.onClicked', { menuItemId: `group:${ids.C}` }, where(env, 'a4').tab);
  await w.settle();
  assert.equal(where(env, 'a4').ws, ids.C);
  assert.equal(where(env, 'a1').ws, ids.A);
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

const plain = (v) => JSON.parse(JSON.stringify(v));
const names = (env) => env.b.local.data.workspaces.map((x) => x.name);
const deletedOf = async (env) => (await ok(env.w.request({ type: 'state', windowId: env.win }))).deleted;

test('Rückgängig holt einen gelöschten Workspace samt Tabs und Gruppen an seinen Platz zurück (#80)', async () => {
  const env = await setup(SPEC);
  const { w, win, ids, b } = env;
  const before = plain(b.local.data.workspaces);
  await ok(w.request({ type: 'delete', wsId: ids.B }));
  assert.deepEqual(names(env), ['A', 'C']);
  assert.deepEqual(plain(await deletedOf(env)), ['B']);

  assert.equal(await ok(w.request({ type: 'undoDelete' })), ids.B);
  assert.deepEqual(plain(b.local.data.workspaces), before, 'Name, Farbe, Emoji, ID oder Platz weichen ab');
  assert.equal(await deletedOf(env), null, 'Rückgängig wird weiter angeboten');
  // B hat kein Fenster mehr, check vergleicht mit seiner Sicherung
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
  const state = await ok(w.request({ type: 'state', windowId: win }));
  assert.equal(state.workspaces.find((x) => x.id === ids.B).count, 4);

  // Beim Wechsel öffnen sich die Tabs aus der Sicherung, die Gruppe eingeklappt wie vorher
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  assert.equal(shows(env, win), 'B');
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
});

test('Gelöschter angezeigter Workspace: Rückgängig bringt ihn zurück, das Fenster bleibt beim Ersatz', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  await ok(w.request({ type: 'delete', wsId: ids.A }));
  assert.equal(shows(env, win), 'B');
  await ok(w.request({ type: 'undoDelete' }));
  assert.deepEqual(names(env), ['A', 'B', 'C']);
  assert.equal(shows(env, win), 'B');
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
});

test('Rückgängig nimmt die Tabs der Ablage, auch wenn die Sicherung sie noch nicht kennt', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const stashC = b.windows.find((x) => b.stashOf(x) === ids.C);
  // Ohne abzuwarten löschen: Die verzögerte Sicherung ist dann noch nicht gelaufen
  await b.chrome.tabs.create({ windowId: stashC.id, url: url('c2'), active: false });
  assert.equal(JSON.stringify(b.local.data.backup[ids.C]).includes('c2'), false, 'Testfehler: c2 ist schon gesichert');
  await ok(w.request({ type: 'delete', wsId: ids.C }));
  await ok(w.request({ type: 'undoDelete' }));
  check(env, { ...SPEC.workspaces, C: ['c1', 'c2'], pinned: SPEC.pinned });
});

test('Nur das zuletzt Gelöschte lässt sich zurückholen; ✕ verwirft auch das', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  await ok(w.request({ type: 'delete', wsId: ids.B }));
  await ok(w.request({ type: 'delete', wsId: ids.C }));
  assert.deepEqual(plain(await deletedOf(env)), ['C']);
  await ok(w.request({ type: 'undoDelete' }));
  assert.deepEqual(names(env), ['A', 'C']);
  // Ein zweites Rückgängig hat nichts mehr zu tun
  assert.equal(await ok(w.request({ type: 'undoDelete' })), null);
  assert.deepEqual(names(env), ['A', 'C']);

  await ok(w.request({ type: 'delete', wsId: ids.C }));
  await ok(w.request({ type: 'forgetDeleted' }));
  assert.equal(await deletedOf(env), null);
  assert.equal(b.local.data.deleted, undefined);
  assert.equal(await ok(w.request({ type: 'undoDelete' })), null);
  assert.deepEqual(names(env), ['A']);
});

test('Tab in einer Ablage aktivieren (z. B. über die Tab-Suche) wechselt das Hauptfenster dorthin', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const before = tabIds(env);
  // Die Tab-Suche aktiviert den Tab und holt sein Fenster nach vorn
  const at = where(env, 'b3');
  assert.equal(at.stash, true);
  await b.chrome.tabs.update(at.tab.id, { active: true });
  await b.chrome.windows.update(at.win.id, { focused: true });
  await w.settle();
  assert.equal(shows(env, win), 'B');
  assert.equal(where(env, 'b3').win.id, win);
  assert.equal(where(env, 'b3').tab.active, true);
  assert.equal(b.windows.find((x) => x.id === win).focused, true, 'Hauptfenster ist nicht im Vordergrund');
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
  assert.deepEqual(tabIds(env), before, 'Tabs wurden neu angelegt statt verschoben');
});
