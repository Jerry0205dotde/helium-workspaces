'use strict';
// Automatische Sicherung als Datei: Abstand, die letzten zehn, Fehler, und dass sich die
// Datei nach dem Entfernen der Erweiterung in ein neues Profil importieren lässt

const test = require('node:test');
const assert = require('node:assert/strict');
const { Browser, NEWTAB, DOWNLOADS } = require('./fake-browser');
const { setup, check, ok, shows } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: ['b1', 'b2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };
const HOUR = 3600000;
const DAY = 24 * HOUR;

const plain = (v) => JSON.parse(JSON.stringify(v));
const files = (b) => b.filesIn('helium-workspaces');
const autoState = async (w) => plain(await ok(w.request({ type: 'autoBackupState' })));
const enable = async (w, days) => plain(await ok(w.request({ type: 'autoBackup', days })));

test('Ohne Einstellung entsteht keine Datei und kein Wecker', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  await w.advance(10 * DAY);
  assert.equal(b.alarms.has('autoBackup'), false);
  assert.deepEqual(files(b), []);
  assert.equal(b.calls.filter((c) => c.name.startsWith('downloads.')).length, 0);
  const s = await autoState(w);
  assert.equal(s.days, 0);
  assert.equal(s.last, null);
});

test('Täglich: Einschalten sichert sofort, danach einmal am Tag, die Datei ist ein vollständiger Export', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  const s = await enable(w, 1);
  assert.equal(files(b).length, 1);
  const [first] = files(b);
  assert.match(first, new RegExp(`^${DOWNLOADS}helium-workspaces/helium-workspaces-auto-\\d{4}-\\d\\d-\\d\\d_\\d\\d-\\d\\d\\.json$`));
  assert.deepEqual(s.last, { at: b.now, file: first, state: 'complete' });
  assert.equal(s.error, null);

  // Dieselbe Datei wie „Als Datei speichern“, bis auf den Zeitpunkt
  const data = JSON.parse(b.files.get(first));
  const manual = plain(await ok(w.request({ type: 'export' })));
  assert.deepEqual({ ...data, exported: '' }, { ...manual, exported: '' });
  assert.deepEqual(data.workspaces.map((x) => x.name), ['A', 'B']);
  assert.equal(data.workspaces[0].tabs.length, 3);
  assert.equal(data.pinned.length, 1);

  // Der Wecker prüft stündlich, gesichert wird erst nach einem Tag
  assert.equal(b.alarms.get('autoBackup').periodInMinutes, 60);
  await w.advance(22 * HOUR);
  assert.equal(files(b).length, 1);
  await w.advance(2 * HOUR + 5 * 60000);
  assert.equal(files(b).length, 2);
  await w.advance(DAY);
  assert.equal(files(b).length, 3);
  check(env, ALL);
});

test('Wöchentlich: erst nach sieben Tagen wieder, auch über einen Browserneustart', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  await enable(env.w, 7);
  assert.equal(files(b).length, 1);
  await env.w.advance(3 * DAY);
  // Nach dem Neustart sind die Wecker weg, der Service Worker stellt seinen wieder
  b.restart();
  await b.startWorker('startup').settle();
  assert.ok(b.alarms.has('autoBackup'));
  await env.w.advance(3 * DAY);
  assert.equal(files(b).length, 1);
  await env.w.advance(DAY + HOUR);
  assert.equal(files(b).length, 2);
});

test('Ausschalten stoppt den Wecker, ungültige Abstände werden abgelehnt', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  await enable(w, 1);
  const r = await w.request({ type: 'autoBackup', days: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Unbekannter Abstand/);
  assert.equal((await autoState(w)).days, 1);
  await enable(w, 0);
  assert.equal(b.alarms.has('autoBackup'), false);
  await w.advance(3 * DAY);
  assert.equal(files(b).length, 1);
});

