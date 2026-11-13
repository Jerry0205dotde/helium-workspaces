'use strict';
// Gezielte API-Fehler und beendete Service Worker mitten in einem Ablauf: Danach muss der
// Bestand vollständig sein, die Sicherung darf nicht durch einen Zwischenstand ersetzt
// werden, und Wechsel, erneuter Versuch und Verwerfen müssen weiter funktionieren.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, where, shows } = require('./harness');

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { url: 'a2', group: 'Mathe', color: 'blue' }, { url: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    B: [{ url: 'b1', group: 'Lesen', color: 'red' }, { url: 'b2', group: 'Lesen', color: 'red' }, 'b3'],
    C: ['c1'],
  },
};
const ALL = { ...SPEC.workspaces, pinned: SPEC.pinned };

const stashOf = (env, name) => env.b.windows.find((x) => env.b.stashOf(x) === env.ids[name]);
const backupJson = (env) => JSON.stringify(env.b.local.data.backup);

test('Alte Tabs lassen sich nicht in die Ablage schieben: Sicherung bleibt, Wechsel wird nachgeholt', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const stashA = stashOf(env, 'A').id;
  const saved = backupJson(env);
  // Die Tabs von B sind schon im Fenster, dann scheitert das Wegräumen von A
  b.fail('tabs.move', { when: (_, o) => o.windowId === stashA });
  const reply = w.send({ type: 'switch', windowId: win, wsId: ids.B });
  await w.advance(100); // vor dem erneuten Abgleich
  assert.equal((await reply).ok, false);
  assert.ok(b.session.data.pendingSwitch, 'unterbrochener Wechsel ist nicht vermerkt');
  assert.equal(where(env, 'b1').win.id, win);
  assert.equal(where(env, 'a1').win.id, win);
  // Ereignisse aus dem Zwischenstand dürfen die Sicherung nicht überschreiben
  await b.chrome.tabs.create({ windowId: win, url: url('x1'), active: false });
  await b.chrome.tabs.remove(where(env, 'x1').tab.id);
  await w.advance(700);
  assert.equal(backupJson(env), saved, 'Sicherung wurde mit einem Zwischenstand überschrieben');

  // Der Abgleich schließt den Wechsel ab
  await w.settle();
  assert.equal(shows(env, win), 'B');
  check(env, ALL);
  for (const name of ['C', 'A', 'B']) {
    await ok(w.request({ type: 'switch', windowId: win, wsId: ids[name] }));
    check(env, ALL);
  }
});

test('Ein neuer Wechsel vor dem Abgleich setzt den unterbrochenen erst fort', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const stashA = stashOf(env, 'A').id;
  b.fail('tabGroups.move', { when: (_, o) => o.windowId === stashA });
  const first = w.send({ type: 'switch', windowId: win, wsId: ids.B });
  await w.advance(10);
  assert.equal((await first).ok, false);
  const second = await w.request({ type: 'switch', windowId: win, wsId: ids.C });
  assert.equal(second.ok, true);
  assert.equal(shows(env, win), 'C');
  check(env, ALL);
});

test('Fehler beim Holen der Ziel-Tabs nach der ersten Gruppe: Wechsel wird zu Ende geführt', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const stashB = stashOf(env, 'B').id;
  // Gruppe „Lesen“ ist schon im Fenster, b3 hängt noch in der Ablage
  b.fail('tabs.move', { when: (_, o) => o.windowId === win });
  const from = b.calls.length;
  assert.equal((await w.request({ type: 'switch', windowId: win, wsId: ids.B })).ok, true);
  assert.equal(b.calls.slice(from).filter((c) => c.name === 'tabGroups.move' && c.args[1].windowId === win).length, 1);
  assert.equal(shows(env, win), 'B');
  // b3 wurde nachgeholt, die Ablage von B ist leer
  assert.equal(where(env, 'b3').win.id, win);
  assert.equal(stashOf(env, 'B').id, stashB);
  assert.equal(stashOf(env, 'B').tabs.length, 1);
  check(env, ALL);
});

