'use strict';
// Ton aus Ablagen: Option „Ablagen stummschalten“ und Lautsprecher-Zeichen im Popup

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, where, shows } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Musik', color: 'blue' }, 'a3'],
    B: ['b1', 'b2'],
    C: ['c1'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

const tab = (env, name) => env.b.findTab(where(env, name).tab.id).t;
const muted = (env, name) => !!tab(env, name).mutedInfo?.muted;
const reason = (env, name) => tab(env, name).mutedInfo?.reason;
const play = (env, ...names) => names.forEach((n) => (tab(env, n).audible = true));
const switchTo = (env, name, windowId = env.win) => ok(env.w.request({ type: 'switch', windowId, wsId: env.ids[name] }));
const option = (env, on) => ok(env.w.request({ type: 'muteStash', on }));
const state = (env) => ok(env.w.request({ type: 'state', windowId: env.win }));
const muteCalls = (env) => env.b.calls.filter((c) => c.name === 'tabs.update' && c.args[1] && 'muted' in c.args[1]);

test('Ohne die Option schaltet der Wechsel nichts stumm', async () => {
  const env = await setup(SPEC);
  play(env, 'a1');
  await switchTo(env, 'B');
  assert.equal(where(env, 'a1').stash, true);
  assert.equal(muted(env, 'a1'), false);
  assert.deepEqual(muteCalls(env), []);
  assert.equal((await state(env)).muteStash, false);
});

test('Mit der Option sind Tabs in der Ablage stumm und bekommen beim Zurückholen ihren Ton wieder', async () => {
  const env = await setup(SPEC);
  await option(env, true);
  assert.equal((await state(env)).muteStash, true);
  // Schon beim Einschalten: die Tabs, die gerade in Ablagen liegen
  for (const n of ['b1', 'b2', 'c1']) assert.equal(muted(env, n), true, `${n} ist nicht stumm`);
  for (const n of ['a1', 'a2', 'a3', 'p1']) assert.equal(muted(env, n), false, `${n} ist stumm`);

  await switchTo(env, 'B');
  for (const n of ['a1', 'a2', 'a3', 'c1']) assert.equal(muted(env, n), true, `${n} ist nicht stumm`);
  for (const n of ['b1', 'b2', 'p1']) assert.equal(muted(env, n), false, `${n} ist stumm`);
  assert.equal(reason(env, 'a1'), 'extension');

  await switchTo(env, 'A');
  for (const n of ['a1', 'a2', 'a3', 'p1']) assert.equal(muted(env, n), false, `${n} ist stumm`);
  for (const n of ['b1', 'b2', 'c1']) assert.equal(muted(env, n), true, `${n} ist nicht stumm`);
  check(env, ALL);

  // Ausschalten gibt den Tabs in den Ablagen ihren Ton zurück
  await option(env, false);
  for (const n of ['a1', 'b1', 'b2', 'c1']) assert.equal(muted(env, n), false, `${n} ist stumm`);
  assert.deepEqual(env.b.local.data.stashMuted, []);
});

test('Von Hand stummgeschaltete Tabs bleiben stumm', async () => {
  const env = await setup(SPEC);
  await option(env, true);
  await env.b.chrome.tabs.update(where(env, 'a1').tab.id, { muted: true });
  await switchTo(env, 'B');
  await switchTo(env, 'A');
  assert.equal(muted(env, 'a1'), true);
  assert.equal(reason(env, 'a1'), 'user');
  assert.equal(muted(env, 'a3'), false);

  // In der Ablage von Hand wieder eingeschaltet und erneut stumm: bleibt stumm
  await switchTo(env, 'B');
  await env.b.chrome.tabs.update(where(env, 'a3').tab.id, { muted: false });
  await env.b.chrome.tabs.update(where(env, 'a3').tab.id, { muted: true });
  await switchTo(env, 'A');
  assert.equal(muted(env, 'a3'), true);
  assert.equal(muted(env, 'a2'), false);
});

test('Tab per Kontextmenü in einen Workspace ohne Fenster: stumm; über die Tab-Suche zurückgeholt: wieder laut', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await option(env, true);
  b.fire('contextMenus.onClicked', { menuItemId: `move:${ids.C}` }, where(env, 'a1').tab);
  await w.settle();
  assert.equal(where(env, 'a1').ws, ids.C);
  assert.equal(muted(env, 'a1'), true);

  const at = where(env, 'a1');
  await b.chrome.tabs.update(at.tab.id, { active: true });
  await b.chrome.windows.update(at.win.id, { focused: true });
  await w.settle();
  assert.equal(shows(env, win), 'C');
  assert.equal(muted(env, 'a1'), false);
  assert.equal(muted(env, 'c1'), false);
  assert.equal(muted(env, 'a2'), true);
});