test('Die letzten zehn bleiben, eigene Dateien im Ordner rührt sie nicht an', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  // Ein Export von Hand im selben Ordner mit ähnlichem Namen
  await b.chrome.downloads.download({ url: `data:application/json;base64,${btoa('{}')}`, filename: 'helium-workspaces/helium-workspaces-auto-meins.json' });
  const mine = `${DOWNLOADS}helium-workspaces/helium-workspaces-auto-meins.json`;
  await enable(w, 1);
  const first = files(b).filter((f) => f !== mine);
  for (let i = 0; i < 12; i++) await w.advance(DAY);
  const auto = files(b).filter((f) => f !== mine);
  assert.equal(auto.length, 10);
  assert.ok(!auto.includes(first[0]), 'die älteste ist noch da');
  assert.ok(files(b).includes(mine), 'die eigene Datei wurde gelöscht');
  // Gelöschte verschwinden auch aus dem Download-Verlauf
  assert.equal(b.downloads.filter((d) => d.byExtensionId).length, 10);
});

test('Gescheiterte Sicherung: Hinweis im Popup, der nächste Erfolg nimmt ihn weg', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  // Der Download startet und bricht ab (z. B. voller Datenträger)
  b.downloadMode = 'interrupt';
  const s = await enable(w, 1);
  assert.equal(s.last.state, 'interrupted');
  assert.match(s.error.message, /Download abgebrochen \(FILE_NO_SPACE\)/);
  assert.match((await ok(w.request({ type: 'state', windowId: win }))).autoBackupError.message, /FILE_NO_SPACE/);
  // Ein gestarteter Download zählt als Versuch: Erst am nächsten Tag wieder
  b.downloadMode = 'complete';
  await w.advance(12 * HOUR);
  assert.equal(files(b).length, 0);
  await w.advance(12 * HOUR + 5 * 60000);
  assert.equal(files(b).length, 1);
  assert.equal((await ok(w.request({ type: 'state', windowId: win }))).autoBackupError, null);

  // Scheitert schon der Start, probiert es der Wecker eine Stunde später wieder
  b.fail('downloads.download', { message: 'Invalid filename' });
  await w.advance(DAY);
  assert.equal(files(b).length, 1);
  const err = (await ok(w.request({ type: 'state', windowId: win }))).autoBackupError;
  assert.match(err.message, /Invalid filename/);
  await w.advance(HOUR);
  assert.equal(files(b).length, 2);
  assert.equal((await autoState(w)).error, null);
});

test('Ein offener Dialog zum Speicherort hält Wechsel nicht auf', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  b.downloadMode = 'hold';
  await ok(w.request({ type: 'update', wsId: ids.A, patch: { name: 'A' } }));
  // Die Exportseite wartet höchstens 15 Sekunden auf die Datei
  const s = await enable(w, 1);
  assert.equal(s.last.state, 'in_progress');
  assert.equal(s.error, null);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  assert.equal(shows(env, win), 'B');
  check(env, ALL);
  // Wird der Dialog bestätigt, steht die Datei da, und der Wecker fragt nicht stündlich neu
  await w.advance(3 * HOUR);
  assert.equal(b.downloads.length, 1);
  b.finishDownload(1);
  await w.settle();
  assert.equal((await autoState(w)).last.state, 'complete');
  assert.equal(files(b).length, 1);
});

test('Nach dem Entfernen der Erweiterung bringt die letzte Datei alles in ein neues Profil zurück', async () => {
  const src = await setup(SPEC);
  await enable(src.w, 1);
  const text = src.b.files.get(files(src.b).at(-1));

  // Neu hinzugefügt: leerer Speicher, nur das Fenster mit der neuen Tab-Seite
  const b = new Browser();
  const win = b.createWindow({ url: NEWTAB }).id;
  const w = b.startWorker('installed');
  await w.settle();
  await ok(w.request({ type: 'import', text, mode: 'replace', confirmed: true }));
  const names = b.local.data.workspaces.map((x) => x.name);
  assert.deepEqual(names, ['A', 'B']);
  const ids = Object.fromEntries(b.local.data.workspaces.map((x) => [x.name, x.id]));
  const env = { b, win, ids, get w() { return b.worker; } };
  check(env, ALL);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  check(env, ALL);
});