test('Fehler beim allerersten Schritt: nichts bewegt, Fehler wird gemeldet, später klappt es', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const saved = backupJson(env);
  b.fail('tabGroups.move');
  const r = await w.request({ type: 'switch', windowId: win, wsId: ids.B });
  assert.equal(r.ok, false);
  assert.match(r.error, /gescheitert/);
  assert.equal(shows(env, win), 'A');
  assert.equal(b.session.data.pendingSwitch, undefined);
  assert.equal(backupJson(env), saved);
  check(env, ALL);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.B }));
  check(env, ALL);
});

test('Wiederholt scheiternder Abschluss wird im Hintergrund erneut versucht', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  const stashA = stashOf(env, 'A').id;
  const f = b.fail('tabs.move', { when: (_, o) => o.windowId === stashA, times: 4 });
  await w.request({ type: 'switch', windowId: win, wsId: ids.B });
  assert.equal(f.hits, 4);
  assert.equal(shows(env, win), 'B');
  check(env, ALL);
});

test('Service Worker endet mitten im Wechsel: der nächste Worker setzt ihn fort', async () => {
  for (const [api, target] of [
    ['tabs.move', 'stash'], // beim Wegräumen der alten Tabs
    ['tabs.move', 'main'], // beim Holen der Ziel-Tabs, nach der ersten Gruppe
    ['tabs.update', 'main'], // beim Aktivieren, alles schon geholt
  ]) {
    const env = await setup(SPEC);
    const { b, win, ids } = env;
    const stashA = stashOf(env, 'A').id;
    b.fail(api, { hang: true, when: (id, o) => (target === 'stash' ? o?.windowId === stashA : api === 'tabs.update' || o?.windowId === win) });
    const reply = env.w.send({ type: 'switch', windowId: win, wsId: ids.B });
    await env.w.settle();
    assert.ok(b.session.data.pendingSwitch, `${api}/${target}: kein unterbrochener Wechsel`);
    const w = b.startWorker(null);
    await w.settle();
    assert.equal(await Promise.race([reply.then(() => 'Antwort'), Promise.resolve('keine')]), 'keine');
    assert.equal(shows(env, win), 'B', `${api}/${target}`);
    check(env, ALL);
    await ok(w.request({ type: 'switch', windowId: win, wsId: ids.C }));
    check(env, ALL);
  }
});

// Start mit neuer Tab-Seite, damit B und C beim Wechseln aus der Sicherung kommen
async function fromBackup() {
  const env = await setup(SPEC);
  env.b.restart({ restore: 'none', keepPinned: true });
  env.b.startWorker('startup');
  await env.w.settle();
  check(env, ALL);
  return env;
}

test('Ein Tab lässt sich nicht wiederherstellen: wird aufbewahrt, erneut versucht und verworfen', async () => {
  const env = await fromBackup();
  const { b } = env;
  const main = b.mains()[0].id;
  const f = b.fail('tabs.create', { when: (o) => o.url === url('b2'), times: 2 });
  await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids.B }));
  const failed = b.local.data.backup[env.ids.B].failed;
  assert.deepEqual(failed.map((e) => e.url), [url('b2')]);
  assert.equal(failed[0].gt, 'Lesen', 'Gruppenangaben des fehlgeschlagenen Tabs fehlen');
  const B = SPEC.workspaces.B.filter((e) => e.url !== 'b2');
  check(env, { ...ALL, B });
  const st = await ok(env.w.request({ type: 'state', windowId: main }));
  assert.equal(st.workspaces.find((x) => x.id === env.ids.B).failed, 1);

  // Erster erneuter Versuch scheitert wieder, der Eintrag bleibt
  await ok(env.w.request({ type: 'retry', windowId: main, wsId: env.ids.B }));
  assert.equal(b.local.data.backup[env.ids.B].failed.length, 1);
  // Wechsel funktionieren trotzdem, der Eintrag geht dabei nicht verloren
  await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids.A }));
  check(env, { ...ALL, B });
  // Der zweite Versuch (aus einem anderen Workspace heraus) legt den Tab in seiner Gruppe an
  await ok(env.w.request({ type: 'retry', windowId: main, wsId: env.ids.B }));
  assert.equal(f.hits, 2);
  assert.equal(shows(env, main), 'B');
  assert.equal(b.local.data.backup[env.ids.B].failed?.length ?? 0, 0);
  check(env, ALL);

  // Verwerfen entfernt die Einträge
  const env2 = await fromBackup();
  env2.b.fail('tabs.create', { when: (o) => o.url === url('c1') });
  await ok(env2.w.request({ type: 'switch', windowId: env2.b.mains()[0].id, wsId: env2.ids.C }));
  assert.equal(env2.b.local.data.backup[env2.ids.C].failed.length, 1);
  await ok(env2.w.request({ type: 'dismiss', wsId: env2.ids.C }));
  assert.equal(env2.b.local.data.backup[env2.ids.C].failed, undefined);
  check(env2, { ...ALL, C: [] });
});

