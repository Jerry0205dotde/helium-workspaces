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

// known: was kreadconfig6 als eingetragene Schlüssel liefert, installExit: Ergebnis von install.sh
async function host(message, { known = '', installExit = 0 } = {}) {
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: dir },
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
