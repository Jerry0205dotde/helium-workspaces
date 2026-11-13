'use strict';
// Export- und Importseite im echten Chromium: Datei wählen, Vorschau, Zusammenführen,
// Ersetzen erst nach Nachfrage und Doppelklicks. Die Nachrichten gehen an die
// Hintergrundlogik in der Nachbildung.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, url } = require('./harness');
const { Chromium, skipReason } = require('./page');

const skip = skipReason();
let browser;
let dir;
before(async () => {
  if (skip) return;
  browser = await Chromium.launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helium-workspaces-file-'));
});
after(async () => {
  await browser?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const fileOf = (workspaces) => ({ format: 'helium-workspaces', version: 1, pinned: [], workspaces });
const ws = (name, ...tabs) => ({ id: `id${name}`, name, color: '#3b82f6', emoji: '', tabs: tabs.map((t) => ({ url: url(t), title: t })) });

// Workspaces A und B sind offen, die Seite ist geladen und eine Datei mit X gewählt
async function page() {
  const env = await setup({ workspaces: { A: ['a1'], B: ['b1', 'b2'] } });
  const p = await browser.open('transfer.html', env);
  const file = path.join(dir, `import-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(fileOf([ws('X', 'x1', 'x2')])));
  await p.chooseFile('#file', file);
  const names = () => env.b.local.data.workspaces.map((w) => w.name);
  const imports = () => p.sent.filter((m) => m.type === 'import');
  return { env, p, names, imports };
}

function pageTest(name, fn) {
  test(name, { skip }, async () => {
    const t = await page();
    try {
      await fn(t);
    } finally {
      await t.p.close();
    }
  });
}

pageTest('Datei wählen zeigt die Vorschau, ohne etwas zu ändern', async ({ p, names, imports }) => {
  assert.equal(await p.text('#error'), '');
  assert.equal(await p.eval('document.getElementById("preview").hidden'), false);
  assert.match(await p.text('#summary'), /^Die Datei ist gültig: 1 Workspace, 2 Tabs/);
  assert.match(await p.text('#replace-list'), /Löscht 2 Workspaces \(„A“, „B“\) und schließt 3 Tabs\./);
  assert.deepEqual(p.sent.filter((m) => m.type !== 'token').map((m) => m.type), ['importPreview']);
  assert.deepEqual(imports(), []);
  assert.deepEqual(names(), ['A', 'B']);
});

pageTest('Doppelklick auf Importieren führt nur einmal zusammen', async ({ p, names, imports }) => {
  await p.dblclick('#import');
  assert.deepEqual(imports().map((m) => [m.mode, m.confirmed]), [['merge', false]]);
  assert.deepEqual(names(), ['A', 'B', 'X']);
  assert.match(await p.text('#import-result'), /^Import abgeschlossen: 1 Workspace angelegt, 2 Tabs übernommen\.$/);
});

pageTest('Ersetzen fragt beim ersten Klick nach, ein Doppelklick bestätigt nicht', async ({ p, names, imports }) => {
  await p.click('input[value=replace]');
  await p.dblclick('#import');
  assert.deepEqual(imports(), []);
  assert.equal(await p.text('#import'), '3 Tabs schließen und ersetzen?');
  assert.deepEqual(names(), ['A', 'B']);
  await p.click('#import');
  assert.deepEqual(imports().map((m) => [m.mode, m.confirmed]), [['replace', true]]);
  assert.deepEqual(names(), ['X']);
  assert.match(await p.text('#import-result'), /2 alte Workspaces mit 3 Tabs entfernt\.$/);
});

pageTest('Wechsel der Art setzt die Nachfrage zurück', async ({ p, imports }) => {
  await p.click('input[value=replace]');
  await p.click('#import');
  assert.equal(await p.text('#import'), '3 Tabs schließen und ersetzen?');
  await p.click('input[value=merge]');
  assert.equal(await p.text('#import'), 'Importieren');
  await p.click('input[value=replace]');
  await p.click('#import');
  assert.deepEqual(imports(), [], 'nach dem Zurücksetzen fragt der erste Klick erneut');
});

pageTest('Ersetzen per Tastatur: Enter fragt nach, erst das zweite bestätigt', async ({ p, names, imports }) => {
  await p.click('input[value=replace]');
  await p.press('Tab');
  assert.equal(await p.eval('document.activeElement.id'), 'import');
  await p.press('Enter');
  assert.deepEqual(imports(), []);
  assert.equal(await p.text('#import'), '3 Tabs schließen und ersetzen?');
  await p.press('Enter');
  assert.deepEqual(imports().map((m) => [m.mode, m.confirmed]), [['replace', true]]);
  assert.deepEqual(names(), ['X']);
});

pageTest('Eine ungültige Datei zeigt einen Fehler und ändert nichts', async ({ p, names }) => {
  const bad = path.join(dir, `bad-${Date.now()}.json`);
  fs.writeFileSync(bad, '{ kaputt');
  await p.chooseFile('#file', bad);
  assert.equal(await p.eval('document.getElementById("preview").hidden'), true);
  assert.match(await p.text('#error'), /^Diese Datei kann nicht importiert werden\. Es wurde nichts geändert\./);
  assert.equal(await p.eval('document.getElementById("import").disabled'), false, 'Bedienung wieder frei');
  assert.deepEqual(names(), ['A', 'B']);
});

test('Export meldet, was gespeichert wurde', { skip }, async () => {
  const env = await setup({ pinned: ['p1'], workspaces: { A: ['a1'], B: ['b1', 'b2'] } });
  const p = await browser.open('transfer.html', env);
  try {
    // Den Download selbst nicht speichern
    await p.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await p.click('#export');
    assert.deepEqual(p.sent.filter((m) => m.type === 'export').length, 1);
    assert.equal(await p.text('#export-result'), '2 Workspaces mit 3 Tabs und 1 angeheftetem Tab exportiert.');
  } finally {
    await p.close();
  }
});
