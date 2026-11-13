'use strict';
// Popup im echten Chromium: Felder verlassen per Klick, Tab, Enter und Esc, Nachfragen
// beim Löschen und Doppelklicks. Die Nachrichten gehen an die Hintergrundlogik in der
// Nachbildung, geprüft wird, was dort gespeichert ist.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./harness');
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
