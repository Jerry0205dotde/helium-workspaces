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

test('Seiten, die das Symbol zeichnen, laden label.js vor dem Skript, das es nutzt', () => {
  const pages = fs.readdirSync(EXT).filter((f) => f.endsWith('.html'));
  const using = [];
  for (const f of pages) {
    const srcs = [...fs.readFileSync(path.join(EXT, f), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const users = srcs.filter(
      (s) => s !== 'label.js' && fs.existsSync(path.join(EXT, s)) && fs.readFileSync(path.join(EXT, s), 'utf8').includes('wsLabel('),
    );
    if (!users.length) continue;
    using.push(f);
    assert.ok(srcs.includes('label.js'), `${f} lädt label.js nicht`);
    for (const s of users) assert.ok(srcs.indexOf('label.js') < srcs.indexOf(s), `${f} lädt label.js erst nach ${s}`);
  }
  assert.deepEqual(using, ['popup.html', 'transfer.html']);
});
