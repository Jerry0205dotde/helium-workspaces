'use strict';
// Prüft, dass jeder benutzte Name definiert ist (no-undef), aufgerufen in ci.yml mit
// npx eslint extension kwin. Ein Tippfehler oder eine umbenannte Funktion fiele sonst erst
// zur Laufzeit auf, in selten genommenen Zweigen womöglich nie (#195).
//
// Die Skripte der Erweiterung teilen sich je Umgebung einen globalen Gültigkeitsbereich: der
// Service Worker alles, was background.js per importScripts lädt, jede Seite ihre
// <script>-Tags. Geprüft wird deshalb jede Umgebung als Ganzes, ihre Skripte in der Reihenfolge
// des Ladens zusammengefügt. Ein Fehler erscheint bei der letzten Datei der Umgebung
// (background.js, popup.js, …); steht er in einer anderen, nennt die Meldung sie vorn.

const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, 'extension');

// Was eine Umgebung über die Sprache hinaus bereitstellt und die Skripte benutzen. Meldet
// die Prüfung einen Namen, den es dort wirklich gibt, gehört er hierher.
const common = ['chrome', 'console', 'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'Blob', 'TextEncoder', 'btoa', 'crypto', 'navigator', 'OffscreenCanvas'];
const ENV = {
  worker: [...common, 'importScripts'],
  page: [...common, 'document', 'window', 'location', 'CSS'],
  kwin: ['workspace', 'readConfig'],
};
// Namen, die eine geteilte Datei benutzt, die es aber nicht in jeder Umgebung gibt, in der
// sie geladen wird: Umgebung → Datei → Namen
const ALLOW = {
  // localize() setzt die Texte einer Seite, der Service Worker ruft es nie auf
  worker: { 'i18n.js': ['document'] },
};

const read = (f) => fs.readFileSync(f, 'utf8');

// Umgebungen: letzte Datei → { env, Dateien in Ladereihenfolge }
const contexts = new Map();
{
  const bg = path.join(EXT, 'background.js');
  const imported = [...read(bg).match(/importScripts\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map((m) => path.join(EXT, m[1]));
  contexts.set(bg, { env: 'worker', files: [...imported, bg] });
  for (const html of fs.readdirSync(EXT).filter((f) => f.endsWith('.html'))) {
    const files = [...read(path.join(EXT, html)).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => path.join(EXT, m[1]));
    if (files.length) contexts.set(files.at(-1), { env: 'page', files });
  }
}
// Jede Datei, die zu einer Umgebung gehört (und dort mitgeprüft wird)
const member = new Set([...contexts.values()].flatMap((c) => c.files));

// Fügt die Skripte einer Umgebung zu einem zusammen und ordnet die Meldungen danach wieder
// ihrer Datei und Zeile zu.
const parts = new Map();
const processor = {
  meta: { name: 'umgebung' },
  preprocess(text, filename) {
    const ctx = contexts.get(filename);
    if (!ctx) return [];
    let line = 1;
    const list = ctx.files.map((f) => {
      const src = f === filename ? text : read(f);
      const part = { file: f, start: line, src: src.endsWith('\n') ? src : `${src}\n` };
      line += part.src.split('\n').length - 1;
      return part;
    });
    parts.set(filename, { env: ctx.env, list });
    return [{ text: list.map((p) => p.src).join(''), filename: 'umgebung.js' }];
  },
  postprocess(messages, filename) {
    const ctx = parts.get(filename);
    parts.delete(filename);
    if (!ctx) {
      if (member.has(filename)) return [];
      // Sonst bliebe die Datei ungeprüft
      return [{ ruleId: null, severity: 2, line: 1, column: 1, message: 'Weder background.js noch eine Seite lädt diese Datei. Ihre Umgebung gehört in eslint.config.js.' }];
    }
    const { env, list } = ctx;
    const allowed = (m, file) => m.ruleId === 'no-undef' && ALLOW[env]?.[path.basename(file)]?.some((n) => m.message.startsWith(`'${n}' `));
    return messages.flat().flatMap((m) => {
      const part = list.findLast((p) => p.start <= m.line);
      const shift = (n) => (n === undefined ? n : n - part.start + 1);
      if (allowed(m, part.file)) return [];
      const message = part.file === filename ? m.message : `${path.basename(part.file)}: ${m.message}`;
      return [{ ...m, line: shift(m.line), endLine: shift(m.endLine), message }];
    });
  },
  supportsAutofix: false,
};

const globals = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));
const rules = { 'no-undef': 'error' };
const options = (env) => ({ languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals(ENV[env]) }, rules });
const rel = (f) => path.relative(__dirname, f);

module.exports = [
  { files: ['extension/**/*.js'], ignores: ['extension/**/*.js/*'], processor },
  // Für den zusammengefügten Block und die letzte Datei selbst: Ist der Block gleich der Datei
  // (eine Umgebung aus nur einem Skript), prüft ESLint ihn mit deren Konfiguration
  ...[...contexts].map(([entry, { env }]) => ({ files: [rel(entry), `${rel(entry)}/*`], ...options(env) })),
  { files: ['kwin/**/*.js'], ...options('kwin') },
];
