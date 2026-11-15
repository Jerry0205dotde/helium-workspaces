'use strict';
// Frühere Stände (#189): Beim Browserstart hebt die Erweiterung den gesicherten Stand auf,
// bevor der erste Snapshot ihn überschreibt, und spielt ihn auf Wunsch wie eine Datei ein.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: ['b1', 'b2'],
    C: ['c1'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };
const plain = (v) => JSON.parse(JSON.stringify(v));

async function restart(env) {
  env.b.restart();
  await env.b.startWorker('startup').settle();
}

// Schließt im Hauptfenster die Tabs von A, wie nach einem Start, der sie falsch zuordnet
async function loseA(env) {
  const main = env.b.mains()[0].id;
  for (const t of await env.b.chrome.tabs.query({ windowId: main })) {
    if (!t.pinned && /^https:\/\/a\d/.test(t.url)) await env.b.chrome.tabs.remove(t.id);
  }
  await env.w.settle();
}

test('Der Browserstart hebt den Stand vor dem ersten Snapshot auf, gleiche Stände nur einmal, höchstens drei', async () => {
  const env = await setup(SPEC);
  const before = plain({ workspaces: env.b.local.data.workspaces, backup: env.b.local.data.backup, backupPinned: env.b.local.data.backupPinned });
  assert.equal(env.b.local.data.earlier, undefined, 'ohne Browserstart gibt es noch keinen früheren Stand');
  await restart(env);
  const [first, ...rest] = env.b.local.data.earlier;
  assert.deepEqual(rest, []);
  const { at, ...state } = plain(first);
  assert.equal(typeof at, 'number');
  assert.deepEqual(state, before);

  // Unveränderter Stand: kein zweiter Eintrag
  await restart(env);
  assert.equal(env.b.local.data.earlier.length, 1);

  // Jede Änderung ergibt einen neuen Eintrag vorn, die ältesten fallen weg
  for (const name of ['x1', 'x2', 'x3']) {
    await env.b.chrome.tabs.create({ windowId: env.b.mains()[0].id, url: url(name), active: false });
    await env.w.settle();
    await restart(env);
  }
  const earlier = env.b.local.data.earlier;
  assert.equal(earlier.length, 3);
  const urls = (e) => Object.values(e.backup).flatMap((b) => [...(b.shown || []), ...(b.stash || [])].map((t) => t.url));
  assert.ok(urls(earlier[0]).includes(url('x3')));
  assert.ok(!urls(earlier[2]).includes(url('x2')) && urls(earlier[2]).includes(url('x1')));
  assert.ok(earlier[0].at >= earlier[1].at && earlier[1].at >= earlier[2].at);
});

test('Ein früherer Stand lässt sich nach einem verlorenen Workspace wiederherstellen und rückgängig machen', async () => {
  const env = await setup(SPEC);
  await restart(env);
  await loseA(env);
  assert.deepEqual(env.b.local.data.backup[env.ids.A].shown, [], 'die Sicherung von A ist überschrieben');

  const list = plain(await ok(env.w.request({ type: 'earlier' })));
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], at: 0 }, { at: 0, workspaces: 3, tabs: 6, pinned: 1 });

  const text = await ok(env.w.request({ type: 'earlierText', at: list[0].at }));
  const file = JSON.parse(text);
  assert.equal(file.exported, new Date(list[0].at).toISOString());
  assert.equal(file.settings, undefined, 'ein früherer Stand ändert keine Einstellungen');
  const preview = plain(await ok(env.w.request({ type: 'importPreview', text })));
  assert.deepEqual(preview.workspaces.map((w) => [w.name, w.tabs, w.groups]), [['A', 3, 1], ['B', 2, 0], ['C', 1, 0]]);

  await ok(env.w.request({ type: 'import', text, mode: 'replace', confirmed: true }));
  const main = env.b.mains()[0].id;
  // Dieselben IDs: Die Sicherung gilt wieder für A, B und C
  assert.deepEqual(env.b.local.data.workspaces.map((w) => w.name), ['A', 'B', 'C']);
  check({ ...env, ids: Object.fromEntries(env.b.local.data.workspaces.map((w) => [w.name, w.id])) }, ALL);
  const state = plain(await ok(env.w.request({ type: 'state', windowId: main })));
  assert.deepEqual(state.deleted, ['A', 'B', 'C'], 'Rückgängig fehlt');

  // Ein nicht mehr vorhandener Stand wird abgelehnt
  const r = await env.w.request({ type: 'earlierText', at: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /gibt es nicht mehr/);
});
