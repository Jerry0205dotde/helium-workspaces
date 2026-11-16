'use strict';
// native-host.sh wie aus dem Browser aufgerufen: Nachricht mit vorangestellter Länge auf stdin,
// stdin bleibt danach offen wie bei Chromium. install.sh und kreadconfig6 sind nachgebildet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST = path.join(__dirname, '..', 'native-host.sh');
const KEY = '0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba98';

const frame = (text) => {
  const body = Buffer.from(text);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};

// known: was kreadconfig6 als eingetragene Schlüssel liefert, installExit: Ergebnis von install.sh,
// env: weitere Umgebungsvariablen, etwa XDG_DATA_HOME für die Sicherungen
async function host(message, { known = '', installExit = 0, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-host-'));
  try {
    const log = path.join(dir, 'log');
    fs.copyFileSync(HOST, path.join(dir, 'native-host.sh'));
    // Was install.sh ausgibt, darf nicht in die Antwort an die Erweiterung geraten
    fs.writeFileSync(path.join(dir, 'install.sh'),
      `echo "install.sh $*" >> "${log}"\n[ -t 0 ] && echo "stdin ist ein Terminal" >> "${log}"\necho "Fertig, KWin-Skript installiert."\necho "Fehler" >&2\nexit ${installExit}\n`);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'kreadconfig6'), `#!/bin/bash\n[ "$6" = token ] && echo "${known}"\n`, { mode: 0o755 });
    const child = spawn('bash', [path.join(dir, 'native-host.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: dir, ...env },
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stdin.write(message);
    // stdin bleibt offen: Der Host muss nach der Nachricht antworten, ohne auf ihr Ende zu warten
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => (child.kill(), reject(new Error('Host antwortet nicht'))), 10000);
      child.on('exit', (c) => (clearTimeout(timer), resolve(c)));
    });
    child.stdin.destroy();
    const reply = Buffer.concat(out);
    assert.equal(code, 0);
    assert.equal(reply.readUInt32LE(0), reply.length - 4, 'Länge der Antwort');
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { reply: JSON.parse(reply.subarray(4).toString()), calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Ein neuer Schlüssel geht an install.sh, die Antwort bleibt frei von dessen Ausgaben', async () => {
  for (const known of ['', OTHER, ` ${OTHER} `]) {
    const r = await host(frame(JSON.stringify({ key: KEY })), { known });
    assert.deepEqual(r.reply, { ok: true, added: true }, known);
    assert.deepEqual(r.calls, [`install.sh ${KEY}`], known);
  }
});

test('Ein schon eingetragener Schlüssel ändert nichts', async () => {
  for (const known of [KEY, `${OTHER},${KEY}`, `${KEY}, ${OTHER}`]) {
    const r = await host(frame(JSON.stringify({ key: KEY })), { known });
    assert.deepEqual(r.reply, { ok: true }, known);
    assert.deepEqual(r.calls, [], known);
  }
});

test('Scheitert install.sh, erfährt es die Erweiterung', async () => {
  const r = await host(frame(JSON.stringify({ key: KEY })), { installExit: 1 });
  assert.deepEqual(r.reply, { ok: false, error: 'install' });
  assert.deepEqual(r.calls, [`install.sh ${KEY}`]);
});

test('Eine Nachricht ohne gültigen Schlüssel ändert nichts', async () => {
  for (const msg of [{ key: KEY.toUpperCase() }, { key: KEY.slice(1) }, { key: `${KEY}0` }, { other: KEY }, { key: `${KEY}" ; rm -rf x` }]) {
    const r = await host(frame(JSON.stringify(msg)));
    assert.deepEqual(r.reply, { ok: false, error: 'key' }, JSON.stringify(msg));
    assert.deepEqual(r.calls, [], JSON.stringify(msg));
  }
});

// ---------------------------------------------------------------- Automatische Sicherung

const OTHER_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const b64 = (text) => Buffer.from(text).toString('base64');

// Ein Datenordner wie ~/.local/share, nach dem Test wieder weg
function dataDir(t, name = 'data') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, name));
  return path.join(dir, name);
}
const autoFile = (data, profile, n) => path.join(data, 'helium-workspaces', 'backups', profile, `helium-workspaces-auto-${n}.json`);
// Wie Chromium die Nachricht schreibt, auch in anderer Reihenfolge der Felder
const backupMsg = (slot, profile, text, order = ['backup', 'profile', 'data']) => {
  const m = { backup: slot, profile, data: b64(text) };
  return frame(JSON.stringify(Object.fromEntries(order.map((k) => [k, m[k]]))));
};

