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
  assert.deepEqual(b.menus.map((m) => m.id), ['link', ...sub('link'), 'move', ...sub('move'), 'group', ...sub('group'), 'tabMove', ...sub('tabMove'), 'tabGroup', ...sub('tabGroup')]);
  // „Link in Workspace öffnen“ nur auf Links
  for (const m of b.menus.filter((x) => x.id.startsWith('link'))) assert.deepEqual(m.contexts, ['link']);
  assert.equal(b.menus[0].title, 'Link in Workspace öffnen');
  // Die Einträge für die Tab-Leiste nur dort (#309)
  for (const m of b.menus.filter((x) => x.id.startsWith('tab'))) assert.deepEqual(m.contexts, ['tab']);
  for (const m of b.menus.filter((x) => !x.id.startsWith('link') && !x.id.startsWith('tab'))) {
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

// Rechtsklick auf einen Tab in der Tab-Leiste: Chrome übergibt den rechtsgeklickten Tab, der
// nicht der aktive sein muss (#309)
test('Kontextmenü der Tab-Leiste verschiebt den rechtsgeklickten Tab, auch wenn er nicht aktiv ist', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  await highlight(env, ['a1']);
  // Titel ohne Anzahl und Gruppen-Eintrag immer da, auch wenn der aktive Tab in keiner Gruppe ist
  assert.equal(menu(env, 'tabMove').title, 'In Workspace verschieben');
  assert.equal(menu(env, 'tabGroup').title, 'Gruppe in Workspace verschieben');
  assert.notEqual(menu(env, 'tabGroup').visible, false);
  await highlight(env, ['a1', 'a4']);
  assert.equal(menu(env, 'tabMove').title, 'In Workspace verschieben');

  // Nicht markierter Tab: nur er geht, die markierten bleiben
  b.fire('contextMenus.onClicked', { menuItemId: `tabMove:${ids.C}` }, where(env, 'a2').tab);
  await w.settle();
  check(env, {
    ...SPEC.workspaces,
    A: ['a1', { url: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    C: ['c1', 'a2'],
    pinned: SPEC.pinned,
  });
  assert.equal(where(env, 'a1').tab.active, true);

  // Markierter, nicht aktiver Tab: alle markierten gehen gemeinsam
  b.fire('contextMenus.onClicked', { menuItemId: `tabMove:${ids.B}` }, where(env, 'a4').tab);
  await w.settle();
  check(env, {
    ...SPEC.workspaces,
    A: [{ url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [...SPEC.workspaces.B, 'a1', 'a4'],
    C: ['c1', 'a2'],
    pinned: SPEC.pinned,
  });
});

test('„Gruppe in Workspace verschieben“ in der Tab-Leiste nimmt die Gruppe eines nicht aktiven Tabs mit, ohne Gruppe nichts', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  await highlight(env, ['a1']);
  // Ohne Gruppe tut der Eintrag nichts
  b.fire('contextMenus.onClicked', { menuItemId: `tabGroup:${ids.C}` }, where(env, 'a4').tab);
  await w.settle();
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });

  b.fire('contextMenus.onClicked', { menuItemId: `tabGroup:${ids.C}` }, where(env, 'a3').tab);
  await w.settle();
  check(env, {
    ...SPEC.workspaces,
    A: ['a1', 'a4'],
    C: ['c1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    pinned: SPEC.pinned,
  });
  assert.equal(where(env, 'a1').tab.active, true);
});

test('Ohne Kontext „tab“ (vor Chrome 150) entstehen die übrigen Menüs wie bisher', async () => {
  const env = await setup(SPEC);
  const { b, ids } = env;
  // Wie ein älterer Browser nach dem Update der Erweiterung, das ihre Menüs entfernt
  b.tabContext = false;
  b.menus = [];
  await b.startWorker('installed').settle();
  const sub = (kind) => Object.values(ids).map((id) => `${kind}:${id}`);
  assert.deepEqual(b.menus.map((m) => m.id), ['link', ...sub('link'), 'move', ...sub('move'), 'group', ...sub('group')]);
  assert.deepEqual(b.errors, []);
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

// ---------------------------------------------------------------- Symbole (#296)

// Die eigenen Werte des Tabs (fake-browser.js), ohne die für alle Tabs ohne eigene
const ownIcon = (env, id) => env.b.findTab(id).t.action ?? {};
const iconCalls = (env, from) => env.b.calls.slice(from).filter((c) => c.name.startsWith('action.'));

function assertIcons(env, windowId, name) {
  for (const t of env.b.windows.find((x) => x.id === windowId).tabs) {
    const a = ownIcon(env, t.id);
    assert.equal(a.title, `Workspace: ${name}`, `${t.url} trägt den falschen Titel`);
    assert.equal(a.icon?.label, name, `${t.url} trägt das falsche Symbol`);
    assert.equal(a.badge, '');
  }
}

test('Wechsel setzt Symbol, Titel und Plakette nur bei Tabs, die etwas anderes tragen (#296)', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  for (const name of ['B', 'A', 'B', 'C', 'A']) {
    const from = env.b.calls.length;
    await ok(w.request({ type: 'switch', windowId: win, wsId: ids[name] }));
    await w.settle();
    assertIcons(env, win, name);
    // Die geholten Tabs tragen ihr Symbol noch aus der Zeit vor der Ablage: neu gesetzt
    // werden nur die angehefteten Tabs, die beim Wechsel im Fenster bleiben
    const set = new Set(iconCalls(env, from).filter((c) => c.args[0].tabId !== undefined).map((c) => c.args[0].tabId));
    const pinned = env.b.windows.find((x) => x.id === win).tabs.filter((t) => t.pinned).map((t) => t.id);
    assert.deepEqual([...set].sort(), pinned.sort(), `Wechsel nach ${name} setzt mehr als die angehefteten Tabs`);
  }
  // Nichts geändert: kein Aufruf
  const from = env.b.calls.length;
  await w.eval('updateAllIcons()');
  assert.deepEqual(iconCalls(env, from), []);
});

test('Tab lädt in der Ablage eine Seite: nach dem Zurückwechseln trägt er wieder das Symbol (#296)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  // Chromium verwirft dabei die Werte des Tabs
  await b.chrome.tabs.update(where(env, 'a1').tab.id, { url: url('a9') });
  await w.settle();
  assert.deepEqual(ownIcon(env, where(env, 'a9').tab.id), {});
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  await w.settle();
  assertIcons(env, win, 'A');
});

test('Tab lädt im Hauptfenster eine Seite: Symbol wird danach neu gesetzt (#296)', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  await b.chrome.tabs.update(where(env, 'a2').tab.id, { url: url('a9') });
  await w.settle();
  assertIcons(env, win, 'A');
});

test('Umbenennen setzt alle Tabs neu, Neuladen der Erweiterung ebenso (#296)', async () => {
  const env = await setup(SPEC);
  const { b, win, ids } = env;
  await ok(env.w.request({ type: 'update', wsId: ids.A, patch: { name: 'X' } }));
  await env.w.settle();
  assertIcons(env, win, 'X');
  await b.reloadExtension().settle();
  assertIcons(env, win, 'X');
});

test('Tab in einen versteckten Workspace verschieben setzt kein Symbol, der Wechsel dorthin schon (#296)', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  const id = where(env, 'a1').tab.id;
  const from = env.b.calls.length;
  await ok(w.request({ type: 'moveTab', tabId: id, wsId: ids.B }));
  await w.settle();
  assert.deepEqual(iconCalls(env, from).filter((c) => c.args[0].tabId === id), []);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.settle();
  assertIcons(env, win, 'B');
});

