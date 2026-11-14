'use strict';
// Popup im echten Chromium: Felder verlassen per Klick, Tab, Enter und Esc, Nachfragen
// beim Löschen und Doppelklicks. Die Nachrichten gehen an die Hintergrundlogik in der
// Nachbildung, geprüft wird, was dort gespeichert ist.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, url, where, fillSession } = require('./harness');
const { Chromium, skipReason } = require('./page');

const skip = skipReason();
let browser;
before(async () => {
  if (!skip) browser = await Chromium.launch();
});
after(() => browser?.close());

const BLUE = '#3b82f6';
const RED = '#ef4444';

// Drei Workspaces, A wird gezeigt, A ist rot. Das Popup ist geöffnet, A im Editor.
async function popup() {
  const env = await setup({ workspaces: { A: ['a1'], B: ['b1'], C: ['c1'] } });
  const { A } = env.ids;
  await env.w.request({ type: 'update', wsId: A, patch: { color: RED } });
  const page = await browser.open('popup.html', env);
  await page.click(`[data-focus="ed:${A}"]`);
  assert.equal(await page.focused(), `name:${A}`);
  const ws = (name) => env.b.local.data.workspaces.find((w) => w.id === env.ids[name]);
  const types = () => page.sent.map((m) => m.type).filter((t) => t !== 'state' && t !== 'token');
  return { env, page, A, ws, types };
}

function popupTest(name, fn) {
  test(name, { skip }, async () => {
    const p = await popup();
    try {
      await fn(p);
    } finally {
      await p.page.close();
    }
  });
}

popupTest('Name eingeben und direkt eine Farbe anklicken speichert beides (#49)', async ({ page, A, ws, types }) => {
  await page.type('Uni');
  await page.click(`[data-focus="color:${A}:${BLUE}"]`);
  assert.equal(ws('A').name, 'Uni');
  assert.equal(ws('A').color, BLUE);
  assert.deepEqual(types(), ['update', 'update']);
  assert.equal(await page.focused(), `color:${A}:${BLUE}`);
});

popupTest('Name verlassen per Tab speichert, der Fokus geht zur ersten Farbe', async ({ page, A, ws }) => {
  await page.type('Uni');
  await page.press('Tab');
  assert.equal(ws('A').name, 'Uni');
  assert.equal(ws('A').color, RED);
  assert.equal(await page.focused(), `color:${A}:${BLUE}`);
  assert.equal(await page.eval(`!!document.getElementById('editor-${A}')`), true, 'Editor bleibt offen');
});

popupTest('Name verlassen per Shift+Tab speichert, der Fokus geht ins Emoji-Feld', async ({ page, A, ws }) => {
  await page.type('Uni');
  await page.press('Tab', { shift: true });
  assert.equal(ws('A').name, 'Uni');
  assert.equal(await page.focused(), `emoji:${A}`);
});

popupTest('Enter speichert den Namen und schließt den Editor', async ({ page, A, ws }) => {
  await page.type('Uni');
  await page.press('Enter');
  assert.equal(ws('A').name, 'Uni');
  assert.equal(await page.eval(`!!document.getElementById('editor-${A}')`), false);
  assert.equal(await page.focused(), `ed:${A}`);
});

// Chromium löst change aus, wenn das Neuzeichnen das geänderte Feld entfernt
popupTest('Esc speichert den getippten Namen und schließt den Editor, der Fokus steht auf ✎', async ({ page, A, ws, types }) => {
  await page.type('Uni');
  await page.press('Escape');
  assert.equal(await page.eval(`!!document.getElementById('editor-${A}')`), false);
  assert.equal(ws('A').name, 'Uni');
  assert.deepEqual(types(), ['update']);
  assert.equal(await page.focused(), `ed:${A}`);
  assert.equal(await page.closed(), false, 'Esc schließt nicht das ganze Popup');
});

popupTest('Esc ohne Änderung schließt nur den Editor', async ({ page, A, types }) => {
  await page.press('Escape');
  assert.equal(await page.eval(`!!document.getElementById('editor-${A}')`), false);
  assert.deepEqual(types(), []);
  assert.equal(await page.focused(), `ed:${A}`);
});

popupTest('Name eingeben und ✎ anklicken speichert und schließt den Editor', async ({ page, A, ws, types }) => {
  await page.type('Uni');
  await page.click(`[data-focus="ed:${A}"]`);
  assert.equal(ws('A').name, 'Uni');
  assert.deepEqual(types(), ['update']);
  assert.equal(await page.eval(`!!document.getElementById('editor-${A}')`), false);
  assert.equal(await page.focused(), `ed:${A}`);
});

