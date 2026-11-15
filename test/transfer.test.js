'use strict';
// Export- und Importseite im echten Chromium: Datei wählen, Vorschau, Zusammenführen,
// Ersetzen erst nach Nachfrage und Doppelklicks, automatische Sicherung. Die Nachrichten gehen an die
// Hintergrundlogik in der Nachbildung.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, url, openTabs } = require('./harness');
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
  assert.match(await p.text('#replace-list'), /Bis zum nächsten Browserstart lässt sich das im Popup rückgängig machen\./);
  assert.deepEqual(p.sent.filter((m) => !['token', 'autoBackupState', 'earlier'].includes(m.type)).map((m) => m.type), ['importPreview']);
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

pageTest('Die Nachfrage nennt die Tabs, die beim Klick offen sind, nicht die aus der Vorschau', async ({ env, p, names, imports }) => {
  // Nach der Vorschau kommt ein Tab dazu
  await openTabs(env.b, env.win, ['a2']);
  await env.w.settle();
  await p.click('input[value=replace]');
  await p.click('#import');
  assert.deepEqual(imports(), []);
  assert.equal(await p.text('#import'), '4 Tabs schließen und ersetzen?');
  assert.match(await p.text('#replace-list'), /Löscht 2 Workspaces \(„A“, „B“\) und schließt 4 Tabs\./);
  await p.click('#import');
  assert.deepEqual(imports().map((m) => [m.mode, m.confirmed]), [['replace', true]]);
  assert.deepEqual(names(), ['X']);
  assert.match(await p.text('#import-result'), /2 alte Workspaces mit 4 Tabs entfernt\.$/);
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

pageTest('Ohne Einstellungen in der Datei nennt die Vorschau keine', async ({ p }) => {
  assert.equal(await p.eval('document.getElementById("settings").hidden'), true);
});

test('Die Vorschau nennt die Einstellungen, die sich ändern, der Import übernimmt sie (#161)', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'] } });
  await env.w.request({ type: 'unloadAfter', minutes: 60 });
  const p = await browser.open('transfer.html', env);
  try {
    const file = path.join(dir, `settings-${Date.now()}.json`);
    const settings = { muteStash: true, unloadAfter: 60, autoBackup: 1 };
    fs.writeFileSync(file, JSON.stringify({ ...fileOf([ws('X', 'x1')]), settings }));
    await p.chooseFile('#file', file);
    assert.equal(await p.eval('document.getElementById("settings").hidden'), false);
    assert.equal(await p.text('#settings'), 'Übernimmt die Einstellungen: Ablagen stummschalten: an, Automatisch sichern: täglich.');
    await p.click('#import');
    assert.match(await p.text('#import-result'), /^Import abgeschlossen: 1 Workspace angelegt, 1 Tab übernommen, 2 Einstellungen übernommen\.$/);
    const { muteStash, unloadAfter, autoBackup } = env.b.local.data;
    assert.deepEqual({ muteStash, unloadAfter, autoBackup }, settings);
    // Die Auswahl oben zeigt den übernommenen Wert
    assert.equal(await p.eval('document.getElementById("auto").value'), '1');

    // Dieselbe Datei noch einmal: alles gilt schon
    const again = path.join(dir, `settings-again-${Date.now()}.json`);
    fs.copyFileSync(file, again);
    await p.chooseFile('#file', again);
    assert.equal(await p.text('#settings'), 'Die Einstellungen aus der Datei gelten hier schon.');
  } finally {
    await p.close();
  }
});

test('Ein früherer Stand erscheint unter Importieren und wird nach Nachfrage wiederhergestellt (#189)', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'], B: ['b1', 'b2'] } });
  env.b.restart();
  await env.b.startWorker('startup').settle();
  // Der Start ordnet falsch zu: A verliert seinen Tab, der Snapshot überschreibt die Sicherung
  const main = env.b.mains()[0].id;
  const a1 = (await env.b.chrome.tabs.query({ windowId: main })).find((t) => t.url === url('a1'));
  await env.b.chrome.tabs.create({ windowId: main, url: url('x1') });
  await env.b.chrome.tabs.remove(a1.id);
  await env.w.settle();
  const urls = () => Object.values(env.b.local.data.backup).flatMap((b) => [...b.shown, ...b.stash].map((t) => t.url)).sort();
  assert.deepEqual(urls(), [url('b1'), url('b2'), url('x1')]);

  const p = await browser.open('transfer.html', env);
  try {
    assert.equal(await p.eval('document.getElementById("earlier").hidden'), false);
    assert.match(await p.text('#earlier-list'), /^\d.+2 Workspaces, 3 TabsAuswählen$/);
    await p.click('#earlier-list button');
    assert.match(await p.text('#summary'), /^Stand vom .+: 2 Workspaces, 3 Tabs\.$/);
    assert.equal(await p.eval('document.querySelector("input[value=replace]").checked'), true, 'Ersetzen ist vorgewählt');
    await p.click('#import');
    assert.equal(await p.text('#import'), '3 Tabs schließen und ersetzen?');
    assert.deepEqual(p.sent.filter((m) => m.type === 'import'), []);
    await p.click('#import');
    assert.deepEqual(p.sent.filter((m) => m.type === 'import').map((m) => [m.mode, m.confirmed]), [['replace', true]]);
    assert.match(await p.text('#import-result'), /^Import abgeschlossen: 2 Workspaces angelegt, 3 Tabs übernommen/);
    assert.deepEqual(env.b.local.data.workspaces.map((w) => w.name), ['A', 'B']);
    assert.deepEqual(urls(), [url('a1'), url('b1'), url('b2')]);
    // Die ersetzten Workspaces lassen sich im Popup zurückholen
    assert.deepEqual(env.b.local.data.deleted.map((d) => d.ws.name), ['A', 'B']);
  } finally {
    await p.close();
  }
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

test('Export und automatische Sicherung warnen vor den Adressen im Klartext (#193)', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'] } });
  const p = await browser.open('transfer.html', env);
  try {
    const hint = (section) =>
      p.eval(`[...document.querySelectorAll('section')].find((s) => s.querySelector('h2').textContent === '${section}').textContent`);
    assert.match(await hint('Exportieren'), /im Klartext, also auch Zugangstoken/);
    assert.match(await hint('Automatisch sichern'), /Sicherungen enthalten alle Adressen und Titel im Klartext/);
  } finally {
    await p.close();
  }
});

test('Automatische Sicherung: Auswahl sichert gleich und nennt die Datei, Fehler werden angezeigt', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'], B: ['b1'] } });
  const p = await browser.open('transfer.html', env);
  const choose = async (v) => {
    await p.eval(`(() => { const s = document.getElementById('auto'); s.value = '${v}'; s.dispatchEvent(new Event('change')); })()`);
    await p.idle();
  };
  try {
    assert.match(await p.text('#auto-text'), /Downloads\/helium-workspaces\/ .* die letzten 10\./);
    assert.deepEqual(await p.eval('[...document.querySelectorAll("#auto option")].map((o) => o.textContent)'), ['nie', 'täglich', 'wöchentlich']);
    assert.equal(await p.eval('document.getElementById("auto").value'), '0');
    assert.equal(await p.text('#auto-info'), '');

    await choose('1');
    assert.deepEqual(p.sent.filter((m) => m.type === 'autoBackup'), [{ type: 'autoBackup', days: 1 }]);
    const [file] = env.b.filesIn('helium-workspaces');
    assert.match(await p.text('#auto-info'), new RegExp(`^Zuletzt am .+: ${file.replace(/[.()]/g, '\\$&')}$`));
    assert.equal(await p.eval('document.getElementById("auto-error").hidden'), true);

    // Ein abgebrochener Download erscheint als Fehler
    env.b.downloadMode = 'interrupt';
    await env.w.advance(25 * 3600000);
    await p.eval('location.reload()');
    await p.idle();
    await new Promise((r) => setTimeout(r, 300));
    await p.idle();
    assert.equal(await p.eval('document.getElementById("auto").value'), '1');
    assert.match(await p.text('#auto-error'), /^Automatische Sicherung am .+ fehlgeschlagen.*FILE_NO_SPACE/);

    await choose('0');
    assert.equal(env.b.alarms.has('autoBackup'), false);
    assert.equal(await p.eval('document.getElementById("auto-error").hidden'), true);
  } finally {
    await p.close();
  }
});
