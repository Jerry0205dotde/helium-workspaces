'use strict';
// Entladen: Ablagen nach einer einstellbaren Zeit, aus der Sicherung angelegte Tabs nach
// dem ersten Laden. Entladene Tabs bekommen eine neue ID, die gemerkten IDs ziehen nach.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, where, shows } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    B: ['b1', 'b2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };
const MIN = 60000;

const discarded = (env, names) => names.map((n) => !!where(env, n).tab.discarded);
const discards = (b) => b.calls.filter((c) => c.name === 'tabs.discard').length;

test('Ohne Einstellung bleiben die Tabs der Ablagen geladen', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(180 * MIN);
  assert.equal(b.alarms.size, 0);
  assert.equal(discards(b), 0);
  assert.equal((await ok(w.request({ type: 'state', windowId: win }))).unloadAfter, 0);
});

test('Ablagen werden nach der eingestellten Zeit entladen, Gruppen, Sicherung und zuletzt aktiver Tab bleiben', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 15 }));
  assert.equal((await ok(w.request({ type: 'state', windowId: win }))).unloadAfter, 15);
  await b.chrome.tabs.update(where(env, 'a3').tab.id, { active: true });
  await w.settle();
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));

  await w.advance(14 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a2', 'a3', 'a4']), [false, false, false, false], 'zu früh entladen');
  await w.advance(2 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a2', 'a3', 'a4']), [true, true, true, true]);
  assert.deepEqual(discarded(env, ['b1', 'b2']), [false, false], 'gezeigter Workspace wurde entladen');
  check(env, ALL);
  // Die Ablage-Fenster sind mit den neuen IDs gesichert (für das Neuladen der Erweiterung)
  const rec = Object.values(b.local.data.stashWins).find((x) => x.ws === ids.A);
  assert.deepEqual(rec.tabs.sort(), ['a1', 'a2', 'a3', 'a4'].map((n) => where(env, n).tab.id).sort());

  // Zurück: der zuletzt aktive Tab ist wieder aktiv und lädt neu
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  assert.equal(where(env, 'a3').tab.active, true);
  assert.equal(!!where(env, 'a3').tab.discarded, false);
  check(env, ALL);

  // Erneut weggewechselt, beginnt die Zeit von vorn
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(5 * MIN);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  await w.advance(14 * MIN);
  assert.deepEqual(discarded(env, ['b1', 'b2']), [false, false]);
  await w.advance(2 * MIN);
  assert.deepEqual(discarded(env, ['b1', 'b2']), [true, true]);
  check(env, ALL);
});

test('Ein Tab, der Ton abspielt, bleibt in der Ablage geladen', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  b.findTab(where(env, 'a4').tab.id).t.audible = true;
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(10 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a4']), [true, false]);
});

test('Ein Tab, der kurz still ist, bleibt geladen, bis er so lange still ist wie eingestellt (#154)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  // a4: Videocall, in dem gerade niemand spricht. a3: still, aber stummgeschaltet.
  b.setAudible(where(env, 'a4').tab.id, true);
  b.setAudible(where(env, 'a3').tab.id, true);
  await b.chrome.tabs.update(where(env, 'a3').tab.id, { muted: true });
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(3 * MIN);
  b.setAudible(where(env, 'a4').tab.id, false);
  b.setAudible(where(env, 'a3').tab.id, false);
  await w.advance(3 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a3', 'a4']), [true, true, false], 'kurz stiller Tab wurde entladen');
  // Spricht wieder jemand, beginnt die stille Zeit von vorn
  b.setAudible(where(env, 'a4').tab.id, true);
  await w.advance(1 * MIN);
  b.setAudible(where(env, 'a4').tab.id, false);
  await w.advance(4 * MIN);
  assert.deepEqual(discarded(env, ['a4']), [false]);
  await w.advance(2 * MIN);
  assert.deepEqual(discarded(env, ['a4']), [true]);
  assert.deepEqual(b.session.data.silentSince, {}, 'alte Zeitpunkte bleiben liegen');
  check(env, ALL);
});

test('Wird ein Tab still, während der Wecker die Ablagen schon prüft, bleibt er geladen (#154)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  b.setAudible(where(env, 'a4').tab.id, true);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(4 * MIN);
  b.during('windows.getAll', () => b.setAudible(where(env, 'a4').tab.id, false));
  await w.advance(1 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a4']), [true, false], 'gerade still gewordener Tab wurde entladen');
  check(env, ALL);
});

test('Ausschalten stoppt das Entladen, nur angebotene Zeiten werden angenommen', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const r = await w.request({ type: 'unloadAfter', minutes: 7 });
  assert.equal(r.ok, false);
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  assert.ok(b.alarms.has('unload'));
  await ok(w.request({ type: 'unloadAfter', minutes: 0 }));
  assert.equal(b.alarms.size, 0);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(60 * MIN);
  assert.equal(discards(b), 0);
});