test('Nach dem Neuladen der Erweiterung bekommen stummgeschaltete Tabs ihren Ton beim Zurückholen wieder', async () => {
  const env = await setup(SPEC);
  await option(env, true);
  await switchTo(env, 'B');
  assert.equal(muted(env, 'a1'), true);
  const w = env.b.reloadExtension();
  await w.settle();
  await switchTo(env, 'A');
  for (const n of ['a1', 'a2', 'a3']) assert.equal(muted(env, n), false, `${n} ist stumm`);
  assert.equal(muted(env, 'b1'), true);
});

test('Nach einem Browserstart sind die wiederhergestellten Ablagen wieder stumm', async () => {
  const env = await setup(SPEC);
  await option(env, true);
  env.b.restart();
  const w = env.b.startWorker('startup');
  await w.settle();
  check(env, ALL);
  for (const n of ['b1', 'b2', 'c1']) assert.equal(muted(env, n), true, `${n} ist nicht stumm`);
  for (const n of ['a1', 'p1']) assert.equal(muted(env, n), false, `${n} ist stumm`);
  const main = env.b.mains()[0].id;
  await switchTo(env, 'B', main);
  assert.equal(muted(env, 'b1'), false);
  assert.equal(muted(env, 'a1'), true);
});

test('Popup zeigt hörbare Workspaces an, Klick auf den Lautsprecher schaltet sie dauerhaft stumm', async () => {
  const env = await setup(SPEC);
  play(env, 'a2', 'b1', 'b2', 'p1');
  let st = await state(env);
  const audible = (s) => Object.fromEntries(s.workspaces.map((x) => [x.name, x.audible]));
  // Angeheftete Tabs gehören zu keinem Workspace
  assert.deepEqual(audible(st), { A: 1, B: 2, C: 0 });

  await ok(env.w.request({ type: 'mute', wsId: env.ids.B }));
  assert.equal(muted(env, 'b1'), true);
  assert.equal(muted(env, 'b2'), true);
  assert.equal(muted(env, 'a2'), false);
  st = await state(env);
  assert.deepEqual(audible(st), { A: 1, B: 0, C: 0 });

  // Auch mit der Option bleiben sie nach dem Zurückholen stumm
  await option(env, true);
  await switchTo(env, 'B');
  assert.equal(muted(env, 'b1'), true);
  assert.equal(muted(env, 'b2'), true);
  assert.deepEqual(audible(await state(env)), { A: 0, B: 0, C: 0 });

  // Der aktuelle Workspace lässt sich ebenso stummschalten, ohne dass es gleich zurückspringt
  await switchTo(env, 'A');
  assert.deepEqual(audible(await state(env)), { A: 1, B: 0, C: 0 });
  await ok(env.w.request({ type: 'mute', wsId: env.ids.A }));
  assert.equal(muted(env, 'a2'), true);
  assert.equal(muted(env, 'a1'), false);
  check(env, ALL);
});

test('Ein neuer Tab in einer Ablage ist gleich stumm, nicht erst bei der nächsten Aktion', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  await option(env, true);
  // Ein Tab der Ablage öffnet einen neuen, etwa über target=_blank
  const stashB = where(env, 'b1').win;
  b.createTab({ windowId: stashB.id, url: 'https://b3.test/', active: false });
  await w.settle();
  assert.equal(muted(env, 'b3'), true);
  assert.equal(reason(env, 'b3'), 'extension');

  // Ein Tab, den man in ein Ablage-Fenster zieht, ebenso
  const t = where(env, 'a3').tab;
  b.moveTab(b.findTab(t.id).t, b.findWin(win), b.findWin(where(env, 'c1').win.id));
  await w.settle();
  assert.equal(where(env, 'a3').stash, true);
  assert.equal(muted(env, 'a3'), true);

  // Ohne die Option bleibt ein neuer Tab in der Ablage laut
  await option(env, false);
  b.createTab({ windowId: stashB.id, url: 'https://b4.test/', active: false });
  await w.settle();
  assert.equal(muted(env, 'b4'), false);
  assert.equal(muted(env, 'b3'), false);
});
