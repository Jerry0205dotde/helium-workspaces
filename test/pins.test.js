'use strict';
// Helium ab 0.22 teilt angeheftete Tabs zwischen allen normalen Fenstern eines Profils (#265):
// Fehlt einem Fenster ein Pin, legt Helium ihn dort entladen an, Lösen löst ihn überall. Die
// Ablage-Seite ist deshalb nicht angeheftet, sonst stünde sie in jedem Fenster. Die
// angehefteten Tabs des Nutzers stehen dafür auch in jeder Ablage und bleiben dort liegen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, shows, tabIds } = require('./harness');

const SPEC = {
  pinned: ['p1', 'p2'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: ['b1', 'b2'],
    C: ['c1'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

// Wechselt im ersten Hauptfenster durch alle Workspaces und prüft danach jeweils alles
async function cycle(env, names = ['B', 'C', 'A']) {
  for (const name of names) {
    const main = env.b.mains()[0].id;
    await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids[name] }));
    assert.equal(shows(env, main), name);
    check(env, ALL);
  }
}

test('Helium 0.22: Wechsel mit geteilten Pins, jede Ablage hat die Pins, das Hauptfenster keine Ablage-Seite', async () => {
  const env = await setup(SPEC, { sharedPins: true });
  const { b } = env;
  check(env, ALL);
  assert.equal(b.mains().length, 1, 'ein Hauptfenster');
  assert.equal(b.windows.filter((w) => b.stashOf(w)).length, 3, 'drei Ablagen, die von A leer');
  for (const w of b.windows) assert.deepEqual(w.tabs.filter((t) => t.pinned).map((t) => t.url), SPEC.pinned.map(url), `Pins in Fenster ${w.id}`);
  const ids = tabIds(env);
  await cycle(env, ['B', 'C', 'A', 'C', 'B', 'A']);
  // Die Kopien der Pins in den Ablagen zählen nicht, sie bleiben in ihrer Ablage
  const own = Object.fromEntries(Object.entries(tabIds(env)).filter(([u]) => !SPEC.pinned.map(url).includes(u)));
  assert.deepEqual(own, Object.fromEntries(Object.entries(ids).filter(([u]) => !SPEC.pinned.map(url).includes(u))), 'Tabs wurden neu angelegt');
});

test('Helium 0.22: Tab in einen anderen Workspace verschieben, neu laden und neu starten', async () => {
  const env = await setup(SPEC, { sharedPins: true });
  const { b } = env;
  await ok(env.w.request({ type: 'moveTab', tabId: b.tabsByUrl(url('a1'))[0].id, wsId: env.ids.C }));
  const moved = { ...ALL, A: SPEC.workspaces.A.slice(1), C: [...SPEC.workspaces.C, 'a1'] };
  check(env, moved);
  await b.reloadExtension().settle();
  check(env, moved);
  for (const restore of ['now', 'none']) {
    b.restart({ restore, keepPinned: true });
    await b.startWorker('startup').settle();
    check(env, moved);
    assert.equal(shows(env, b.mains()[0].id), 'A', `nach dem Start (${restore})`);
    for (const name of ['B', 'C', 'A']) {
      await ok(env.w.request({ type: 'switch', windowId: b.mains()[0].id, wsId: env.ids[name] }));
      check(env, moved);
    }
  }
});

test('Umstieg: angeheftete Ablage-Seiten älterer Versionen werden gelöst (#265)', async () => {
  for (const sharedPins of [false, true]) {
    const env = await setup(SPEC);
    const { b } = env;
    // Wie in älteren Versionen ist die Ablage-Seite angeheftet. In Helium 0.22 hat sie jedes
    // Fenster dann als Kopie bekommen.
    for (const w of b.windows) {
      const page = w.tabs.find((t) => t.url.startsWith(`${b.origin}stash.html`));
      if (page) await b.chrome.tabs.update(page.id, { pinned: true });
    }
    // Neustart mit der neuen Version: Helium 0.22 stellt die Fenster wieder her und legt die
    // angehefteten Ablage-Seiten entladen in jedes Fenster
    b.sharedPins = sharedPins;
    b.restart();
    await new Promise((r) => setImmediate(r));
    if (sharedPins) {
      const marks = (x) => x.tabs.filter((t) => t.url.startsWith(`${b.origin}stash.html`)).length;
      assert.ok(b.windows.every((x) => marks(x) === 3), 'Testfehler: die Ablage-Seiten sind nicht in jedem Fenster');
    }
    await b.startWorker('startup').settle();
    check(env, ALL);
    assert.equal(shows(env, b.mains()[0].id), 'A');
    assert.equal(b.windows.flatMap((w) => w.tabs).filter((t) => t.pinned && t.url.startsWith(b.origin)).length, 0, 'angeheftete Ablage-Seite');
    await cycle(env);
  }
});

