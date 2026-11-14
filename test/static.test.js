'use strict';
// Statische Prüfungen: JavaScript-Syntax, Manifest der Erweiterung und KWin-Metadaten

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const KWIN = path.join(ROOT, 'kwin');

function files(dir, ext) {
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

test('JavaScript-Syntax aller Dateien der Erweiterung, des KWin-Skripts und der Tests', () => {
  const all = [...files(EXT, '.js'), ...files(KWIN, '.js'), ...files(__dirname, '.js')];
  assert.ok(all.length > 5);
  for (const f of all) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`${path.relative(ROOT, f)}:\n${e.stderr}`);
    }
  }
});

test('manifest.json ist gültig und verweist nur auf vorhandene Dateien', () => {
  const m = readJson(path.join(EXT, 'manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.match(m.name, /\S/);
  assert.match(m.version, /^\d+(\.\d+){0,3}$/);
  assert.ok(exists(EXT, m.background.service_worker), 'Service Worker fehlt');
  assert.ok(exists(EXT, m.action.default_popup), 'Popup fehlt');
  for (const icons of [m.icons, m.action.default_icon]) {
    for (const [size, f] of Object.entries(icons)) {
      // Breite und Höhe stehen im IHDR-Block der PNG-Datei
      const png = fs.readFileSync(path.join(EXT, f));
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Number(size), Number(size)], `${f} ist nicht ${size} px groß`);
    }
  }
  for (const p of ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'contextMenus']) assert.ok(m.permissions.includes(p), `Berechtigung ${p} fehlt`);
  for (const [name, c] of Object.entries(m.commands || {})) {
    assert.match(c.description || '', /\S/, `Befehl ${name} ohne Beschreibung`);
  }
  // Was background.js per importScripts lädt, muss es geben
  const bg = fs.readFileSync(path.join(EXT, m.background.service_worker), 'utf8');
  for (const [, list] of bg.matchAll(/importScripts\(([^)]*)\)/g)) {
    for (const [, f] of list.matchAll(/'([^']+)'/g)) assert.ok(exists(EXT, f), `importScripts: ${f} fehlt`);
  }
  // Die Befehle, auf die background.js hört, sind im Manifest eingetragen
  for (const [, cmd] of bg.matchAll(/cmd === '([^']+)'/g)) assert.ok(m.commands[cmd], `Befehl ${cmd} fehlt im Manifest`);
});

test('HTML-Seiten der Erweiterung laden nur vorhandene Skripte und Stile', () => {
  for (const f of files(EXT, '.html')) {
    const html = fs.readFileSync(f, 'utf8');
    for (const [, src] of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)) {
      assert.ok(exists(EXT, src), `${path.basename(f)}: ${src} fehlt`);
    }
  }
});

test('Übersetzungen: beide Sprachen haben dieselben Texte, alle benutzten Schlüssel gibt es', () => {
  const m = readJson(path.join(EXT, 'manifest.json'));
  const loc = (l) => readJson(path.join(EXT, '_locales', l, 'messages.json'));
  const de = loc('de');
  const en = loc(m.default_locale);
  assert.equal(m.default_locale, 'en');
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort(), 'Schlüssel von de und en');
  // Chrome unterscheidet bei Schlüsseln nicht nach Groß- und Kleinschreibung
  assert.equal(new Set(Object.keys(en).map((k) => k.toLowerCase())).size, Object.keys(en).length);
  const subs = (s) => [...new Set(s.match(/\$[1-9]/g))].sort().join();
  for (const k of Object.keys(en)) {
    assert.match(de[k].message, /\S/, `de: ${k} leer`);
    assert.equal(subs(de[k].message), subs(en[k].message), `Platzhalter von ${k}`);
  }
  const used = new Set();
  const add = (k, where) => {
    used.add(k);
    assert.ok(Object.hasOwn(en, k), `${where}: Text ${k} fehlt in _locales`);
  };
  for (const f of [...files(EXT, '.js'), ...files(EXT, '.html'), path.join(EXT, 'manifest.json')]) {
    const src = fs.readFileSync(f, 'utf8');
    const where = path.basename(f);
    for (const [, k] of src.matchAll(/\btr\('([^']+)'/g)) add(k, where);
    for (const [, k] of src.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)) add(k, where);
    for (const [, k] of src.matchAll(/__MSG_(\w+)__/g)) add(k, where);
    for (const [, k] of src.matchAll(/\bplural\([^,]+, '([^']+)'\)/g)) for (const n of ['one', 'other']) add(`${k}_${n}`, where);
  }
  // Ungenutzte Texte fallen auf (Schlüssel aus tr(…) mit berechnetem Namen gibt es nicht)
  assert.deepEqual(Object.keys(en).filter((k) => !used.has(k)), []);
});

