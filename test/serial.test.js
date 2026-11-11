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
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.B }));
  created.push(b.chrome.tabs.create({ windowId: win, url: url('x1'), active: false }));
  replies.push(w.send({ type: 'moveTab', tabId: where(env, 'a1').tab.id, wsId: ids.C }));
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.C }));
  created.push(b.chrome.tabs.create({ windowId: win, url: url('x2'), active: true }));
  replies.push(w.send({ type: 'create', name: 'E' }));
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.D }));
  replies.push(w.send({ type: 'reorder', ids: [ids.D, ids.C, ids.B, ids.A] }));
  replies.push(w.send({ type: 'switch', windowId: win, wsId: ids.A }));
  await w.settle();
  await Promise.all(created);
  const res = await Promise.all(replies);
  for (const r of res) assert.equal(r.ok, true, r.error);
  env.ids.E = res[3].result.id;
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['D', 'C', 'B', 'A', 'E']);

  // Wohin die neuen Tabs kamen, hängt vom Zeitpunkt ab (a1 liegt beim Verschieben schon in
  // der Ablage und bleibt dann in A); jeder muss aber genau einmal in genau einem Workspace
  // stehen, und die Sicherung muss dazu passen.
  const expected = { ...ALL, A: SPEC.workspaces.A.slice(1), E: [] };
  for (const x of ['a1', 'x1', 'x2']) {
    const name = Object.keys(env.ids).find((n) => env.ids[n] === where(env, x).ws);
    assert.ok(name, `${x} steht in keinem Workspace`);
    expected[name] = [...expected[name], x];
  }
  check(env, expected);
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
