'use strict';
// install.sh --uninstall gegen nachgebildete KDE-Befehle: Jeder Aufruf landet mit seinen
// Argumenten in einer Logdatei, so lassen sich Reihenfolge und Abbruch prüfen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL = path.join(__dirname, '..', 'install.sh');

// installed: ob kpackagetool6 -s das Paket findet, dbus: ob qdbus6 KWin erreicht
function uninstall({ installed = true, dbus = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-install-'));
  const log = path.join(dir, 'log');
  const fake = (name, body) =>
    fs.writeFileSync(path.join(dir, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  fake('qdbus6', dbus ? 'echo true' : 'echo "Could not connect to D-Bus server" >&2; exit 1');
  fake('kpackagetool6', `[ "$2" = -s ] && exit ${installed ? 0 : 3}; exit 0`);
  fake('kwriteconfig6', 'exit 0');
  fake('kreadconfig6', 'exit 0');
  try {
    const r = spawnSync('bash', [INSTALL, '--uninstall'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('--uninstall entlädt erst, entfernt dann Paket und kwinrc-Einträge', () => {
  const r = uninstall();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [
    'qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces',
    'kpackagetool6 --type=KWin/Script -s helium-workspaces',
    'kpackagetool6 --type=KWin/Script -r helium-workspaces',
    'kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled --delete',
    'kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token --delete',
    'kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers --delete',
  ]);
  assert.match(r.stdout, /KWin-Skript entfernt\./);
});

test('--uninstall läuft auch, wenn das Paket schon fehlt', () => {
  const r = uninstall({ installed: false });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes(' -r ')), 'versucht ein fehlendes Paket zu entfernen');
  assert.ok(r.calls.some((c) => c.includes('--key token --delete')));
});

test('--uninstall entfernt nichts, wenn KWin nicht erreichbar ist', () => {
  const r = uninstall({ dbus: false });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, ['qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces']);
});
