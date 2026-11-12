'use strict';
// Zeichen im Symbol eines Workspace (Symbolleiste, Liste im Popup, Vorschau beim Import)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Browser, NEWTAB } = require('./fake-browser');

const EXT = path.join(__dirname, '..', 'extension');

test('Symbol zeigt das Emoji, sonst das ganze erste Zeichen des Namens', async () => {
  const b = new Browser();
  b.createWindow({ url: NEWTAB });
  const w = b.startWorker('installed');
  await w.settle();
  // Im Kontext der Hintergrundlogik, die label.js selbst lädt
  const label = (name, emoji = '') => w.eval(`wsLabel(${JSON.stringify({ name, emoji })})`);
  assert.equal(label('Uni'), 'U');
  assert.equal(label('  uni'), 'U');
  assert.equal(label('ärzte'), 'Ä');
  assert.equal(label('Uni', '📚'), '📚');
  assert.equal(label(''), '?');
  assert.equal(label('   '), '?');
  // Emoji am Anfang des Namens bleiben ganz, auch zusammengesetzte
  assert.equal(label('🎓 Uni'), '🎓');
  assert.equal(label('🇩🇪 Deutsch'), '🇩🇪');
  assert.equal(label('👨‍👩‍👧 Familie'), '👨‍👩‍👧');
  assert.equal(label('👍🏽 Gut'), '👍🏽');
});

test('Seiten, die das Symbol zeichnen, laden label.js vor ihrem eigenen Skript', () => {
  const pages = fs.readdirSync(EXT).filter((f) => f.endsWith('.html'));
  const using = pages.filter((f) => fs.readFileSync(path.join(EXT, f.replace('.html', '.js')), 'utf8').includes('wsLabel('));
  assert.deepEqual(using, ['popup.html', 'transfer.html']);
  for (const f of using) {
    const srcs = [...fs.readFileSync(path.join(EXT, f), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('label.js'), `${f} lädt label.js nicht`);
    assert.ok(srcs.indexOf('label.js') < srcs.indexOf(f.replace('.html', '.js')), `${f} lädt label.js zu spät`);
  }
});