popupTest('Emoji eingeben und ins Leere klicken speichert das Emoji', async ({ page, A, ws }) => {
  await page.click(`[data-focus="emoji:${A}"]`);
  await page.type('👨‍👩‍👧 Familie');
  await page.click('footer .hint');
  assert.equal(ws('A').emoji, '👨‍👩‍👧');
});

popupTest('Name eingeben und Löschen anklicken speichert den Namen und fragt nach', async ({ env, page, A, ws, types }) => {
  await page.type('Uni');
  await page.click(`[data-focus="del:${A}"]`);
  assert.equal(ws('A').name, 'Uni');
  assert.equal(await page.text(`[data-focus="del:${A}"]`), '1 Tab schließen?');
  assert.deepEqual(types(), ['update']);
  await page.click(`[data-focus="del:${A}"]`);
  assert.deepEqual(types(), ['update', 'delete']);
  assert.equal(env.b.local.data.workspaces.some((w) => w.id === A), false);
});

popupTest('Doppelklick auf Löschen fragt nur nach und löscht nicht', async ({ env, page, A, types }) => {
  await page.dblclick(`[data-focus="del:${A}"]`);
  assert.deepEqual(types(), []);
  assert.equal(await page.text(`[data-focus="del:${A}"]`), '1 Tab schließen?');
  assert.equal(env.b.local.data.workspaces.some((w) => w.id === A), true);
  await page.click(`[data-focus="del:${A}"]`);
  assert.deepEqual(types(), ['delete']);
});

const undoShown = (page) => page.eval('!document.getElementById("undo").hidden');

popupTest('Nach dem Löschen bietet die Liste Rückgängig an, das den Workspace zurückholt (#80)', async ({ env, page, A, types }) => {
  assert.equal(await undoShown(page), false);
  await page.click(`[data-focus="del:${A}"]`);
  await page.click(`[data-focus="del:${A}"]`);
  assert.equal(await undoShown(page), true);
  assert.equal(await page.text('#undo .undo-text'), '„A“ gelöscht');
  // Per Tastatur gleich erreichbar
  assert.equal(await page.focused(), 'undo');
  await page.click('[data-focus="undo"]');
  assert.deepEqual(types(), ['delete', 'undoDelete']);
  assert.deepEqual(env.b.local.data.workspaces.map((w) => w.name), ['A', 'B', 'C']);
  assert.equal(await undoShown(page), false);
  assert.equal(await page.focused(), `ws:${A}`);
  assert.match(await page.text(`[data-focus="ws:${A}"]`), /1 Tab$/);
});

popupTest('✕ blendet Rückgängig aus, danach bleibt der Workspace gelöscht', async ({ env, page, A, types }) => {
  await page.click(`[data-focus="del:${A}"]`);
  await page.click(`[data-focus="del:${A}"]`);
  await page.click('[data-focus="forget"]');
  assert.deepEqual(types(), ['delete', 'forgetDeleted']);
  assert.equal(await undoShown(page), false);
  assert.equal(env.b.local.data.deleted, undefined);
  assert.deepEqual(env.b.local.data.workspaces.map((w) => w.name), ['B', 'C']);
});

popupTest('Name eingeben und anderen Workspace anklicken speichert und wechselt', async ({ env, page, ws, types }) => {
  await page.type('Uni');
  await page.click(`[data-focus="ws:${env.ids.B}"]`);
  assert.equal(ws('A').name, 'Uni');
  assert.deepEqual(types(), ['update', 'switch']);
  assert.equal(env.b.session.data.windowWs[env.win], env.ids.B);
  assert.equal(await page.closed(), true);
});

popupTest('Name eingeben und den aktuellen Workspace anklicken speichert und schließt', async ({ page, A, ws, types }) => {
  await page.type('Uni');
  await page.click(`[data-focus="ws:${A}"]`);
  assert.equal(ws('A').name, 'Uni');
  assert.deepEqual(types(), ['update']);
  assert.equal(await page.closed(), true);
});

popupTest('Name eingeben und ↓ anklicken speichert und verschiebt', async ({ env, page, A, ws, types }) => {
  await page.type('Uni');
  await page.click(`[data-focus="down:${A}"]`);
  assert.equal(ws('A').name, 'Uni');
  assert.deepEqual(types(), ['update', 'reorder']);
  assert.deepEqual(env.b.local.data.workspaces.map((w) => w.name), ['B', 'Uni', 'C']);
  assert.equal(await page.focused(), `down:${A}`);
});

