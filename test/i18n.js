'use strict';
// chrome.i18n.getMessage für die Nachbildung und die Seiten im Test. Die Tests laufen
// auf Deutsch. Ersetzt wird wie in Chrome: $1 bis $9 durch die Argumente, $$ durch $.
// Anders als Chrome, das für einen unbekannten Schlüssel '' liefert, wirft sie, damit
// ein Tippfehler im Schlüssel auffällt.

const fs = require('node:fs');
const path = require('node:path');

const messages = (locale) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', '_locales', locale, 'messages.json'), 'utf8'));

function getMessage(table, key, subs = []) {
  const m = table[key];
  if (!m) throw new Error(`Unbekannter Text: ${key}`);
  const list = Array.isArray(subs) ? subs : [subs];
  return m.message.replace(/\$(\$|[1-9])/g, (_, x) => (x === '$' ? '$' : String(list[x - 1] ?? '')));
}

// Quelltext von getMessage mit den deutschen Texten, für Seiten im Browser
const pageSource = (locale = 'de') =>
  `((table) => (key, subs) => (${getMessage})(table, key, subs))(${JSON.stringify(messages(locale))})`;

module.exports = { messages, getMessage, pageSource };