test('Tab in einen Workspace in einem anderen Fenster verschieben: er trägt dessen Symbol (#296)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const win2 = (await b.chrome.windows.create({ focused: true })).id;
  await w.settle();
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  await ok(w.request({ type: 'moveTab', tabId: where(env, 'a1').tab.id, wsId: ids.B }));
  await w.settle();
  assert.equal(where(env, 'a1').win.id, win2);
  assertIcons(env, win2, 'B');
  assertIcons(env, win, 'A');
});

// Das Popup schließt erst mit der Antwort. Sie kommt, sobald die Tabs gewechselt sind, nicht
// erst nach Symbolen, Sicherung und Stummschalten; die laufen danach weiter (#297)
test('Popup: Die Antwort auf einen Wechsel wartet nicht auf die Sicherung (#297)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await w.settle();
  const held = b.fail('storage.local.set', { hold: true, when: (o) => 'backup' in o && !b.session.data.pendingSwitch });
  let reply = null;
  w.send({ type: 'show', windowId: win, wsId: ids.B }).then((r) => (reply = r));
  await w.settle();
  assert.equal(held.hits, 1, 'die Sicherung wurde nicht geschrieben');
  assert.equal(reply?.ok, true, 'keine Antwort, solange die Sicherung aussteht');
  assert.equal(shows(env, win), 'B');
  assert.equal(b.session.data.snapshotDue, true, 'die ausstehende Sicherung ist nicht vermerkt');
  held.release();
  await w.settle();
  assert.equal(b.session.data.snapshotDue, undefined);
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });
  assertIcons(env, win, 'B');
});

test('Popup: Ein gescheiterter Wechsel meldet weiter seinen Fehler (#297)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  b.fail('tabs.move', { times: Infinity });
  const r = await w.request({ type: 'show', windowId: win, wsId: ids.B });
  assert.equal(r.ok, false);
  assert.match(r.error, /tabs\.move gescheitert/);
  assert.equal(shows(env, win), 'A');
});

