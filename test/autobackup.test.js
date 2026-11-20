'use strict';
// Automatische Sicherung als Datei über native-host.sh: Abstand, die letzten zehn, je Profil
// ein eigener Ordner, Fehler, und dass sich die Datei nach dem Entfernen der Erweiterung in
// ein neues Profil importieren lässt

const test = require('node:test');
const assert = require('node:assert/strict');
const { Browser, NEWTAB, BACKUPS } = require('./fake-browser');
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
const files = (b) => b.backupFiles();
const slotOf = (b, n) => `${BACKUPS}${b.local.data.token}/helium-workspaces-auto-${n}.json`;
const backups = (b) => b.nativeSent.filter((s) => s.msg.backup);
const autoState = async (w) => plain(await ok(w.request({ type: 'autoBackupState' })));
const enable = async (w, days) => plain(await ok(w.request({ type: 'autoBackup', days })));
const popupError = async (env) => (await ok(env.w.request({ type: 'state', windowId: env.win }))).autoBackupError;

// Wie nach install.sh: native-host.sh ist angemeldet
async function hosted(spec = SPEC) {
  const env = await setup(spec);
  env.b.installHost();
  return env;
}

test('Ohne Einstellung entsteht keine Datei und kein Wecker', async () => {
  const env = await hosted();
  const { b, w } = env;
  await w.advance(10 * DAY);
  assert.equal(b.alarms.has('autoBackup'), false);
  assert.deepEqual(files(b), []);
  assert.deepEqual(backups(b), []);
  const s = await autoState(w);
  assert.equal(s.days, 0);
  assert.equal(s.last, null);
});

