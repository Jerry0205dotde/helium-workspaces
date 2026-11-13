'use strict';
// Mehrere Hauptfenster: eigene Workspaces je Fenster, derselbe Workspace in zwei
// Fenstern, Schließen einzelner Fenster und des letzten Fensters per X

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, where, shows, tabIds, openTabs, NEWTAB } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }],
    B: [{ url: 'b1', group: 'Lesen', color: 'red' }, 'b2'],
    C: ['c1', 'c2'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

// Neues Fenster wie mit Strg+N; gibt seine ID zurück, sobald es zugeordnet ist
async function newWindow(env) {
  const win = await env.b.chrome.windows.create({ focused: true });
  await env.w.settle();
  return win.id;
}

test('Strg+N zeigt den zuletzt benutzten Workspace, jedes Fenster wechselt für sich', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  const before = tabIds(env);
  const win2 = await newWindow(env);
  assert.equal(shows(env, win2), 'A');

  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.C }));
  assert.equal(shows(env, win), 'C');
  assert.equal(shows(env, win2), 'B');
  assert.equal(where(env, 'b1').win.id, win2);
  assert.equal(where(env, 'c1').win.id, win);
  check(env, ALL);

  // Beide zurück zu A: die Tabs kommen dorthin, wo zuerst gewechselt wird
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.A }));
  assert.equal(where(env, 'a1').win.id, win2);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  assert.equal(where(env, 'a1').win.id, win2, 'Tabs von A wurden aus dem anderen Fenster weggenommen');
  check(env, ALL);
  for (const [u, id] of Object.entries(before)) assert.equal(tabIds(env)[u], id, `${u} wurde neu angelegt`);
});

test('Wechsel zu einem Workspace, der schon in einem anderen Fenster offen ist, verdoppelt nichts', async () => {
  const env = await setup(SPEC);
  const { w, win, ids } = env;
  const win2 = await newWindow(env);
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  // Fenster 1 wechselt zu B, dessen Tabs lebend in Fenster 2 liegen: keine Kopie aus der Sicherung
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  assert.equal(shows(env, win), 'B');
  assert.equal(where(env, 'b1').win.id, win2);
  const own = env.b.windows.find((x) => x.id === win).tabs.filter((t) => !t.pinned);
  assert.deepEqual(own.map((t) => t.url), [NEWTAB]);
  check(env, ALL);

  // Ein Tab, der in einem der beiden Fenster dazukommt, gehört zu B
  await openTabs(env.b, win, ['b3']);
  await w.settle();
  check(env, { ...ALL, B: [...SPEC.workspaces.B, 'b3'] });
});

test('Workspace ohne Ablage-Fenster, der schon anderswo offen ist, kommt nicht aus der Sicherung', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const win2 = await newWindow(env);
  // E hat noch nie eine Ablage gehabt: neu angelegt und nur in Fenster 1 angezeigt
  env.ids.E = (await ok(w.request({ type: 'create', name: 'E' }))).id;
  await ok(w.request({ type: 'switch', windowId: win, wsId: env.ids.E }));
  await openTabs(b, win, ['e1', 'e2']);
  await w.settle();
  assert.equal(b.windows.some((x) => b.stashOf(x) === env.ids.E), false);
  assert.ok(b.local.data.backup[env.ids.E].shown.some((e) => e.url.includes('e1')));
  await ok(w.request({ type: 'switch', windowId: win2, wsId: env.ids.E }));
  assert.equal(where(env, 'e1').win.id, win);
  check(env, { ...ALL, E: ['e1', 'e2'] });
});

test('Schließen eines von zwei Fenstern verwirft nur dessen Tabs', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const win2 = await newWindow(env);
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  await b.chrome.windows.remove(win2);
  await w.settle();
  check(env, { ...ALL, B: [] });
  assert.equal(shows(env, win), 'A');

  // Zeigen zwei Fenster denselben Workspace, bleibt beim Schließen des einen alles erhalten
  const win3 = await newWindow(env);
  await openTabs(b, win3, ['a4']);
  await w.settle();
  await b.chrome.windows.remove(win3);
  await w.settle();
  check(env, { ...ALL, B: [] });
});