test('Nach einem Browserstart richtet der Service Worker den Wecker wieder ein', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  b.restart();
  assert.equal(b.alarms.size, 0);
  const w2 = b.startWorker('startup');
  await w2.settle();
  assert.ok(b.alarms.has('unload'));
  // Ablage ohne Zeitpunkt (storage.session ist leer) zählt ab dem ersten Wecker
  await w2.advance(4 * MIN);
  assert.deepEqual(discarded(env, ['a1']), [false]);
  await w2.advance(3 * MIN);
  assert.deepEqual(discarded(env, ['a1']), [true]);
  check(env, ALL);
});

test('Aus der Sicherung angelegte Tabs werden nach dem Laden entladen, der aktive nicht', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  // Start ohne Sitzungswiederherstellung: A kommt beim Start, B beim Wechsel aus der Sicherung
  b.restart({ restore: 'none' });
  const w = b.startWorker('startup');
  await w.settle();
  check(env, ALL);
  const main = b.mains()[0].id;
  assert.equal(shows(env, main), 'A');
  const active = ['a1', 'a2', 'a3', 'a4'].filter((n) => where(env, n).tab.active);
  assert.equal(active.length, 1);
  for (const n of ['a1', 'a2', 'a3', 'a4']) assert.equal(!!where(env, n).tab.discarded, !active.includes(n), n);
  assert.equal(!!where(env, 'p1').tab.discarded, false, 'angehefteter Tab wurde entladen');

  await ok(w.request({ type: 'switch', windowId: main, wsId: env.ids.B }));
  await w.settle();
  assert.deepEqual(discarded(env, ['b1', 'b2']), [false, true]);
  assert.equal(where(env, 'b1').tab.active, true);
  check(env, ALL);
});

test('Neustart des Service Workers zwischen Anlegen aus der Sicherung und Laden: die Tabs werden trotzdem entladen (#125)', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  b.restart({ restore: 'none' });
  b.holdLoads = true;
  let w = b.startWorker('startup');
  await w.settle();
  check(env, ALL);
  assert.equal(discards(b), 0);
  // Der Worker wird wegen Untätigkeit beendet, bevor die Tabs fertig geladen haben
  w = b.startWorker(null);
  await w.settle();
  b.releaseLoads();
  await w.settle();
  const active = ['a1', 'a2', 'a3', 'a4'].filter((n) => where(env, n).tab.active);
  assert.equal(active.length, 1);
  for (const n of ['a1', 'a2', 'a3', 'a4']) assert.equal(!!where(env, n).tab.discarded, !active.includes(n), n);
  assert.equal(!!where(env, 'p1').tab.discarded, false, 'angehefteter Tab wurde entladen');
  assert.equal(b.session.data.unloadLater, undefined, 'die Liste ist nach dem Entladen nicht leer');
  check(env, ALL);
});

test('Neue ID durch Entladen: ein unterbrochener Wechsel kennt den Tab weiterhin als alten Tab', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const id = where(env, 'a1').tab.id;
  await b.chrome.storage.session.set({ pendingSwitch: { windowId: win, from: env.ids.A, to: env.ids.B, oldTabs: [id, 999] } });
  await b.chrome.tabs.discard(id);
  await w.settle();
  assert.deepEqual(b.session.data.pendingSwitch?.oldTabs, [where(env, 'a1').tab.id, 999]);
  assert.notEqual(where(env, 'a1').tab.id, id);
});

test('Mit „Ablagen stummschalten“: stumme Tabs werden entladen, bleiben stumm und bekommen beim Zurückholen ihren Ton wieder', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'muteStash', on: true }));
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  b.findTab(where(env, 'a1').tab.id).t.audible = true;
  // a4 von Hand stummgeschaltet: bleibt es auch nach dem Entladen und Zurückholen
  await b.chrome.tabs.update(where(env, 'a4').tab.id, { muted: true });
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(6 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a4']), [true, true], 'stummer Tab mit Ton wurde nicht entladen');
  const muted = (n) => !!b.findTab(where(env, n).tab.id).t.mutedInfo?.muted;
  assert.deepEqual([muted('a1'), muted('a4')], [true, true], 'Entladen hob die Stummschaltung auf');
  assert.ok(b.local.data.stashMuted.includes(where(env, 'a1').tab.id), 'stashMuted kennt die neue ID nicht');

  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  assert.deepEqual([muted('a1'), muted('a4')], [false, true]);
  check(env, ALL);
});

test('Wechsel, der während des Entladens wartet, kennt schon die neuen IDs: Ton und zuletzt aktiver Tab stimmen', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'muteStash', on: true }));
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await b.chrome.tabs.update(where(env, 'a3').tab.id, { active: true });
  await w.settle();
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  // Klick auf A, genau während der Wecker die Ablage entlädt
  let reply = null;
  b.during('tabs.discard', () => w.send({ type: 'switch', windowId: win, wsId: ids.A }).then((r) => (reply = r)));
  await w.advance(6 * MIN);
  assert.equal(reply?.ok, true);
  assert.equal(shows(env, win), 'A');
  const muted = (n) => !!b.findTab(where(env, n).tab.id).t.mutedInfo?.muted;
  assert.deepEqual(['a1', 'a2', 'a3', 'a4'].map(muted), [false, false, false, false], 'Tabs bleiben nach dem Zurückholen stumm');
  assert.equal(where(env, 'a3').tab.active, true, 'zuletzt aktiver Tab ist nicht aktiv');
  check(env, ALL);
});