popupTest('Scheitert das Speichern des Namens, unterbleibt die angeklickte Farbe', async ({ page, A, ws, types }) => {
  page.overrides.update = () => ({ ok: false, error: 'Error: kaputt' });
  await page.type('Uni');
  await page.click(`[data-focus="color:${A}:${BLUE}"]`);
  assert.deepEqual(types(), ['update']);
  assert.equal(ws('A').color, RED);
  assert.equal(await page.eval('document.getElementById("error").hidden'), false);
  assert.match(await page.text('#error'), /Änderung konnte nicht gespeichert werden\.kaputt/);
  assert.equal(await page.eval('document.getElementById("controls").disabled'), false, 'Bedienung wieder frei');
});

test('Doppelklick auf ＋ legt nur einen Workspace an, der Fokus steht im neuen Namensfeld', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'] } });
  const page = await browser.open('popup.html', env);
  try {
    // Schnell: Nach dem Anlegen steht ＋ weiter unten, ein später zweiter Klick träfe die neue Zeile
    await page.dblclick('#add', { quick: true });
    assert.deepEqual(page.sent.filter((m) => m.type === 'create').length, 1);
    assert.equal(env.b.local.data.workspaces.length, 2);
    const id = env.b.local.data.workspaces[1].id;
    assert.equal(await page.focused(), `name:${id}`);
  } finally {
    await page.close();
  }
});

test('Speicher: kein Hinweis bei 10 MB, ein gelber bei 1 MB, eine rote Warnung ab 98 %', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1'] } });
  const shown = async () => {
    const page = await browser.open('popup.html', env);
    try {
      await page.idle();
      return await page.eval(`(() => { const e = document.getElementById('storage-warning'); return e.hidden ? null : [e.className, e.innerText]; })()`);
    } finally {
      await page.close();
    }
  };
  assert.equal(await shown(), null);

  env.b.sessionQuota = 1024 * 1024;
  const [cls, text] = await shown();
  assert.equal(cls, 'warning');
  assert.match(text, /nur 1 MB Speicher/);
  assert.match(text, /Ab Chrome 112 sind es 10 MB/);
  assert.match(text, /Belegt: \d+ %/);

  fillSession(env.b, 0.985);
  const [cls2, text2] = await shown();
  assert.equal(cls2, 'error');
  assert.match(text2, /zu 98 % voll/);
  assert.match(text2, /Ab Chrome 112 ist der Speicher zehnmal so groß/);

  // Mit 10 MB und 98 % fehlt der Hinweis auf Chrome 112
  env.b.sessionQuota = 10 * 1024 * 1024;
  fillSession(env.b, 0.985);
  const [cls3, text3] = await shown();
  assert.equal(cls3, 'error');
  assert.doesNotMatch(text3, /Chrome 112/);
});

test('↪ verschiebt alle markierten Tabs und sagt das auch', { skip }, async () => {
  const env = await setup({ workspaces: { A: ['a1', 'a2', 'a3'], B: ['b1'] } });
  const { b, win, ids } = env;
  const at = (u) => b.windows.find((w) => w.id === win).tabs.findIndex((t) => t.url === url(u));
  await b.chrome.tabs.highlight({ windowId: win, tabs: [at('a1'), at('a3')] });
  await env.w.settle();
  const page = await browser.open('popup.html', env);
  try {
    const mv = `[data-focus="mv:${ids.B}"]`;
    assert.equal(await page.eval(`document.querySelector('${mv}').title`), '2 markierte Tabs hierhin verschieben');
    await page.click(mv);
    assert.equal(await page.closed(), true);
    assert.equal(where(env, 'a1').ws, ids.B);
    assert.equal(where(env, 'a3').ws, ids.B);
    assert.equal(where(env, 'a2').ws, ids.A);
  } finally {
    await page.close();
  }
});

popupTest('Kopieren liefert den fertigen Befehl für install.sh samt Schlüssel (#111)', async ({ env, page }) => {
  const { token } = env.b.local.data;
  assert.match(token, /^[0-9a-f]{24}$/);
  assert.equal(await page.eval(`document.getElementById('key-value').textContent`), `./install.sh ${token}`);
  await page.eval(`(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  })()`);
  await page.click('summary');
  await page.click('#key-copy');
  assert.equal(await page.eval('window.__copied'), `./install.sh ${token}`);
  assert.equal(await page.eval(`document.getElementById('key-copy').textContent`), 'Kopiert');
});
