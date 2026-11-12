'use strict';
// Serialisierung: schnell aufeinanderfolgende Wechsel, Bedienschritte und Tab-Ereignisse
// laufen nacheinander ab, und die Sicherung wird gebündelt, aber nicht ausgehungert.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, where, shows, tabIds } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [{ url: 'b1', group: 'Lesen', color: 'red' }, 'b2'],
    C: ['c1'],
    D: ['d1', 'd2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

test('serial() führt Aufgaben nacheinander aus, auch wenn eine davon scheitert', async () => {
  const env = await setup(SPEC);
  const { w } = env;
  const log = [];
  const task = (name, fail) => async () => {
    log.push(`${name}+`);
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    log.push(`${name}-`);
    if (fail) throw new Error(name);
    return name;
  };
  const serial = w.eval('serial');
  const results = await Promise.allSettled([serial(task('1')), serial(task('2', true)), serial(task('3'))]);
  assert.deepEqual(log, ['1+', '1-', '2+', '2-', '3+', '3-']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[2].value, '3');
});

test('Viele Wechsel ohne Warten: alle werden der Reihe nach ausgeführt', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const before = tabIds(env);
  const order = ['B', 'C', 'A', 'D', 'B', 'B', 'C', 'A', 'D'];
  const replies = order.map((n) => w.send({ type: 'switch', windowId: win, wsId: ids[n] }));
  // Tastenkürzel mitten hinein
  b.fire('commands.onCommand', 'next-workspace', { windowId: win });
  b.fire('commands.onCommand', 'prev-workspace', { windowId: win });
  b.fire('commands.onCommand', 'prev-workspace', { windowId: win });
  await w.settle();
  for (const r of await Promise.all(replies)) assert.equal(r.ok, true, r.error);
  // D, dann nächster (A), vorheriger (D), vorheriger (C)
  assert.equal(shows(env, win), 'C');
  check(env, ALL);
  assert.deepEqual(tabIds(env), before, 'Tabs wurden neu angelegt');
});

test('Gleichzeitige Wechsel in zwei Fenstern vermischen keine Tabs', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const win2 = (await b.chrome.windows.create({ focused: true })).id;
  await w.settle();
  const replies = [];
  for (const [x, y] of [['B', 'C'], ['D', 'A'], ['C', 'B'], ['A', 'D']]) {
    replies.push(w.send({ type: 'switch', windowId: win, wsId: ids[x] }));
    replies.push(w.send({ type: 'switch', windowId: win2, wsId: ids[y] }));
  }
  await w.settle();
  for (const r of await Promise.all(replies)) assert.equal(r.ok, true, r.error);
  assert.equal(shows(env, win), 'A');
  assert.equal(shows(env, win2), 'D');
  assert.equal(where(env, 'a1').win.id, win);
  assert.equal(where(env, 'd1').win.id, win2);
  check(env, ALL);
});

test('Bedienschritte und Tab-Änderungen mitten in schnellen Wechseln', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const replies = [];
  const created = [];
  // x1 entsteht, während der Wechsel A → B die alten Tabs wegräumt, x2 ebenso bei B → C
  const into = (name) => env.b.windows.find((x) => b.stashOf(x) === ids[name]).id;
  const stashA = into('A');
  const stashB = into('B');
  const open = (u, active) => () => created.push(b.chrome.tabs.create({ windowId: win, url: url(u), active }));
  const moving = (id) => (_, o) => o?.windowId === id;
  const h1 = b.during('tabs.move', open('x1', false), { when: moving(stashA) });
  const h2 = b.during('tabs.move', open('x2', true), { when: moving(stashB) });
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.B }));
  replies.push(w.send({ type: 'moveTab', tabId: where(env, 'a1').tab.id, wsId: ids.C }));
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.C }));
  replies.push(w.send({ type: 'create', name: 'E' }));
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.D }));
  replies.push(w.send({ type: 'reorder', ids: [ids.D, ids.C, ids.B, ids.A] }));
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.A }));
  await w.settle();
  assert.equal(h1.hits + h2.hits, 2, 'Bedienschritte liefen nicht mitten im Wechsel');
  await Promise.all(created);
  const res = await Promise.all(replies);
  for (const r of res) assert.equal(r.ok, true, r.error);
  env.ids.E = res[3].result.id;
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['D', 'C', 'B', 'A', 'E']);

  // Ein mitten im Wechsel geöffneter Tab gehört zum alten oder zum neuen Workspace, nie zu
  // einem anderen. a1 liegt beim Verschieben schon in der Ablage von A (der Wechsel nach B
  // lief vorher) und bleibt deshalb dort. Die Sicherung muss jeweils dazu passen.
  const allowed = { a1: ['A'], x1: ['A', 'B'], x2: ['B', 'C'] };
  const expected = { ...ALL, A: SPEC.workspaces.A.slice(1), E: [] };
  for (const [x, ok] of Object.entries(allowed)) {
    const name = Object.keys(env.ids).find((n) => env.ids[n] === where(env, x).ws);
    assert.ok(ok.includes(name), `${x} steht in ${name}, erlaubt sind ${ok.join(', ')}`);
    expected[name] = [...expected[name], x];
  }
  check(env, expected);
});

test('Tab verschieben direkt nach dem Löschen des Ziels: der Workspace bleibt gelöscht', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const tab = where(env, 'a1').tab;
  const replies = [w.send({ type: 'delete', wsId: ids.C }), w.send({ type: 'moveTab', tabId: tab.id, wsId: ids.C })];
  // dasselbe über das Kontextmenü, dessen Eintrag beim Klick noch sichtbar war
  b.fire('contextMenus.onClicked', { menuItemId: `move:${ids.C}` }, tab);
  await w.settle();
  for (const r of await Promise.all(replies)) assert.equal(r.ok, true, r.error);
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['A', 'B', 'D']);
  assert.ok(!b.windows.some((x) => b.stashOf(x) === ids.C), 'Ablage für den gelöschten Workspace angelegt');
  assert.equal(where(env, 'a1').ws, ids.A);
  delete env.ids.C;
  const { C, ...rest } = ALL;
  check(env, rest, { allowNewTab: false });
});

test('Sicherung: viele Änderungen werden gebündelt', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const snapshots = () => b.calls.filter((c) => c.name === 'storage.local.set' && 'backupWindows' in c.args[0]).length;
  const n = snapshots();
  for (let i = 0; i < 10; i++) await b.chrome.tabs.create({ windowId: win, url: url(`y${i}`), active: false });
  await w.settle();
  assert.equal(snapshots() - n, 1, 'zehn schnelle Änderungen sollten eine Sicherung ergeben');
  check(env, { ...ALL, A: [...SPEC.workspaces.A, ...Array.from({ length: 10 }, (_, i) => `y${i}`)] });
});

test('Sicherung: bei Dauerfeuer spätestens nach zwei Sekunden', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const saved = (u) => (b.local.data.backup[env.ids.A].shown || []).some((e) => e.url === url(u));
  const t0 = b.now;
  let seenAt = null;
  for (let i = 0; i < 24; i++) {
    await b.chrome.tabs.create({ windowId: win, url: url(`z${i}`), active: false });
    await w.advance(250);
    if (seenAt === null && saved('z0')) seenAt = b.now - t0;
  }
  assert.ok(seenAt !== null && seenAt <= 2250, `erste Änderung erst nach ${seenAt} ms gesichert`);
  await w.settle();
  check(env, { ...ALL, A: [...SPEC.workspaces.A, ...Array.from({ length: 24 }, (_, i) => `z${i}`)] });
});