test('Plakette für fehlende Tabs: alle Tabs aktualisiert, Konfiguration und Sicherung je einmal gelesen', async () => {
  const env = await fromBackup();
  const { b } = env;
  const main = b.mains()[0].id;
  b.fail('tabs.create', { when: (o) => o.url === url('b2') });
  await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids.B }));
  await env.w.settle();
  const from = b.calls.length;
  await env.w.eval('updateAllIcons()');
  const calls = b.calls.slice(from);
  const reads = (key) => calls.filter((c) => c.name === 'storage.local.get' && [c.args[0]].flat().includes(key)).length;
  assert.equal(reads('workspaces'), 1);
  assert.equal(reads('backup'), 1);
  const tabs = await b.chrome.tabs.query({ windowId: main });
  const set = (name) => new Map(calls.filter((c) => c.name === name).map((c) => [c.args[0].tabId, c.args[0]]));
  const badges = set('action.setBadgeText');
  const titles = set('action.setTitle');
  for (const t of tabs) {
    assert.equal(badges.get(t.id)?.text, '1');
    assert.equal(titles.get(t.id)?.title, 'Workspace: B – 1 Tab nicht wiederhergestellt');
  }
});

// So meldet der Browser, dass gerade ein Tab gezogen wird
const DRAGGING = 'Tabs cannot be edited right now (user may be dragging a tab).';

test('Während ein Tab gezogen wird: Anlegen und Gruppieren werden kurz darauf wiederholt', async () => {
  const env = await fromBackup();
  const { b } = env;
  const main = b.mains()[0].id;
  const create = b.fail('tabs.create', { when: (o) => o.url === url('b2'), times: 3, message: DRAGGING });
  const group = b.fail('tabs.group', { times: 2, message: DRAGGING });
  await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids.B }));
  assert.equal(create.hits, 3);
  assert.equal(group.hits, 2);
  assert.equal(b.local.data.backup[env.ids.B].failed, undefined, 'Tab wurde trotz Wiederholung aufgegeben');
  check(env, ALL);
});

test('Dauert das Ziehen zu lange, wird der Tab aufbewahrt statt verworfen', async () => {
  const env = await fromBackup();
  const { b } = env;
  const main = b.mains()[0].id;
  b.fail('tabs.create', { when: (o) => o.url === url('c1'), times: Infinity, message: DRAGGING });
  await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids.C }));
  assert.deepEqual(b.local.data.backup[env.ids.C].failed.map((e) => e.url), [url('c1')]);
  check(env, { ...ALL, C: [] });
});

test('Eine Gruppe lässt sich nicht anlegen: Tabs werden aufbewahrt und als Gruppe nachgeholt', async () => {
  const env = await fromBackup();
  const { b } = env;
  const main = b.mains()[0].id;
  b.fail('tabs.group');
  await ok(env.w.request({ type: 'switch', windowId: main, wsId: env.ids.B }));
  const failed = b.local.data.backup[env.ids.B].failed;
  assert.deepEqual(failed.map((e) => e.url).sort(), [url('b1'), url('b2')]);
  check(env, { ...ALL, B: ['b3'] });
  await ok(env.w.request({ type: 'retry', windowId: main, wsId: env.ids.B }));
  check(env, ALL);
});