test('Sicherung: landet im Ordner des Profils unter XDG_DATA_HOME, nur für den Benutzer lesbar', async (t) => {
  const data = dataDir(t);
  const text = '{\n  "workspaces": [{ "name": "Ä \\"x\\"" }]\n}\n';
  for (const order of [['backup', 'profile', 'data'], ['backup', 'data', 'profile'], ['data', 'profile', 'backup']]) {
    const r = await host(backupMsg(3, KEY, text, order), { env: { XDG_DATA_HOME: data } });
    const file = autoFile(data, KEY, 3);
    assert.deepEqual(r.reply, { ok: true, file }, order.join());
    assert.deepEqual(r.calls, [], 'install.sh läuft nicht');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    // Keine Reste vom Schreiben über eine neue Datei
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['helium-workspaces-auto-3.json']);
  }
});

test('Ohne XDG_DATA_HOME unter ~/.local/share', async (t) => {
  const home = dataDir(t, 'home');
  const r = await host(backupMsg(1, KEY, '{}\n'), { env: { HOME: home, XDG_DATA_HOME: '' } });
  assert.deepEqual(r.reply, { ok: true, file: autoFile(path.join(home, '.local', 'share'), KEY, 1) });
});

test('Zwei Profile, derselbe Platz: zwei Dateien, keines überschreibt das andere (#215)', async (t) => {
  const data = dataDir(t);
  const env = { XDG_DATA_HOME: data };
  await host(backupMsg(4, KEY, 'A1 A2 A3'), { env });
  await host(backupMsg(4, OTHER_KEY, 'B1'), { env });
  assert.equal(fs.readFileSync(autoFile(data, KEY, 4), 'utf8'), 'A1 A2 A3');
  assert.equal(fs.readFileSync(autoFile(data, OTHER_KEY, 4), 'utf8'), 'B1');
});

test('Eine große Sicherung kommt vollständig an', async (t) => {
  const data = dataDir(t);
  const text = JSON.stringify({ tabs: Array.from({ length: 40000 }, (_, i) => ({ url: `https://example.com/${i}?q=${'x'.repeat(80)}`, title: `Tab ${i} äöü` })) });
  assert.ok(text.length > 5e6);
  const r = await host(backupMsg(10, KEY, text), { env: { XDG_DATA_HOME: data } });
  assert.equal(r.reply.ok, true);
  assert.equal(fs.readFileSync(autoFile(data, KEY, 10), 'utf8'), text);
});

test('Umlaute und Anführungszeichen im Pfad: Die Antwort bleibt gültig, die Länge zählt Bytes', async (t) => {
  const data = dataDir(t, 'Datén "ä" \\ x');
  const r = await host(backupMsg(2, KEY, '{}\n'), { env: { XDG_DATA_HOME: data } });
  assert.deepEqual(r.reply, { ok: true, file: autoFile(data, KEY, 2) });
});

test('Ungültige Sicherung: nichts wird geschrieben, eine alte Datei bleibt', async (t) => {
  const data = dataDir(t);
  const env = { XDG_DATA_HOME: data };
  for (const msg of [
    backupMsg(0, KEY, 'x'), backupMsg(11, KEY, 'x'), backupMsg(1, KEY.slice(1), 'x'), backupMsg(1, '../../../etc', 'x'),
    frame(JSON.stringify({ backup: 1, data: b64('x') })), frame(JSON.stringify({ backup: '1', profile: KEY, data: b64('x') })),
  ]) {
    const r = await host(msg, { env });
    assert.deepEqual(r.reply, { ok: false, error: 'message' });
  }
  assert.deepEqual(fs.readdirSync(data), []);

  // Daten, die kein Base64 sind, oder keine Daten: Die bisherige Datei bleibt unverändert
  await host(backupMsg(1, KEY, 'alt'), { env });
  const file = autoFile(data, KEY, 1);
  for (const msg of [frame(JSON.stringify({ backup: 1, profile: KEY, data: '' })), frame(`{"backup":1,"profile":"${KEY}","data":"%%%"}`), frame(`{"backup":1,"profile":"${KEY}"}`)]) {
    const r = await host(msg, { env });
    assert.deepEqual(r.reply, { ok: false, error: 'write', file });
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'alt');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['helium-workspaces-auto-1.json']);
});

test('Kann der Host nicht schreiben, nennt er die Datei', async (t) => {
  const data = dataDir(t);
  // Wo der Ordner hin soll, liegt eine Datei
  fs.writeFileSync(path.join(data, 'helium-workspaces'), '');
  const r = await host(backupMsg(1, KEY, '{}'), { env: { XDG_DATA_HOME: data } });
  assert.deepEqual(r.reply, { ok: false, error: 'write', file: autoFile(data, KEY, 1) });
});
