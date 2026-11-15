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
  assert.equal(first, `${DOWNLOADS}helium-workspaces/helium-workspaces-auto-1.json`);
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

test('Die letzten zehn bleiben, reihum in festen Dateien, eigene Dateien im Ordner rührt sie nicht an', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  // Ein Export von Hand im selben Ordner mit ähnlichem Namen
  await b.chrome.downloads.download({ url: `data:application/json;base64,${btoa('{}')}`, filename: 'helium-workspaces/helium-workspaces-auto-meins.json' });
  const mine = `${DOWNLOADS}helium-workspaces/helium-workspaces-auto-meins.json`;
  const slot = (n) => `${DOWNLOADS}helium-workspaces/helium-workspaces-auto-${n}.json`;
  await enable(w, 1);
  const first = b.files.get(slot(1));
  for (let i = 0; i < 12; i++) await w.advance(DAY);
  // 12 Sicherungen: 1 bis 10, dann wieder 1 und 2
  assert.equal(b.downloads.filter((d) => d.byExtensionId).at(-1).id - b.downloads[0].id, 12);
  const auto = files(b).filter((f) => f !== mine);
  assert.deepEqual(auto.sort(), Array.from({ length: 10 }, (_, i) => slot(i + 1)).sort());
  assert.notEqual(b.files.get(slot(1)), first, 'die älteste ist noch da');
  assert.equal((await autoState(w)).last.file, slot(2));
  assert.ok(files(b).includes(mine), 'die eigene Datei wurde gelöscht');
  // Überschriebene verschwinden aus dem Download-Verlauf, die eigene Datei bleibt darin
  assert.equal(b.downloads.filter((d) => d.byExtensionId).length, 10);
  assert.equal(b.downloads.length, 11);
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

test('Jetzt sichern nach einem Abbruch sichert sofort, nicht erst nach einer Woche (#160)', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  b.downloadMode = 'interrupt';
  await enable(w, 7);
  assert.match((await ok(w.request({ type: 'state', windowId: win }))).autoBackupError.message, /FILE_NO_SPACE/);
  b.downloadMode = 'complete';
  await w.advance(HOUR);
  assert.equal(files(b).length, 0);
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.equal(files(b).length, 1);
  assert.equal((await ok(w.request({ type: 'state', windowId: win }))).autoBackupError, null);
  // Der Abstand zählt ab dieser Sicherung
  await w.advance(6 * DAY);
  assert.equal(files(b).length, 1);
  await w.advance(DAY + HOUR);
  assert.equal(files(b).length, 2);
});

test('Jetzt sichern tut nichts, solange die automatische Sicherung aus ist', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.deepEqual(files(b), []);
});

test('Hinweis auf die automatische Sicherung: ab zwei Workspaces, solange sie aus ist, bis ✕ (#160)', async () => {
  const hint = async (env) => (await ok(env.w.request({ type: 'state', windowId: env.win }))).autoHint;
  assert.equal(await hint(await setup({ workspaces: { A: ['a1'] } })), false);

  const env = await setup(SPEC);
  assert.equal(await hint(env), true);
  await enable(env.w, 1);
  assert.equal(await hint(env), false);
  await enable(env.w, 0);
  assert.equal(await hint(env), true);
  await ok(env.w.request({ type: 'hideAutoHint' }));
  assert.equal(await hint(env), false);
  // Auch nach einem Browserneustart
  env.b.restart();
  await env.b.startWorker('startup').settle();
  assert.equal(await hint(env), false);
});

test('Geleerter Download-Verlauf: Es bleiben trotzdem höchstens zehn Dateien (#192)', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  await enable(w, 1);
  for (let i = 0; i < 4; i++) await w.advance(DAY);
  // Verlauf leeren, die Dateien bleiben
  b.downloads = [];
  for (let i = 0; i < 12; i++) await w.advance(DAY);
  assert.equal(files(b).length, 10);
  // Die neueste Sicherung ist die zuletzt geschriebene Datei
  const last = (await autoState(w)).last;
  assert.equal(JSON.parse(b.files.get(last.file)).exported, new Date(last.at).toISOString());
});

test('Wird der Speicherdialog erst nach dem Warten bestätigt, räumt die nächste Sicherung den Verlauf auf (#192)', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  const own = () => b.downloads.filter((d) => d.byExtensionId && d.state === 'complete').length;
  await enable(w, 1);
  for (let i = 0; i < 9; i++) await ok(w.request({ type: 'autoBackupNow' }));
  assert.equal(own(), 10);
  // Datei 1 noch einmal, der Dialog bleibt länger offen, als die Erweiterung wartet
  b.downloadMode = 'hold';
  await ok(w.request({ type: 'autoBackupNow' }));
  await w.advance(HOUR);
  b.finishDownload(b.downloads.at(-1).id);
  await w.settle();
  assert.equal(own(), 11);
  b.downloadMode = 'complete';
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.equal(own(), 10);
  assert.equal(files(b).length, 10);
});