test('Popup: Endet der Service Worker nach der Antwort, holt der Abgleich die Sicherung nach (#297)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await w.settle();
  b.fail('storage.local.set', { stop: true, when: (o) => 'backup' in o && !b.session.data.pendingSwitch });
  let reply = null;
  w.send({ type: 'show', windowId: win, wsId: ids.B }).then((r) => (reply = r));
  await w.settle();
  assert.equal(reply?.ok, true);
  assert.ok(w.dead, 'Testfehler: der Service Worker lief bis zur Sicherung durch');
  assert.deepEqual(b.local.data.backup[ids.B].shown, [], 'Testfehler: die Sicherung ist schon geschrieben');
  await b.startWorker(null).settle();
  const urls = (e) => e.map((x) => x.url);
  assert.deepEqual(urls(b.local.data.backup[ids.B].shown), SPEC.workspaces.B.map((x) => url(x.url ?? x)));
  assert.deepEqual(urls(b.local.data.backup[ids.A].stash), SPEC.workspaces.A.map((x) => url(x.url ?? x)));
  check(env, { ...SPEC.workspaces, pinned: SPEC.pinned });

test('Wechsel mit vielen Tabs: Menüs einmal danach angepasst, Sicherung nur einmal geschrieben (#299)', async () => {
  const many = (p) => Array.from({ length: 40 }, (_, i) => `${p}${i}`);
  const env = await setup({ workspaces: { A: many('a'), B: [...many('b'), { url: 'bg', group: 'Lesen' }] } });
  const { w, win, ids } = env;
  const count = (from, name, pred = () => true) => env.b.calls.slice(from).filter((c) => c.name === name && pred(c.args)).length;
  const backups = (from) => count(from, 'storage.local.set', ([items]) => 'backup' in items);
  for (const name of ['B', 'A']) {
    const from = env.b.calls.length;
    await ok(w.request({ type: 'switch', windowId: win, wsId: ids[name] }));
    await w.advance(5000);
    assert.equal(shows(env, win), name);
    assert.ok(count(from, 'tabs.query', ([q]) => q.highlighted) <= 1, 'Menüs je Tab abgefragt');
    assert.ok(count(from, 'contextMenus.update') <= 2, 'Menüs je Tab gesetzt');
    assert.ok(count(from, 'windows.getAll') < 10, 'Abbild je Tab aufgefrischt');
    assert.equal(backups(from), 1, 'Sicherung mehr als einmal geschrieben');
  }
  // Der gesetzte Stand folgt dem aktiven Tab: in der Gruppe ist „Gruppe verschieben“ sichtbar
  const menus = () => env.b.calls.filter((c) => c.name === 'contextMenus.update' && c.args[0] === 'group').at(-1)?.args[1].visible;
  await env.b.chrome.tabs.update(where(env, 'a0').tab.id, { active: true });
  await w.advance(1000);
  assert.notEqual(menus(), true);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await env.b.chrome.tabs.update(where(env, 'bg').tab.id, { active: true });
  await w.advance(1000);
  assert.equal(menus(), true);
  // Ändert sich nichts, wird nichts gesetzt
  const from = env.b.calls.length;
  await w.eval('updateMenus()');
  assert.equal(count(from, 'contextMenus.update'), 0);
  // Ein Tab-Ereignis ohne eigene Verschiebung sichert weiterhin
  const before = env.b.calls.length;
  await env.b.chrome.tabs.move(where(env, 'b0').tab.id, { index: -1 });
  await w.advance(5000);
  assert.equal(backups(before), 1);
});

// Vermerke begonnener Aktionen: snapshot() und resumeSwitch() lesen sie in einem Zugriff je
// Speicher, nicht einzeln nacheinander (#305)
const MARKS = new Set(['pendingSwitch', 'pendingStash', 'pendingMove', 'pendingDelete', 'pendingFeed', 'discarding', 'pendingStart', 'pendingRetry']);
const markReads = (env, from) =>
  env.b.calls
    .slice(from)
    .filter((c) => /^storage\.(local|session)\.get$/.test(c.name) && [c.args[0]].flat().some((k) => MARKS.has(k)))
    .map((c) => c.name);

test('Sicherung und Aktionen lesen die Vermerke gebündelt (#305)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await w.settle();
  let from = b.calls.length;
  await b.chrome.tabs.update(where(env, 'a1').tab.id, { url: url('a9') });
  await w.settle();
  assert.deepEqual(markReads(env, from).sort(), ['storage.local.get', 'storage.session.get']);
  assert.equal(b.local.data.backup[ids.A].shown[0].url, url('a9'));
  // Ein Klick im Popup auf den gezeigten Workspace
  from = b.calls.length;
  await ok(w.request({ type: 'show', windowId: win, wsId: ids.A }));
  assert.deepEqual(markReads(env, from).sort(), ['storage.local.get', 'storage.session.get']);
});