test('Täglich: Einschalten sichert sofort über native-host.sh, danach einmal am Tag, die Datei ist ein vollständiger Export', async () => {
  const env = await hosted();
  const { b, w } = env;
  const { token } = b.local.data;
  // Vor der ersten Sicherung nennt die Exportseite den Ordner, in den sie kommt
  assert.equal((await autoState(w)).dir, `~/.local/share/helium-workspaces/backups/${token}/`);
  const s = await enable(w, 1);
  assert.deepEqual(files(b), [slotOf(b, 1)]);
  assert.deepEqual(s.last, { at: b.now, file: slotOf(b, 1) });
  assert.equal(s.dir, `${BACKUPS}${token}/`);
  assert.equal(s.error, null);
  // Nur an den Host der Erweiterung, mit dem Schlüssel des Profils als Unterordner
  const [sent] = backups(b);
  assert.equal(sent.host, 'helium_workspaces');
  assert.deepEqual(Object.keys(sent.msg).sort(), ['backup', 'data', 'profile']);
  assert.equal(sent.msg.profile, token);
  assert.equal(sent.msg.backup, 1);
  assert.match(sent.msg.data, /^[A-Za-z0-9+/=]+$/);

  // Dieselbe Datei wie „Als Datei speichern“, bis auf den Zeitpunkt
  const data = JSON.parse(b.files.get(slotOf(b, 1)));
  const manual = plain(await ok(w.request({ type: 'export' })));
  assert.deepEqual({ ...data, exported: '' }, { ...manual, exported: '' });
  assert.deepEqual(data.workspaces.map((x) => x.name), ['A', 'B']);
  assert.equal(data.workspaces[0].tabs.length, 3);
  assert.equal(data.pinned.length, 1);
  assert.equal(data.exported, new Date(s.last.at).toISOString());

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
  const env = await hosted();
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
  const env = await hosted();
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

test('Die letzten zehn bleiben, reihum in festen Dateien', async () => {
  const env = await hosted();
  const { b, w } = env;
  await enable(w, 1);
  const first = b.files.get(slotOf(b, 1));
  for (let i = 0; i < 12; i++) await w.advance(DAY);
  // 12 Sicherungen: 1 bis 10, dann wieder 1 und 2
  assert.deepEqual(backups(b).map((s) => s.msg.backup), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2]);
  assert.deepEqual(files(b), Array.from({ length: 10 }, (_, i) => slotOf(b, i + 1)).sort());
  assert.notEqual(b.files.get(slotOf(b, 1)), first, 'die älteste ist noch da');
  const last = (await autoState(w)).last;
  assert.equal(last.file, slotOf(b, 2));
  assert.equal(JSON.parse(b.files.get(last.file)).exported, new Date(last.at).toISOString());
});

test('Zwei Profile mit demselben Datenordner überschreiben sich nicht (#215)', async () => {
  // Profil A mit drei Workspaces, Profil B mit einem, beide schreiben auf dieselbe Festplatte
  const a = await hosted({ workspaces: { A1: ['a1'], A2: ['a2'], A3: ['a3'] } });
  const b = await hosted({ workspaces: { B1: ['b1'] } });
  b.b.files = a.b.files;
  assert.notEqual(a.b.local.data.token, b.b.local.data.token);
  await enable(a.w, 1);
  for (let i = 0; i < 3; i++) await ok(a.w.request({ type: 'autoBackupNow' }));
  // B erreicht denselben Platz wie A zuletzt
  for (let i = 0; i < 4; i++) await (i ? ok(b.w.request({ type: 'autoBackupNow' })) : enable(b.w, 1));
  const names = (file) => JSON.parse(a.b.files.get(file)).workspaces.map((x) => x.name);
  for (let n = 1; n <= 4; n++) {
    assert.deepEqual(names(slotOf(a.b, n)), ['A1', 'A2', 'A3'], `Datei ${n} von A`);
    assert.deepEqual(names(slotOf(b.b, n)), ['B1'], `Datei ${n} von B`);
  }
  assert.equal(files(a.b).length, 8);
  assert.notEqual((await autoState(a.w)).last.file, (await autoState(b.w)).last.file);
});

test('Ohne angemeldeten Host: Hinweis auf install.sh, nach install.sh klappt die nächste Stunde ohne Neuladen', async () => {
  const env = await setup(SPEC);
  const { b, w } = env;
  const s = await enable(w, 1);
  assert.equal(s.last, null);
  assert.match(s.error.message, /install\.sh/);
  assert.match((await popupError(env)).message, /install\.sh/);
  b.installHost();
  await w.advance(HOUR);
  assert.deepEqual(files(b), [slotOf(b, 1)]);
  assert.equal(await popupError(env), null);
});

test('Gescheiterte Sicherung: Hinweis im Popup mit der Datei, eine Stunde später der nächste Versuch', async () => {
  const env = await hosted();
  const { b, w } = env;
  // Der Host kann nicht schreiben (z. B. voller Datenträger)
  b.hostMode = 'fail';
  const s = await enable(w, 1);
  assert.equal(s.last, null);
  assert.equal(s.error.message, `Die Sicherung konnte nicht geschrieben werden: ${slotOf(b, 1)}`);
  assert.match((await popupError(env)).message, /konnte nicht geschrieben werden/);
  await w.advance(HOUR);
  assert.equal(files(b).length, 0);
  b.hostMode = 'ok';
  await w.advance(HOUR);
  // Derselbe Platz, eine gescheiterte Sicherung zählt nicht
  assert.deepEqual(files(b), [slotOf(b, 1)]);
  assert.equal(await popupError(env), null);
  assert.equal((await autoState(w)).error, null);
});

test('Wechsel warten nicht auf native-host.sh, hängt er, gilt die Sicherung nach einer Minute als gescheitert', async () => {
  const env = await hosted();
  const { b, w, win, ids } = env;
  await enable(w, 1);
  // Die Antwort des Hosts bleibt aus
  const hang = b.fail('runtime.sendNativeMessage', { hang: true, when: (host, msg) => !!msg.backup });
  await w.advance(DAY + HOUR);
  assert.equal(hang.hits, 1);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  assert.equal(shows(env, win), 'B');
  check(env, ALL);
  assert.match((await popupError(env)).message, /antwortet nicht/);
  assert.equal(files(b).length, 1);
  // Eine Stunde später der nächste Versuch auf demselben Platz
  await w.advance(HOUR);
  assert.deepEqual(files(b), [slotOf(b, 1), slotOf(b, 2)]);
  assert.equal(await popupError(env), null);
});

test('Nach dem Entfernen der Erweiterung bringt die letzte Datei alles in ein neues Profil zurück', async () => {
  const src = await hosted();
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

test('Jetzt sichern nach einem Fehler sichert sofort, nicht erst nach einer Woche (#160)', async () => {
  const env = await hosted();
  const { b, w } = env;
  b.hostMode = 'fail';
  await enable(w, 7);
  assert.match((await popupError(env)).message, /konnte nicht geschrieben werden/);
  b.hostMode = 'ok';
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.equal(files(b).length, 1);
  assert.equal(await popupError(env), null);
  // Der Abstand zählt ab dieser Sicherung
  await w.advance(6 * DAY);
  assert.equal(files(b).length, 1);
  await w.advance(DAY + HOUR);
  assert.equal(files(b).length, 2);
});

test('Jetzt sichern tut nichts, solange die automatische Sicherung aus ist', async () => {
  const env = await hosted();
  const { b, w } = env;
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.deepEqual(files(b), []);
  assert.deepEqual(backups(b), []);
});

test('Nach dem Update von einer Fassung, die nach Downloads sicherte, geht die Reihe weiter', async () => {
  const env = await hosted();
  const { b, w } = env;
  // So hinterließ sie den Speicher: Platz 7 als letzter, die ID des Downloads
  await b.chrome.storage.local.set({ autoBackup: 1, autoBackupAt: b.now - 2 * DAY, autoBackupCount: 7, autoBackupId: 12 });
  const before = await autoState(w);
  assert.deepEqual(before.last, { at: b.now - 2 * DAY, file: '' });
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.deepEqual(files(b), [slotOf(b, 8)]);
  assert.equal(b.local.data.autoBackupId, undefined);
});

test('Hinweis auf die automatische Sicherung: ab zwei Workspaces, solange sie aus ist, bis ✕ (#160)', async () => {
  const hint = async (env) => (await ok(env.w.request({ type: 'state', windowId: env.win }))).autoHint;
  assert.equal(await hint(await hosted({ workspaces: { A: ['a1'] } })), false);

  const env = await hosted();
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

test('Überschreitet der Bestand eine Importgrenze, meldet die automatische Sicherung einen Fehler statt unimportierbar zu schreiben (#232)', async () => {
  const env = await hosted();
  const { b, w } = env;
  await enable(w, 1);
  assert.deepEqual(files(b), [slotOf(b, 1)]);
  const good = b.files.get(slotOf(b, 1));

  // Bestand wächst über 20 000 Tabs hinaus (z. B. durch normal geöffnete Tabs)
  b.local.data.backup[env.ids.B].stash = Array.from({ length: 20001 }, (_, i) => ({ url: `https://t-${i}.example/`, title: '' }));
  // Ablage von B schließen, damit collectAll die Sicherung liest
  const stashB = b.windows.find((x) => b.stashOf(x) === env.ids.B);
  if (stashB) b.windows.splice(b.windows.indexOf(stashB), 1);

  await w.advance(DAY + HOUR);
  assert.deepEqual(files(b), [slotOf(b, 1)], 'bestehende Sicherung darf nicht durch unimportierbare ersetzt oder ergänzt werden');
  assert.equal(b.files.get(slotOf(b, 1)), good);
  assert.match((await autoState(w)).error.message, /Höchstens 20000 Tabs/);
  assert.match((await popupError(env)).message, /Höchstens 20000 Tabs/);

  // Wieder unter der Grenze: Jetzt sichern schreibt Platz 2 und löscht den Fehler
  b.local.data.backup[env.ids.B].stash = [{ url: 'https://b1.example/', title: '' }];
  await ok(w.request({ type: 'autoBackupNow' }));
  assert.deepEqual(files(b), [slotOf(b, 1), slotOf(b, 2)]);
  assert.equal((await autoState(w)).error, null);
  assert.equal(await popupError(env), null);
  const checkImport = await w.request({ type: 'importPreview', text: b.files.get(slotOf(b, 2)) });
  assert.equal(checkImport.ok, true);
});