test('KWin-Metadaten sind gültig und passen zu install.sh', () => {
  const meta = readJson(path.join(KWIN, 'metadata.json'));
  assert.equal(meta.KPackageStructure, 'KWin/Script');
  assert.equal(meta['X-Plasma-API'], 'javascript');
  const id = meta.KPlugin.Id;
  assert.match(id, /^[a-z0-9-]+$/);
  for (const k of ['Name', 'Description', 'License', 'Version']) assert.match(String(meta.KPlugin[k] || ''), /\S/, `KPlugin.${k} fehlt`);
  assert.ok(exists(path.join(KWIN, 'contents'), meta['X-Plasma-MainScript']), 'Hauptskript fehlt');
  // Dieselbe Version wie die Erweiterung, install.sh nennt sie am Ende. So sieht man auf einem Gerät,
  // ob das KWin-Skript zum Stand der Erweiterung passt (#117)
  const version = readJson(path.join(EXT, 'manifest.json')).version;
  assert.equal(meta.KPlugin.Version, version, `KPlugin.Version in kwin/metadata.json muss ${version} sein wie in extension/manifest.json`);
  const sh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  for (const s of [`Script-${id}`, `${id}Enabled`, `unloadScript ${id}`, `isScriptLoaded ${id}`]) {
    assert.ok(sh.includes(s), `install.sh nutzt nicht die Id ${id} (${s})`);
  }
  // Das Skript liest den Schlüssel und die Browserliste, die install.sh schreibt
  const main = fs.readFileSync(path.join(KWIN, 'contents', meta['X-Plasma-MainScript']), 'utf8');
  for (const key of ['token', 'browsers']) {
    assert.ok(sh.includes(`--key ${key}`), `install.sh schreibt ${key} nicht`);
    assert.ok(main.includes(`readConfig("${key}"`), `main.js liest ${key} nicht`);
  }
});

// Ändert sich etwas in extension/, muss die Version im Manifest steigen. Sonst zeigt das
// Popup nach einem Update dieselbe Version wie vorher, und man sieht nicht, ob der neue
// Stand läuft. Verglichen wird mit VERSION_BASE (Standard origin/main). Fehlt diese Ref,
// etwa in einem flachen Klon, wird der Test übersprungen.
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

test('Versionen werden nach allen vier Stellen verglichen', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.2', '0.1.9'), 1);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
});

test('Version ist gegenüber main erhöht, wenn sich extension/ geändert hat', (t) => {
  const base = process.env.VERSION_BASE || 'origin/main';
  let mergeBase;
  try {
    mergeBase = git('merge-base', 'HEAD', base);
  } catch {
    t.skip(`${base} nicht vorhanden`);
    return;
  }
  // Ohne HEAD vergleicht git diff mit dem Arbeitsverzeichnis, nicht eingecheckte Änderungen zählen also mit
  const changed = git('diff', '--name-only', mergeBase, '--', 'extension/');
  if (!changed) return;
  const before = JSON.parse(git('show', `${base}:extension/manifest.json`)).version;
  const now = readJson(path.join(EXT, 'manifest.json')).version;
  assert.ok(
    compareVersions(now, before) > 0,
    `extension/ hat sich gegenüber ${base} geändert (${changed.split('\n').join(', ')}), ` +
      `aber die Version in extension/manifest.json ist ${now}, auf ${base} ${before}. Bitte erhöhen.`,
  );
});
