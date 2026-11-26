'use strict';
// Entladen: Ablagen nach einer einstellbaren Zeit, aus der Sicherung angelegte Tabs nach
// dem ersten Laden. Entladene Tabs bekommen eine neue ID, die gemerkten IDs ziehen nach.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, where, shows } = require('./harness');

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

test('Bleibt der entladene Tab beim Wechsel über das Popup entladen, lädt die Erweiterung ihn (#217)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await b.chrome.tabs.update(where(env, 'a3').tab.id, { active: true });
  await w.settle();
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(6 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a2', 'a3', 'a4']), [true, true, true, true]);

  b.popupOpen = true;
  await ok(w.request({ type: 'show', windowId: win, wsId: ids.A }));
  assert.equal(where(env, 'a3').tab.active, true);
  assert.deepEqual(discarded(env, ['a1', 'a2', 'a3', 'a4']), [true, true, false, true], 'nur der aktive Tab lädt');
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

test('Ein Tab, der später in eine ältere Ablage kommt, zählt ab seinem Ankommen (#291)', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(3 * MIN);
  // Die Ablage von A liegt seit 3 Minuten: b2 dorthin verschieben, einen Link dort öffnen
  await ok(w.request({ type: 'moveTab', tabId: where(env, 'b2').tab.id, wsId: ids.A }));
  b.fire('contextMenus.onClicked', { menuItemId: `link:${ids.A}`, linkUrl: url('l1'), pageUrl: url('b1') }, where(env, 'b1').tab);
  await w.settle();
  assert.equal(where(env, 'b2').stash, true);
  assert.equal(where(env, 'l1').stash, true);
  const NEW = { ...ALL, A: [...ALL.A, 'b2', 'l1'], B: ['b1'] };
  await w.advance(3 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a4']), [true, true]);
  assert.deepEqual(discarded(env, ['b2', 'l1']), [false, false], 'gerade dazugekommener Tab wurde entladen');
  await w.advance(3 * MIN);
  assert.deepEqual(discarded(env, ['b2', 'l1']), [true, true]);
  await w.advance(1 * MIN);
  assert.deepEqual(b.session.data.arrivedAt, {}, 'alte Zeitpunkte bleiben liegen');
  check(env, NEW);
});

test('Vor dem Laden geschlossene Tabs aus der Sicherung bleiben nicht auf der Liste zum Entladen (#291)', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  b.restart({ restore: 'none' });
  b.holdLoads = true;
  let w = b.startWorker('startup');
  await w.settle();
  const closed = ['a1', 'a2', 'a3', 'a4'].map((n) => where(env, n).tab).find((t) => !t.active).id;
  assert.ok(b.session.data.unloadLater.includes(closed));
  await b.chrome.tabs.remove(closed);
  await w.settle();
  assert.equal(b.session.data.unloadLater.includes(closed), false, 'geschlossener Tab steht noch auf der Liste');
  b.releaseLoads();
  await w.settle();
  assert.equal(b.session.data.unloadLater, undefined, 'die Liste ist nach dem Entladen nicht leer');
});

test('Ein Tab auf der Liste zum Entladen, den es nicht mehr gibt, zählt beim Nachlegen nicht mehr und fällt weg (#291)', async () => {
  const many = Array.from({ length: 9 }, (_, i) => `m${i}`);
  const env = await setup({ workspaces: { A: ['a1'], B: many } });
  const { b } = env;
  b.restart({ restore: 'none' });
  let w = b.startWorker('startup');
  await w.settle();
  // Ein Eintrag, den onRemoved nicht streichen konnte (etwa eine von Chromium beim
  // Entladen ersetzte ID), übersteht den Neustart des Service Workers
  await b.chrome.storage.session.set({ unloadLater: [999] });
  w = b.startWorker(null);
  await w.settle();
  // B entsteht aus der Sicherung und wird in Schüben angelegt
  b.holdLoads = true;
  await ok(w.request({ type: 'switch', windowId: b.mains()[0].id, wsId: env.ids.B }));
  b.releaseLoads();
  await w.settle();
  check(env, { A: ['a1'], B: many });
  assert.equal(b.session.data.unloadLater, undefined, 'die Liste ist nach dem Entladen nicht leer');
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

// Je entladenem Tab zog tabs.onReplaced die neue ID ein zweites Mal nach und baute das Abbild
// der Fenster neu auf; mit 76 Tabs stand die Warteschlange über 300 ms (#302)
test('Entladen einer großen Ablage zieht jede neue ID einmal nach und liest die Fenster nicht je Tab', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
  const env = await setup({ workspaces: { A: many, B: ['b1'] } });
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await w.advance(4 * MIN);
  const before = b.calls.length;
  await w.advance(2 * MIN);
  const calls = b.calls.slice(before);
  const count = (name) => calls.filter((c) => c.name === name).length;
  assert.equal(count('tabs.discard'), 30, 'nicht alle Tabs der Ablage entladen');
  // Je Gruppe von UNLOAD_BATCH Tabs ein Blick auf die Fenster und einer für die Sicherung
  assert.ok(count('windows.getAll') <= 10, `windows.getAll ${count('windows.getAll')}×`);
  assert.ok(count('storage.session.set') <= 10, `storage.session.set ${count('storage.session.set')}×`);
  assert.ok(count('storage.session.get') <= 30 + 20, `storage.session.get ${count('storage.session.get')}×`);
  check(env, { A: many, B: ['b1'] });
  const rec = Object.values(b.local.data.stashWins).find((x) => x.ws === ids.A);
  assert.deepEqual(rec.tabs.sort(), many.map((n) => where(env, n).tab.id).sort());
});

test('Ein Wechsel, während eine große Ablage entladen wird, wartet nur auf eine Gruppe von Tabs (#302)', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
  const env = await setup({ workspaces: { A: many, B: ['b1'] } });
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  let reply = null;
  b.during('tabs.discard', () => w.send({ type: 'switch', windowId: win, wsId: ids.A }).then((r) => (reply = r)));
  await w.advance(6 * MIN);
  assert.equal(reply?.ok, true);
  assert.equal(shows(env, win), 'A');
  assert.equal(discards(b), 10, 'der Wechsel wartete auf alle Tabs der Ablage');
  check(env, { A: many, B: ['b1'] });
});

test('Scheitert das Nachziehen der neuen ID beim Entladen, holt tabs.onReplaced es nach', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'unloadAfter', minutes: 5 }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  // Der erste Blick von replaceTabId in storage.session scheitert
  b.fail('storage.session.get', { when: (keys) => Array.isArray(keys) && keys.includes('startFed') });
  await w.advance(6 * MIN);
  assert.deepEqual(discarded(env, ['a1', 'a2', 'a3', 'a4']), [true, true, true, true]);
  const rec = Object.values(b.local.data.stashWins).find((x) => x.ws === ids.A);
  assert.deepEqual(rec.tabs.sort(), ['a1', 'a2', 'a3', 'a4'].map((n) => where(env, n).tab.id).sort());
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
