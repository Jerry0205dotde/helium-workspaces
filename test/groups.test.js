'use strict';
// Gespeicherte Tab-Gruppen (#218): Chromium behält eine Gruppe, deren Tabs geschlossen
// werden, unter Menü → Tabgruppen. Schließt die Erweiterung Tabs, die sie später aus der
// Sicherung samt Gruppe neu anlegt, hebt sie die Gruppe vorher auf, sonst stünde sie dort
// bei jedem Neuanlegen ein weiteres Mal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [{ url: 'b1', group: 'Lesen', color: 'red' }, 'b2'],
    C: ['c1', 'c2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

const closed = (b) => b.closedGroups.map((g) => g.title);

async function cycle(env, names) {
  const main = env.b.mains()[0].id;
  for (const name of names) await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids[name] }));
}

test('Ersetzen durch den eigenen Export: keine Gruppe bleibt als geschlossene gespeicherte Gruppe zurück (#218)', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  const file = await ok(env.w.request({ type: 'export' }));
  await ok(env.w.request({ type: 'import', text: JSON.stringify(file), mode: 'replace', confirmed: true }));
  for (const w of b.local.data.workspaces) env.ids[w.name] = w.id;
  // Lesen lag in der Ablage von B und kommt beim Wechsel aus der Sicherung
  await cycle(env, ['B', 'C', 'A']);
  check(env, ALL);
  assert.deepEqual(closed(b), []);
});

test('Workspace löschen und zurückholen: seine Gruppe bleibt nicht als gespeicherte Gruppe zurück (#218)', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  await ok(w.request({ type: 'delete', wsId: ids.B }));
  assert.deepEqual(closed(b), []);
  await ok(w.request({ type: 'undoDelete' }));
  await cycle(env, ['B', 'A']);
  check(env, ALL);
  assert.deepEqual(closed(b), []);
});

test('Letztes Fenster per X: nur die Ablage, die Chromium wiederherstellt, behält ihre Gruppen (#218)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  // C wird gezeigt, davor B: Die Ablage von B schließt zuletzt, Chromium stellt sie samt
  // Gruppe wieder her. Mathe in der Ablage von A kommt aus der Sicherung.
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.C }));
  await b.closeWindowByX(win);
  await w.settle();
  assert.equal(b.windows.length, 0, 'Ablage-Fenster wurden nicht geschlossen');
  assert.deepEqual(closed(b), ['Lesen']);

  b.restart();
  const w2 = b.startWorker('startup');
  await w2.settle();
  await cycle(env, ['A', 'B', 'C']);
  check(env, ALL);
  assert.deepEqual(closed(b), ['Lesen']);
});
