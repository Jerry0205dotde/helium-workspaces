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
    // Die unveränderte Ablage von B bleibt offen (#248), nur x1 im Hauptfenster schließt
    assert.equal(await p.text('#import'), '1 Tab schließen und ersetzen?');
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
    await p.click('#export');
    assert.deepEqual(p.sent.filter((m) => m.type === 'export').length, 1);
    const [{ args: [{ url, filename }] }] = p.calls.filter((c) => c.method === 'downloads.download');
    assert.match(filename, /^helium-workspaces-\d{4}-\d\d-\d\d\.json$/);
    assert.match(url, /^blob:/);
    assert.equal(await p.text('#export-result'), '2 Workspaces mit 3 Tabs und 1 angeheftetem Tab exportiert.');
    assert.equal(await p.text('#status'), '');
    // Nach dem Speichern gibt die Seite die Adresse der Datei frei
    assert.equal(await p.eval(`fetch(${JSON.stringify(url)}).then(() => 'da', () => 'frei')`), 'frei');
  } finally {
    await p.close();
  }
});

// Nur ein gespeicherter Download gilt als Export (#243)
test('Abgebrochener oder gescheiterter Download meldet keinen Erfolg, ein offener Speicherdialog wartet', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'], B: ['b1', 'b2'] } });
  const p = await browser.open('transfer.html', env);
  try {
    p.download = { state: 'interrupted', error: 'USER_CANCELED' };
    await p.click('#export');
    assert.equal(await p.text('#export-result'), 'Export fehlgeschlagen: Speichern abgebrochen, es wurde keine Datei angelegt.');

    p.download = { state: 'interrupted', error: 'FILE_NO_SPACE' };
    await p.click('#export');
    assert.equal(await p.text('#export-result'), 'Export fehlgeschlagen: Die Datei wurde nicht gespeichert (FILE_NO_SPACE).');

    // Solange der Speicherdialog offen ist, bleibt der Export offen und die Seite gesperrt
    p.download = { state: 'in_progress' };
    await p.eval("document.getElementById('export').click()");
    const started = 'Export gestartet, wartet auf das Speichern der Datei …';
    for (let i = 0; (await p.text('#status')) !== started; i++) {
      if (i > 200) throw new Error(`Status: ${await p.text('#status')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(await p.text('#export-result'), '');
    assert.equal(await p.eval("document.getElementById('export').disabled"), true);
    // Ein Ereignis zu einem anderen Download ändert nichts
    await p.eval("__downloadChanged({ id: 99, state: { current: 'complete' } })");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await p.text('#export-result'), '');
    await p.eval("__downloadChanged({ id: 3, state: { current: 'complete' } })");
    await p.idle();
    assert.equal(await p.text('#export-result'), '2 Workspaces mit 3 Tabs exportiert.');
    assert.equal(await p.text('#status'), '');
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
  env.b.installHost();
  const p = await browser.open('transfer.html', env);
  const choose = async (v) => {
    await p.eval(`(() => { const s = document.getElementById('auto'); s.value = '${v}'; s.dispatchEvent(new Event('change')); })()`);
    await p.idle();
  };
  try {
    // Vor der ersten Sicherung der Ordner, in den sie kommt
    const dir = `~/.local/share/helium-workspaces/backups/${env.b.local.data.token}/`;
    assert.ok((await p.text('#auto-text')).startsWith(`Legt regelmäßig einen Export in ${dir} ab und behält davon die letzten 10.`));
    assert.deepEqual(await p.eval('[...document.querySelectorAll("#auto option")].map((o) => o.textContent)'), ['nie', 'täglich', 'wöchentlich']);
    assert.equal(await p.eval('document.getElementById("auto").value'), '0');
    assert.equal(await p.text('#auto-info'), '');

    await choose('1');
    assert.deepEqual(p.sent.filter((m) => m.type === 'autoBackup'), [{ type: 'autoBackup', days: 1 }]);
    const [file] = env.b.backupFiles();
    assert.match(await p.text('#auto-info'), new RegExp(`^Zuletzt am .+: ${file.replace(/[.()]/g, '\\$&')}$`));
    // Danach der tatsächliche Ordner
    assert.ok((await p.text('#auto-text')).startsWith(`Legt regelmäßig einen Export in ${file.replace(/[^/]*$/, '')} ab`));
    assert.equal(await p.eval('document.getElementById("auto-error").hidden'), true);

    // Kann der Host nicht schreiben, erscheint das als Fehler
    env.b.hostMode = 'fail';
    await env.w.advance(25 * 3600000);
    await p.eval('location.reload()');
    await p.idle();
    await new Promise((r) => setTimeout(r, 300));
    await p.idle();
    assert.equal(await p.eval('document.getElementById("auto").value'), '1');
    assert.match(await p.text('#auto-error'), /^Automatische Sicherung am .+ fehlgeschlagen.*konnte nicht geschrieben werden/);

    await choose('0');
    assert.equal(env.b.alarms.has('autoBackup'), false);
    assert.equal(await p.eval('document.getElementById("auto-error").hidden'), true);
  } finally {
    await p.close();
  }
});

test('500 Workspaces in ein Profil mit Standard: Zusammenführen ist gesperrt und erklärt warum, Ersetzen bleibt wählbar (#232)', { skip }, async () => {
  const env = await setup({ workspaces: { Standard: ['s1'] } });
  const p = await browser.open('transfer.html', env);
  try {
    const big = path.join(dir, `ws500-${Date.now()}.json`);
    const list = Array.from({ length: 500 }, (_, i) => ({ id: `large${i}`, name: `Workspace ${i}`, color: '#123456', emoji: '', tabs: [] }));
    fs.writeFileSync(big, JSON.stringify(fileOf(list)));
    await p.chooseFile('#file', big);
    assert.equal(await p.eval('document.getElementById("preview").hidden'), false);
    assert.equal(await p.eval('document.querySelector("input[value=merge]").disabled'), true);
    assert.equal(await p.eval('document.querySelector("input[value=replace]").checked'), true);
    assert.equal(await p.eval('document.getElementById("import").disabled'), false);
    assert.match(await p.text('#merge-list'), /Höchstens 500 Workspaces möglich \(501/);

    // Ersetzen nach Nachfrage klappt
    await p.click('#import');
    assert.equal(await p.text('#import'), '1 Tab schließen und ersetzen?');
    await p.click('#import');
    assert.equal(env.b.local.data.workspaces.length, 500);
    assert.match(await p.text('#import-result'), /500 Workspaces angelegt/);
  } finally {
    await p.close();
  }
});

test('Überschreiten beide Import-Arten die Tab-Grenze, bleibt Importieren gesperrt, bis eine passende Datei gewählt wird (#232)', { skip }, async () => {
  const env = await setup({ pinned: ['p1', 'p2'], workspaces: { A: ['a1'] } });
  const p = await browser.open('transfer.html', env);
  try {
    const big = path.join(dir, `tabs-${Date.now()}.json`);
    const tabs = Array.from({ length: 19999 }, (_, i) => ({ url: `https://t-${i}.example/`, title: '' }));
    fs.writeFileSync(big, JSON.stringify(fileOf([{ id: 'big', name: 'Big', color: '#123456', emoji: '', tabs }])));
    await p.chooseFile('#file', big);
    assert.equal(await p.eval('document.querySelector("input[value=merge]").disabled'), true);
    assert.equal(await p.eval('document.querySelector("input[value=replace]").disabled'), true);
    assert.equal(await p.eval('document.getElementById("import").disabled'), true);
    assert.match(await p.text('#merge-list'), /Höchstens 20000 Tabs.*20002/);
    assert.match(await p.text('#replace-list'), /Höchstens 20000 Tabs.*20001/);

    const okFile = path.join(dir, `ok-${Date.now()}.json`);
    fs.writeFileSync(okFile, JSON.stringify(fileOf([ws('Neu', 'n1')])));
    await p.chooseFile('#file', okFile);
    assert.equal(await p.eval('document.querySelector("input[value=merge]").disabled'), false);
    assert.equal(await p.eval('document.querySelector("input[value=replace]").disabled'), false);
    assert.equal(await p.eval('document.querySelector("input[value=merge]").checked'), true);
    assert.equal(await p.eval('document.getElementById("import").disabled'), false);
  } finally {
    await p.close();
  }
});

test('Überschreitet ein vorhandener Bestand die Grenzen, warnt der manuelle Export deutlich (#232)', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'] } });
  env.b.local.data.workspaces = [
    env.b.local.data.workspaces[0],
    ...Array.from({ length: 500 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, color: '#123456', emoji: '' })),
  ];
  const p = await browser.open('transfer.html', env);
  try {
    await p.click('#export');
    assert.match(await p.text('#export-result'), /^501 Workspaces mit 1 Tab exportiert\.$/);
    assert.equal(await p.eval('document.getElementById("export-error").hidden'), false);
    assert.match(await p.text('#export-error'), /lässt sich so nicht wieder importieren.*Höchstens 500 Workspaces möglich \(501/);
  } finally {
    await p.close();
  }
});