test('Geschlossenes Zweitfenster mit Strg+Shift+T zurückgeholt: es zeigt wieder seinen Workspace', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const win2 = await newWindow(env);
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  // Neue Tab-Seiten zählen beim Abgleich nicht mit
  for (let i = 0; i < 2; i++) await b.chrome.tabs.create({ windowId: win2, url: NEWTAB });
  await w.settle();
  await b.chrome.windows.remove(win2);
  await w.settle();
  check(env, { ...ALL, B: [] });

  // Etwas später, außerhalb der Frist nach dem Start
  b.now += 60000;
  const win3 = b.reopenClosed();
  await w.settle();
  assert.equal(shows(env, win3), 'B');
  assert.equal(shows(env, win), 'A');
  check(env, ALL);

  // Ein Link aus B in einem neuen Fenster ist kein zurückgeholtes Fenster
  await b.chrome.windows.remove(win3);
  await w.settle();
  const win4 = (await b.chrome.windows.create({ url: url('b2'), focused: true })).id;
  await w.settle();
  assert.equal(shows(env, win4), 'A');
  check(env, { ...ALL, A: [...SPEC.workspaces.A, 'b2'], B: [] });
});

test('Letztes Fenster per X geschlossen: nach dem Start ist alles wieder da', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  await b.chrome.windows.remove(win);
  await w.settle();
  assert.equal(b.windows.length, 0, 'Ablage-Fenster wurden nicht geschlossen');

  // Chromium stellt nur das zuletzt geschlossene (Ablage-)Fenster wieder her
  b.restart();
  const w2 = b.startWorker('startup');
  await w2.settle();
  assert.equal(b.mains().length, 1);
  const main = b.mains()[0].id;
  assert.equal(shows(env, main), 'B');
  check(env, ALL);
  for (const name of ['A', 'C', 'B']) {
    await ok(w2.request({ type: 'switch', windowId: main, wsId: ids[name] }));
    check(env, ALL);
  }
});

// Wie Chromium beim Schließen per X verschwinden die Tabs einzeln. Währenddessen lädt
// eine Seite in der Ablage von B weiter (Tab-Ereignis), und wait lässt Zeit vergehen.
for (const [label, wait] of [
  ['bevor die verzögerte Sicherung läuft', 10],
  ['die verzögerte Sicherung läuft beim Schließen', 400],
]) {
  test(`Letztes Fenster kurz nach einer Tab-Änderung geschlossen (${label}): die Änderung ist nach dem Start da`, async () => {
    const env = await setup(SPEC);
    const { b, w, win } = env;
    // Neuer Tab in der Gruppe „Mathe“, ein neuer angehefteter Tab, und a1 navigiert weiter
    const a4 = await b.chrome.tabs.create({ windowId: win, url: url('a4'), active: false });
    const mathe = where(env, 'a2').tab.groupId;
    await b.chrome.tabs.group({ tabIds: [a4.id], groupId: mathe });
    const p2 = await b.chrome.tabs.create({ windowId: win, url: url('p2'), active: false });
    await b.chrome.tabs.update(p2.id, { pinned: true });
    const nav = { url: url('a5') };
    await b.chrome.tabs.update(where(env, 'a1').tab.id, nav);
    // Navigation durch den Nutzer, nicht durch die Erweiterung (siehe check)
    b.calls = b.calls.filter((c) => !(c.name === 'tabs.update' && c.args[1]?.url === nav.url));
    await w.advance(100);
    const b1 = where(env, 'b1').tab;
    await b.closeWindowByX(win, async () => {
      b.fire('tabs.onUpdated', b1.id, { url: b1.url }, { ...b1 });
      await w.advance(wait);
    });
    await w.settle();
    assert.equal(b.windows.length, 0, 'Ablage-Fenster wurden nicht geschlossen');

    const A = ['a5', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }, { url: 'a4', group: 'Mathe', color: 'blue' }];
    const expected = { ...ALL, A, pinned: ['p1', 'p2'] };
    b.restart();
    const w2 = b.startWorker('startup');
    await w2.settle();
    assert.equal(shows(env, b.mains()[0].id), 'A');
    check(env, expected);
  });
}