// Endet der Worker, nachdem b1 angelegt ist, legt der nächste b2 und b3 an. Mit
// api = 'tabGroups.update' endet er erst, wenn alle Tabs da sind und die Gruppe noch
// ohne Titel und Farbe ist.
async function killedWhileRestoring(api = 'tabs.create') {
  const env = await fromBackup();
  const { b } = env;
  const main = b.mains()[0].id;
  if (api === 'tabs.create') b.fail(api, { hang: true, after: 1, when: (o) => o.windowId === main });
  else b.fail(api, { hang: true });
  env.w.send({ type: 'switch', windowId: main, wsId: env.ids.B });
  await env.w.settle();
  assert.equal(b.session.data.pendingSwitch?.restoring, true);
  const w = b.startWorker(null);
  await w.settle();
  assert.equal(shows(env, main), 'B');
  return { env, main, w };
}

test('Service Worker endet beim Anlegen aus der Sicherung: der Rest wird ohne Doppel ergänzt', async () => {
  const { env, main, w } = await killedWhileRestoring();
  check(env, ALL, { groups: false });
  await ok(w.request({ type: 'switch', windowId: main, wsId: env.ids.A }));
  check(env, ALL, { groups: false });
});

test('Service Worker endet beim Anlegen aus der Sicherung: die Gruppe bleibt ganz', async () => {
  for (const api of ['tabs.create', 'tabGroups.update']) {
    const { env, main, w } = await killedWhileRestoring(api);
    check(env, ALL);
    await ok(w.request({ type: 'switch', windowId: main, wsId: env.ids.A }));
    check(env, ALL);
  }
});

test('Scheiternder Speicherzugriff beim Sichern hinterlässt keine halbe Sicherung', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const saved = backupJson(env);
  b.fail('storage.local.set', { when: (o) => 'backupWindows' in o });
  await b.chrome.tabs.create({ windowId: win, url: url('a5'), active: false });
  await w.settle();
  assert.equal(backupJson(env), saved);
  // Die nächste Änderung sichert wieder vollständig
  await b.chrome.tabs.create({ windowId: win, url: url('a6'), active: false });
  await w.settle();
  check(env, { ...ALL, A: [...SPEC.workspaces.A, 'a5', 'a6'] });
});

test('Scheitert das Speichern der Sicherung, meldet das Popup es, bis es wieder gelingt', async () => {
  const env = await setup(SPEC);
  const { b, w, win } = env;
  const saved = backupJson(env);
  const quota = b.fail('storage.local.set', {
    when: (items) => 'backupPinned' in items,
    times: Infinity,
    message: 'Resource::kQuotaBytes quota exceeded',
  });
  await b.chrome.tabs.create({ windowId: win, url: url('x1'), active: false });
  await w.settle();
  assert.ok(quota.hits > 0, 'Sicherung wurde nicht versucht');
  assert.equal(backupJson(env), saved);
  const { backupError } = await ok(w.request({ type: 'state', windowId: win }));
  assert.match(backupError?.message || '', /quota exceeded/);
  const since = backupError.since;

  // Weitere Fehlschläge behalten den Zeitpunkt des ersten
  await w.advance(5000);
  await b.chrome.tabs.create({ windowId: win, url: url('x2'), active: false });
  await w.settle();
  assert.equal((await ok(w.request({ type: 'state', windowId: win }))).backupError?.since, since);

  quota.left = 0;
  await b.chrome.tabs.create({ windowId: win, url: url('x3'), active: false });
  await w.settle();
  assert.equal((await ok(w.request({ type: 'state', windowId: win }))).backupError, null);
  assert.match(backupJson(env), /x1\.test.*x2\.test.*x3\.test/);
});

test('Ablage lässt sich beim Löschen nicht schließen: Workspace bleibt, kein „Wiederhergestellt“', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const stashC = stashOf(env, 'C').id;
  const saved = backupJson(env);
  b.fail('windows.remove', { when: (id) => id === stashC, message: 'Fenster gescheitert (Test)' });
  const reply = await w.request({ type: 'delete', wsId: ids.C });
  assert.equal(reply.ok, false, 'Fehler beim Schließen der Ablage wurde verschluckt');
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['A', 'B', 'C']);
  assert.equal(backupJson(env), saved);
  // Rückgängig böte sonst einen Workspace an, den es noch gibt
  assert.equal(b.local.data.deleted, undefined);
  check(env, ALL);
  // Ein erneuter Versuch löscht den Workspace
  await ok(w.request({ type: 'delete', wsId: ids.C }));
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['A', 'B']);
  delete env.ids.C;
  check(env, { A: SPEC.workspaces.A, B: SPEC.workspaces.B, pinned: SPEC.pinned });
});

