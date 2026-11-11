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
// Von install.sh erzeugt und nicht im Repository
const GENERATED = new Set(['token.js']);

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
    if (GENERATED.has(path.basename(f))) continue;
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
  for (const p of ['tabs', 'tabGroups', 'storage', 'contextMenus']) assert.ok(m.permissions.includes(p), `Berechtigung ${p} fehlt`);
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
      if (GENERATED.has(src)) continue;
      assert.ok(exists(EXT, src), `${path.basename(f)}: ${src} fehlt`);
    }
  }
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('extension/token.js'), 'token.js muss ignoriert werden');
});

test('KWin-Metadaten sind gültig und passen zu install.sh', () => {
  const meta = readJson(path.join(KWIN, 'metadata.json'));
  assert.equal(meta.KPackageStructure, 'KWin/Script');
  assert.equal(meta['X-Plasma-API'], 'javascript');
  const id = meta.KPlugin.Id;
  assert.match(id, /^[a-z0-9-]+$/);
  for (const k of ['Name', 'Description', 'License', 'Version']) assert.match(String(meta.KPlugin[k] || ''), /\S/, `KPlugin.${k} fehlt`);
  assert.ok(exists(path.join(KWIN, 'contents'), meta['X-Plasma-MainScript']), 'Hauptskript fehlt');
  const sh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  for (const s of [`Script-${id}`, `${id}Enabled`, `unloadScript ${id}`, `isScriptLoaded ${id}`]) {
    assert.ok(sh.includes(s), `install.sh nutzt nicht die Id ${id} (${s})`);
  }
  // Das Skript liest den Schlüssel, den install.sh schreibt
  assert.ok(sh.includes('--key token'));
  assert.match(fs.readFileSync(path.join(KWIN, 'contents', meta['X-Plasma-MainScript']), 'utf8'), /readConfig\("token"/);
});