test('Helium 0.22: Neuaufbau des Hauptfensters legt die geteilten Pins nicht ein zweites Mal an', async () => {
  const env = await setup(SPEC, { sharedPins: true });
  const { b } = env;
  // Helium stellt nur die Ablagen wieder her, nicht das Hauptfenster
  b.restart({ loseWindow: (x) => !x.tabs.some((t) => t.url.startsWith(b.origin)) });
  await b.startWorker('startup').settle();
  assert.equal(b.mains().length, 1);
  check(env, ALL);
  await cycle(env);
});

// Wie in exchange.test.js (#156): Nach dem Neuladen mit fester ID hat die alte leere Ablage von A
// nur noch die Kopien der Pins. Sie ist trotzdem eine alte leere Ablage und wird geschlossen,
// statt B zu zeigen und dessen übernommene Ablage zu sich zu holen.
test('Helium 0.22: Ersetzen nach dem Umstieg auf die feste ID schließt die alte leere Ablage', async () => {
  const env = await setup(SPEC, { sharedPins: true });
  const { b } = env;
  const file = JSON.parse(JSON.stringify(await ok(env.w.request({ type: 'export' }))));
  const own = () => b.windows.flatMap((w) => w.tabs.filter((t) => !t.pinned && !t.url.startsWith(b.origin)).map((t) => t.id)).sort();
  const before = own();
  b.reloadExtension({ newId: 'hwsfesteid' });
  await b.worker.settle();
  const res = await ok(b.worker.request({ type: 'import', text: JSON.stringify(file), mode: 'replace', confirmed: true }));
  assert.equal(res.kept, 6);
  const now = { b, get w() { return b.worker; }, ids: Object.fromEntries(b.local.data.workspaces.map((w) => [w.name, w.id])) };
  assert.equal(b.windows.length, 3, 'die alte leere Ablage ist noch offen');
  assert.deepEqual(own(), before, 'Tabs wurden geschlossen oder neu angelegt');
  check(now, ALL, { allowNewTab: false });
  await cycle(now);
});

// Wie git pull und Neuladen unter chrome://extensions mit einer älteren Version: Chromium
// schließt die Seiten der Erweiterung, an Stelle der einzigen, angehefteten Ablage-Seite der
// leeren Ablage von A lädt es eine angeheftete neue Tab-Seite. Sie verschwindet, sonst käme
// sie in Helium 0.22 als geteilter Pin in jedes Fenster.
test('Umstieg: Neuladen ersetzt angeheftete Ablage-Seiten durch nicht angeheftete (#265)', async () => {
  const env = await setup(SPEC);
  const { b } = env;
  for (const w of b.windows) {
    const page = w.tabs.find((t) => t.url.startsWith(`${b.origin}stash.html`));
    if (page) await b.chrome.tabs.update(page.id, { pinned: true });
  }
  await env.w.settle();
  await b.reloadExtension().settle();
  check(env, ALL);
  assert.equal(b.windows.filter((w) => b.stashOf(w)).length, 3, 'drei Ablagen');
  assert.deepEqual(b.windows.flatMap((w) => w.tabs).filter((t) => t.pinned).map((t) => t.url), SPEC.pinned.map(url), 'angeheftete Tabs');
  await cycle(env);
});

// Etwa über die Tab-Suche: Die Kopie eines angehefteten Tabs in einer Ablage wird aktiv. Das
// Hauptfenster bleibt beim Workspace und zeigt den angehefteten Tab, die Ablage behält ihre
// Ablage-Seite vorn, deren Titel das KWin-Skript liest.
test('Helium 0.22: Wird eine Pin-Kopie in einer Ablage aktiv, wechselt das Hauptfenster nicht', async () => {
  const env = await setup(SPEC, { sharedPins: true });
  const { b } = env;
  const stashB = b.windows.find((w) => b.stashOf(w) === env.ids.B);
  const copy = stashB.tabs.find((t) => t.pinned && t.url === url('p2'));
  await b.chrome.tabs.update(copy.id, { active: true });
  await env.w.settle();
  assert.equal(shows(env, env.win), 'A');
  check(env, ALL);
  assert.equal(b.windows.find((w) => w.id === env.win).tabs.find((t) => t.active).url, url('p2'), 'angehefteter Tab im Hauptfenster');
  await cycle(env);
});