test('Scheitert beim Löschen das Aufbewahren für Rückgängig, bleiben auch ungesicherte Tabs erhalten (#80)', async () => {
  const env = await setup(SPEC);
  const { b, w, ids, win } = env;
  // Ohne abzuwarten: Die verzögerte Sicherung kennt c2 noch nicht
  await b.chrome.tabs.create({ windowId: stashOf(env, 'C').id, url: url('c2'), active: false });
  b.fail('storage.local.set', { when: (items) => 'deleted' in items, message: 'Speichern gescheitert (Test)' });
  const reply = await w.request({ type: 'delete', wsId: ids.C });
  assert.equal(reply.ok, false);
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['A', 'B', 'C']);
  const expected = { ...ALL, C: ['c1', 'c2'] };
  check(env, expected);
  await ok(w.request({ type: 'switch', windowId: win, wsId: ids.C }));
  check(env, expected);
});

test('Während ein Tab gezogen wird: Schließen der Ablage beim Löschen wird wiederholt', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const remove = b.fail('windows.remove', { times: 3, message: DRAGGING });
  await ok(w.request({ type: 'delete', wsId: ids.C }));
  assert.equal(remove.hits, 3);
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['A', 'B']);
  delete env.ids.C;
  check(env, { A: SPEC.workspaces.A, B: SPEC.workspaces.B, pinned: SPEC.pinned });
});

test('Ist die Ablage beim Löschen schon geschlossen, gilt das als Erfolg', async () => {
  const env = await setup(SPEC);
  const { b, w, ids } = env;
  const stashC = stashOf(env, 'C').id;
  b.during('windows.remove', (id) => b.removeWindow(id), { when: (id) => id === stashC });
  await ok(w.request({ type: 'delete', wsId: ids.C }));
  assert.deepEqual(b.local.data.workspaces.map((x) => x.name), ['A', 'B']);
  delete env.ids.C;
  check(env, { A: SPEC.workspaces.A, B: SPEC.workspaces.B, pinned: SPEC.pinned });
});

// Scheitert beim Schließen des letzten Fensters die nachgeholte Sicherung, gingen mit den
// Ablagen auch Tab-Änderungen seit der letzten Sicherung verloren (hier b3 → b4).
test('Sicherung scheitert beim Schließen des letzten Fensters: Ablagen bleiben offen und sichtbar', async () => {
  const env = await setup(SPEC);
  const { b, w, win, ids } = env;
  await w.settle();
  const nav = { url: url('b4') };
  await b.chrome.tabs.update(where(env, 'b3').tab.id, nav);
  await w.advance(10);
  const set = b.fail('storage.local.set');
  await b.closeWindowByX(win);
  await w.settle();
  assert.equal(set.hits, 1, 'Sicherung beim Schließen wurde nicht versucht');
  for (const name of ['B', 'C']) {
    const page = stashOf(env, name)?.tabs[0];
    assert.ok(page, `Ablage von ${name} wurde geschlossen`);
    // Ohne Schlüssel im Titel (stash.js) zeigt das KWin-Skript das Fenster wieder
    assert.equal(page.url, `${b.origin}stash.html?shown#${ids[name]}`, `Ablage von ${name} ist nicht sichtbar gemacht`);
  }
  assert.equal(where(env, 'b4').stash, true);

  // Nach dem Neustart sind die Ablagen wieder versteckt, b4 ist noch da
  b.restart();
  await b.startWorker('startup').settle();
  b.calls = b.calls.filter((c) => !(c.name === 'tabs.update' && (c.args[1]?.url === nav.url || c.args[1]?.url?.startsWith(`${b.origin}stash.html`))));
  check(env, { ...ALL, B: [...SPEC.workspaces.B.slice(0, 2), 'b4'] });
  for (const name of ['B', 'C']) assert.equal(stashOf(env, name).tabs[0].url, `${b.origin}stash.html#${ids[name]}`);
});