// Eine langsame Antwort (Symbol des neuen Tabs, Gruppenabfrage) darf das Abbild der Tabs
// nicht verzögern: das Fenster schließt, während sie noch aussteht.
for (const [label, api, change] of [
  ['Symbol des neuen Tabs', 'action.setIcon', (b, win) => b.chrome.tabs.create({ windowId: win, url: url('a4'), active: false })],
  ['Gruppenabfrage', 'tabGroups.query', (b, win, env) => b.chrome.tabs.update(where(env, 'a3').tab.id, { url: url('a4') })],
]) {
  test(`Letztes Fenster geschlossen, während die Antwort „${label}“ aussteht: die Änderung ist nach dem Start da`, async () => {
    const env = await setup(SPEC);
    const { b, w, win } = env;
    await w.settle();
    const held = b.fail(api, { hold: true });
    await change(b, win, env);
    await w.advance(20);
    // Eine zweite Änderung, solange die Antwort noch aussteht
    await b.chrome.tabs.update(where(env, 'a1').tab.id, { url: url('a5') });
    b.calls = b.calls.filter((c) => !(c.name === 'tabs.update' && ['a4', 'a5'].map(url).includes(c.args[1]?.url)));
    await w.advance(20);
    assert.equal(held.hits, 1, `${api} wurde nicht aufgerufen`);
    await b.closeWindowByX(win);
    held.release();
    await w.settle();
    assert.equal(b.windows.length, 0, 'Ablage-Fenster wurden nicht geschlossen');

    const A = api === 'action.setIcon'
      ? ['a5', ...SPEC.workspaces.A.slice(1), 'a4']
      : ['a5', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a4', group: 'Mathe', color: 'blue' }];
    b.restart();
    const w2 = b.startWorker('startup');
    await w2.settle();
    check(env, { ...ALL, A });
  });
}

// Wie die Tab-Suche: aktiviert den Tab in seiner Ablage und holt deren Fenster nach vorn
async function pickInStash(env, name) {
  const at = where(env, name);
  assert.equal(at.stash, true, `${name} liegt nicht in einer Ablage`);
  await env.b.chrome.tabs.update(at.tab.id, { active: true });
  await env.b.chrome.windows.update(at.win.id, { focused: true });
  await env.w.settle();
}

test('Tab in einer Ablage aktivieren: das zuletzt benutzte Fenster wechselt dorthin', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const before = tabIds(env);
  // Das neue Fenster (Strg+N) hat den Fokus, seit es offen ist
  const win2 = await newWindow(env);
  await pickInStash(env, 'c2');
  assert.equal(shows(env, win), 'A');
  assert.equal(shows(env, win2), 'C');
  assert.equal(where(env, 'c2').win.id, win2);
  assert.equal(where(env, 'c2').tab.active, true);
  assert.equal(b.windows.find((x) => x.id === win2).focused, true, 'Fenster 2 ist nicht im Vordergrund');
  check(env, ALL);

  // Nach einem Fensterwechsel gilt das andere Fenster
  await b.chrome.windows.update(win, { focused: true });
  await pickInStash(env, 'b2');
  assert.equal(shows(env, win), 'B');
  assert.equal(shows(env, win2), 'C');
  assert.equal(where(env, 'b2').tab.active, true);
  check(env, ALL);

  // Zeigt das Fenster den Workspace schon (Fenster 1 hat von ihm weggewechselt), kommen
  // die Tabs aus der Ablage dazu
  await ok(w.request({ type: 'switch', windowId: win2, wsId: ids.B }));
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.A }));
  await b.chrome.windows.update(win2, { focused: true });
  await pickInStash(env, 'b1');
  assert.equal(shows(env, win), 'A');
  assert.equal(shows(env, win2), 'B');
  assert.equal(where(env, 'b1').win.id, win2);
  assert.equal(where(env, 'b1').tab.active, true);
  check(env, ALL);
  for (const [u, id] of Object.entries(before)) assert.equal(tabIds(env)[u], id, `${u} wurde neu angelegt`);
});
