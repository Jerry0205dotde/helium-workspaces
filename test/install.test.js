'use strict';
// install.sh gegen nachgebildete KDE-Befehle: Jeder Aufruf landet mit seinen Argumenten in
// einer Logdatei, so lassen sich Reihenfolge und Abbruch prüfen. --update holt dabei mit
// echtem git aus einem Upstream-Repo im Temp-Ordner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'install.sh');
const TOKEN = '0123456789abcdef01234567';
// Ohne Einstellungen des Nutzers, damit Signieren o. Ä. die Commits im Test nicht stört
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

// installed: ob kpackagetool6 -s das Paket findet, dbus: ob qdbus6 KWin erreicht,
// token: was kreadconfig6 als eingetragenen Schlüssel liefert, setup(dir): vorbereiten,
// gibt den Pfad des auszuführenden install.sh zurück, profiles: Pfad unter ~/.config → Inhalt
// der Preferences-Datei dort, input: was auf die Frage nach dem Schlüssel eingetippt wird
function run(args, { installed = true, dbus = true, token = '', setup, profiles = {}, input = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-install-'));
  const home = path.join(dir, 'home');
  for (const [p, content] of Object.entries(profiles)) {
    const file = path.join(home, '.config', p, 'Preferences');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'log');
  const fake = (name, body) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  fake('qdbus6', dbus ? 'echo true' : 'echo "Could not connect to D-Bus server" >&2; exit 1');
  fake('kpackagetool6', `[ "$2" = -s ] && exit ${installed ? 0 : 3}; exit 0`);
  fake('kwriteconfig6', 'exit 0');
  fake('kreadconfig6', `[ "$6" = token ] && echo "${token}"; exit 0`);
  try {
    const script = setup ? setup(dir) : INSTALL;
    const env = { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, HOME: home };
    delete env.XDG_CONFIG_HOME;
    const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', input, env });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    const after = Object.fromEntries(
      Object.keys(profiles).map((p) => [p, fs.readFileSync(path.join(home, '.config', p, 'Preferences'), 'utf8')]),
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, dir, profiles: after };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const uninstall = (opts) => run(['--uninstall'], opts);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// Upstream-Repo mit install.sh, kwin/ und dem Manifest, davon ein Klon als Installation.
// Danach bekommt upstream einen neuen Stand: höhere Version und ein install.sh, das sich
// am Ende zu erkennen gibt. Liefert das install.sh des Klons.
function repos(dir, { diverge = false } = {}) {
  const up = path.join(dir, 'up');
  fs.mkdirSync(path.join(up, 'extension'), { recursive: true });
  fs.copyFileSync(INSTALL, path.join(up, 'install.sh'));
  fs.cpSync(path.join(ROOT, 'kwin'), path.join(up, 'kwin'), { recursive: true });
  const manifest = path.join(up, 'extension', 'manifest.json');
  fs.writeFileSync(manifest, '{\n  "manifest_version": 3,\n  "version": "1.0.0"\n}\n');
  git(up, 'init', '-q', '-b', 'main');
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'alt');
  const local = path.join(dir, 'local');
  git(dir, 'clone', '-q', up, local);
  fs.writeFileSync(manifest, '{\n  "manifest_version": 3,\n  "version": "1.1.0"\n}\n');
  fs.appendFileSync(path.join(up, 'install.sh'), 'echo "Neue Fassung von install.sh"\n');
  git(up, 'commit', '-q', '-am', 'neu');
  if (diverge) {
    fs.writeFileSync(path.join(local, 'eigenes'), 'x\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'eigener Commit');
  }
  return path.join(local, 'install.sh');
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

test('--update holt den neuen Stand und richtet ihn mit dem eingetragenen Schlüssel ein', () => {
  let local;
  const r = run(['--update'], {
    token: TOKEN,
    setup: (dir) => {
      const script = repos(dir);
      local = path.dirname(script);
      return script;
    },
  });
  assert.equal(r.status, 0, r.stderr);
  // Die geholte Fassung von install.sh lief, nicht die alte
  assert.match(r.stdout, /Fertig\.\nNeue Fassung von install\.sh\n/);
  assert.match(r.stdout, /chrome:\/\/extensions.*Neu laden.*Version 1\.1\.0\./);
  assert.ok(r.calls.includes(`kpackagetool6 --type=KWin/Script -u ${local}/kwin`), r.calls.join('\n'));
  assert.ok(r.calls.includes(`kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token ${TOKEN}`));
  assert.ok(!r.calls.some((c) => c.includes('--key browsers')), 'fasst die Browserliste an');
  assert.equal(r.calls.at(-1), 'qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces');
});

test('--update ändert nichts, wenn git pull nicht vorspulen kann', () => {
  const r = run(['--update'], { token: TOKEN, setup: (dir) => repos(dir, { diverge: true }) });
  assert.notEqual(r.status, 0);
  assert.ok(!r.calls.some((c) => !c.startsWith('kreadconfig6')), r.calls.join('\n'));
  assert.doesNotMatch(r.stdout, /Neu laden/);
});

test('--update bricht ohne eingetragenen Schlüssel vor git pull ab', () => {
  const r = run(['--update'], { setup: (dir) => repos(dir) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Noch kein Schlüssel eingetragen/);
  assert.deepEqual(r.calls, ['kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token']);
});

test('--update nimmt keinen Schlüssel und keine Browserliste dazu', () => {
  for (const args of [['--update', TOKEN], ['--update', '--browsers', 'helium'], ['--update', '--uninstall']]) {
    const r = run(args, { token: TOKEN });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /--update nimmt keine weiteren Angaben/);
    assert.deepEqual(r.calls, []);
  }
});

// So schreiben Helium und Chrome die Einstellung: der Wert unter session, die gleichnamige
// Prüfsumme unter protection.macs. Ohne Wert gilt „Neuer Tab“.
const prefs = (restore) =>
  JSON.stringify({
    protection: { macs: { session: { restore_on_startup: '81940185F7F78D0317AB3741FA4A2839' } } },
    session: restore === undefined ? {} : { restore_on_startup: restore },
  });

test('Installation weist auf Profile hin, die nicht dort weitermachen, wo man aufgehört hat', () => {
  const profiles = {
    'net.imput.helium/Default': prefs(1),
    'net.imput.helium/Profile 1': prefs(5),
    'net.imput.helium/System Profile': prefs(5),
    'net.imput.helium/Guest Profile': prefs(5),
    'google-chrome/Default': prefs(),
    'chromium/Profile 2': prefs(4),
    'BraveSoftware/Brave-Browser/Default': prefs(5),
  };
  const r = run([TOKEN], { profiles });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hinweis: Diese Profile starten nicht mit „Dort weitermachen, wo ich aufgehört habe“/);
  const listed = r.stdout.split('\n').filter((l) => l.startsWith('  '));
  assert.deepEqual(listed, [
    '  Helium: ~/.config/net.imput.helium/Profile 1',
    '  Google Chrome: ~/.config/google-chrome/Default',
    '  Chromium: ~/.config/chromium/Profile 2',
  ]);
  assert.match(r.stdout, /Fertig\.\n$/);
  // Nur ein Hinweis, die Einstellungen bleiben unverändert
  assert.deepEqual(r.profiles, profiles);
});

test('Installation gibt keinen Hinweis, wenn alle Profile dort weitermachen', () => {
  const r = run([TOKEN], { profiles: { 'net.imput.helium/Default': prefs(1), 'chromium/Profile 3': prefs(1) } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Hinweis/);
});

test('Installation gibt keinen Hinweis ohne Browserprofile', () => {
  const r = run([TOKEN]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Fertig.\n');
});

// Was install.sh als Schlüssel in kwinrc schreibt
const written = (r) => r.calls.find((c) => c.includes('--key token '))?.split(' ').pop();

test('Der kopierte Befehl aus dem Popup trägt den Schlüssel ein (#111)', () => {
  const r = run([TOKEN]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(written(r), TOKEN);
  assert.match(r.stdout, /Fertig\./);
});

test('Der Befehl aus dem Popup an der Frage eingefügt ergibt nur den Schlüssel (#111)', () => {
  const r = run([], { input: `./install.sh ${TOKEN}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(written(r), TOKEN);
});

test('Ein ungültiger Schlüssel bricht ab, bevor etwas eingetragen ist', () => {
  const r = run([], { input: './install.sh 0123\n' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Ungültiger Schlüssel/);
  assert.equal(written(r), undefined);
});
