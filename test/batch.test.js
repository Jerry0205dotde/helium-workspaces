'use strict';
// Große Workspaces aus der Sicherung: Es laden höchstens sechs angelegte Tabs gleichzeitig,
// die übrigen kommen nach und nach (#158). Der noch nicht angelegte Rest steht in der
// Sicherung und übersteht Wechsel, Neustarts des Service Workers und des Browsers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, check, ok, url, shows } = require('./harness');

const B = Array.from({ length: 20 }, (_, i) => `b${i + 1}`);
// Die Gruppe reicht über die Grenze des ersten Schubs hinaus
const BIG = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', 'a2'],
    B: B.map((n, i) => (i >= 3 && i < 9 ? { url: n, group: 'Mathe', color: 'blue' } : n)),
  },
};
const ALL = { ...BIG.workspaces, pinned: BIG.pinned };

const open = (b) => B.filter((n) => b.tabsByUrl(url(n)).length);
const loading = (b) => b.windows.flatMap((w) => w.tabs).filter((t) => t.loading && B.some((n) => url(n) === t.url)).length;
const backupOf = (env) => {
  const s = env.b.local.data.backup[env.ids.B];
  return [...(s.shown || []), ...(s.stash || []), ...(s.later || [])].map((e) => e.url);
};
// Tabs von B in ihrer Reihenfolge, wo immer sie liegen
const order = (env) => {
  const { b } = env;
  return b.windows.flatMap((w) => w.tabs.map((t) => t.url)).filter((u) => B.some((n) => url(n) === u));
};

// Lässt eine Sekunde vergehen: settle() ohne Grenze ließe auch die Wartezeit für Tabs
// ablaufen, die nicht fertig laden
const tick = (env) => env.b.worker.advance(1000);
async function request(env, msg) {
  let reply = null;
  env.b.worker.send(msg).then((r) => (reply = r));
  await tick(env);
  return ok(reply);
}

// Start ohne Sitzungswiederherstellung mit zurückgehaltenen Ladevorgängen: A kommt beim
// Start aus der Sicherung, B beim Wechseln
async function startHeld(spec = BIG) {
  const env = await setup(spec);
  const { b } = env;
  b.restart({ restore: 'none' });
  b.holdLoads = true;
  const w = b.startWorker('startup');
  await w.advance(1000);
  const main = b.mains()[0].id;
  assert.equal(shows(env, main), 'A');
  await request(env, { type: 'switch', windowId: main, wsId: env.ids.B });
  return { env, main };
}

// Lässt die Tabs einzeln fertig laden, bis alle von B angelegt sind
async function loadOneByOne(env, onStep = () => {}) {
  const { b } = env;
  for (let i = 0; i < 40 && open(b).length < B.length; i++) {
    b.loadOnly(1);
    await tick(env);
    assert.ok(loading(b) <= 6, `${loading(b)} Tabs laden gleichzeitig`);
    await onStep(i);
  }
  assert.equal(open(b).length, B.length, 'nicht alle Tabs wurden angelegt');
  b.releaseLoads();
  await b.worker.settle();
}

test('Aus der Sicherung laden höchstens sechs Tabs gleichzeitig, der Rest folgt in Reihenfolge und Gruppe', async () => {
  const { env, main } = await startHeld();
  const { b } = env;
  assert.equal(shows(env, main), 'B');
  // A (zwei Tabs) lädt noch: B bekommt die übrigen vier Plätze
  assert.deepEqual(open(b), B.slice(0, 4));
  assert.equal(b.windows.flatMap((w) => w.tabs).filter((t) => t.loading && !t.pinned).length, 6);
  // Die Sicherung kennt weiterhin alle Tabs, jeden einmal
  assert.deepEqual(backupOf(env), B.map(url));
  const st = await request(env, { type: 'state', windowId: main });
  assert.equal(st.workspaces.find((x) => x.id === env.ids.B).count, B.length);

  await loadOneByOne(env, () => assert.deepEqual(backupOf(env).sort(), B.map(url).sort(), 'Sicherung unvollständig oder doppelt'));
  assert.deepEqual(order(env), B.map(url));
  assert.equal(b.local.data.backup[env.ids.B].later, undefined);
  // Fertig geladene Tabs wurden entladen, bis auf den aktiven
  const live = B.map((n) => b.tabsByUrl(url(n))[0]);
  assert.deepEqual(
    live.filter((t) => !t.discarded).map((t) => t.url),
    live.filter((t) => t.active).map((t) => t.url),
  );
  check(env, ALL);
});

test('Lädt ein Tab nicht fertig, kommt der nächste nach einer Wartezeit', async () => {
  const { env } = await startHeld();
  const { b } = env;
  assert.deepEqual(open(b), B.slice(0, 4));
  await b.worker.advance(10000);
  assert.deepEqual(open(b), B.slice(0, 4), 'zu früh nachgelegt');
  await b.worker.advance(6000);
  assert.deepEqual(open(b), B.slice(0, 10));
  await b.worker.advance(60000);
  assert.deepEqual(open(b), B);
  b.releaseLoads();
  await b.worker.settle();
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
});

test('Neustart des Service Workers, während Tabs zurückgestellt sind: der Rest kommt trotzdem, nichts doppelt', async () => {
  const { env } = await startHeld();
  const { b } = env;
  assert.deepEqual(open(b), B.slice(0, 4));
  await loadOneByOne(env, async (i) => {
    if (i === 3) {
      b.startWorker(null);
      await tick(env);
    }
  });
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
});

test('Wechsel weg, während Tabs zurückgestellt sind: der Rest kommt in die Ablage', async () => {
  const { env, main } = await startHeld();
  const { b } = env;
  await loadOneByOne(env, async (i) => {
    if (i === 2) await request(env, { type: 'switch', windowId: main, wsId: env.ids.A });
  });
  assert.equal(shows(env, main), 'A');
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
  await ok(b.worker.request({ type: 'switch', windowId: main, wsId: env.ids.B }));
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
});

test('Browser beendet, während Tabs zurückgestellt sind: nach dem Start kommt der Rest', async () => {
  for (const restore of ['now', 'none']) {
    const { env } = await startHeld();
    const { b } = env;
    b.loadOnly(2);
    await tick(env);
    const before = open(b).length;
    assert.ok(before < B.length);
    b.restart({ restore });
    b.holdLoads = false;
    const w = b.startWorker('startup');
    await w.settle();
    if (restore === 'none') await ok(w.request({ type: 'switch', windowId: b.mains()[0].id, wsId: env.ids.B }));
    assert.deepEqual(order(env), B.map(url), restore);
    check(env, ALL);
  }
});

test('Fenster eines Workspace bewusst geschlossen, während Tabs zurückgestellt sind: der Rest kommt nicht mehr', async () => {
  const env = await setup(BIG);
  const { b } = env;
  b.restart({ restore: 'none' });
  b.holdLoads = true;
  b.startWorker('startup');
  await tick(env);
  const main = b.mains()[0].id;
  // Zweites Fenster (zeigt A), damit das Schließen von B nicht den Browser beendet
  const other = b.createWindow();
  await tick(env);
  assert.equal(shows(env, other.id), 'A');
  await request(env, { type: 'switch', windowId: main, wsId: env.ids.B });
  assert.deepEqual(open(b), B.slice(0, 4));
  await b.chrome.windows.remove(main);
  b.releaseLoads();
  await b.worker.settle();
  assert.deepEqual(open(b), []);
  assert.deepEqual(backupOf(env), []);
});

test('Service Worker endet mitten im Nachlegen: schon angelegte Tabs kommen nicht doppelt', async () => {
  const { env } = await startHeld();
  const { b } = env;
  // Zwei Plätze frei (zuerst lädt der angeheftete p1): b5 und b6 kommen in einem Zug. Der
  // Worker endet, als b6 angelegt wird, bevor er sich merken kann, dass beide nicht mehr
  // zurückgestellt sind.
  b.during('tabs.create', () => b.worker.kill(), { when: (p) => p.url === url('b6') });
  b.loadOnly(3);
  await tick(env);
  assert.deepEqual(open(b), B.slice(0, 6));
  b.startWorker(null);
  await tick(env);
  await loadOneByOne(env);
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
});

test('Absturz während des Nachlegens, dann „Wiederherstellen“: Was Chromium nicht kannte, bleibt (#158)', async () => {
  const { env } = await startHeld();
  const { b } = env;
  b.loadOnly(3);
  await tick(env);
  assert.deepEqual(open(b), B.slice(0, 6));
  b.restart({ restore: 'crash' });
  b.holdLoads = false;
  b.startWorker('startup');
  await tick(env);
  b.restoreAfterCrash();
  await b.worker.settle();
  assert.equal(b.mains().length, 1);
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
});

test('Absturz, Aufbau aus der Sicherung und „Wiederherstellen“ mitten im Nachlegen: nichts doppelt, nichts fehlt', async () => {
  for (const fed of [0, 2]) {
    const env = await setup(BIG);
    const { b } = env;
    await ok(b.worker.request({ type: 'switch', windowId: env.win, wsId: env.ids.B }));
    b.restart({ restore: 'crash' });
    b.holdLoads = true;
    b.startWorker('startup');
    await tick(env);
    assert.deepEqual(open(b), B.slice(0, 6));
    b.loadOnly(fed && fed + 1); // zuerst lädt der angeheftete p1
    await tick(env);
    assert.equal(open(b).length, 6 + fed);
    b.restoreAfterCrash();
    await tick(env);
    b.releaseLoads();
    await b.worker.settle();
    assert.deepEqual(order(env).sort(), B.map(url).sort(), `nachgelegt: ${fed}`);
    assert.equal(b.local.data.backup[env.ids.B].later, undefined);
    check(env, ALL);
  }
});

test('Mit „Ablagen stummschalten“ sind auch in die Ablage nachgelegte Tabs gleich stumm', async () => {
  // Löschen und Rückgängig: B steht nur noch in der Sicherung (ohne Startkopien, deren
  // Abgleich die Stummschaltung sonst nebenbei nachholt)
  const env = await setup(BIG);
  const { b, win } = env;
  await request(env, { type: 'muteStash', on: true });
  await request(env, { type: 'delete', wsId: env.ids.B });
  await request(env, { type: 'undoDelete' });
  b.holdLoads = true;
  await request(env, { type: 'switch', windowId: win, wsId: env.ids.B });
  assert.deepEqual(open(b), B.slice(0, 6));
  await request(env, { type: 'switch', windowId: win, wsId: env.ids.A });
  const loud = () => open(b).filter((n) => !b.tabsByUrl(url(n))[0].mutedInfo?.muted);
  await loadOneByOne(env, () => assert.deepEqual(loud(), []));
  assert.deepEqual(loud(), []);
  check(env, ALL);
});

test('Service Worker endet mitten im Nachlegen, nachdem ein Tab gescheitert ist: die übrigen kommen nicht doppelt', async () => {
  const { env } = await startHeld();
  const { b } = env;
  b.fail('tabs.create', { when: (p) => p.url === url('b5') });
  b.during('tabs.create', () => b.worker.kill(), { when: (p) => p.url === url('b7') });
  b.loadOnly(4);
  await tick(env);
  b.startWorker(null);
  await tick(env);
  b.releaseLoads();
  await b.worker.settle();
  const rest = B.filter((n) => n !== 'b5');
  assert.deepEqual(order(env), rest.map(url));
  assert.deepEqual(b.local.data.backup[env.ids.B].failed.map((e) => e.url), [url('b5')]);
});

test('Wechsel gleich nach dem Ende des Service Workers mitten im Nachlegen: nichts doppelt, nichts im falschen Workspace', async () => {
  const { env, main } = await startHeld();
  const { b } = env;
  b.during('tabs.create', () => b.worker.kill(), { when: (p) => p.url === url('b6') });
  b.loadOnly(3);
  await tick(env);
  b.startWorker(null);
  let reply = null;
  b.worker.send({ type: 'switch', windowId: main, wsId: env.ids.A }).then((r) => (reply = r));
  await tick(env);
  assert.equal(reply?.ok, true);
  assert.equal(shows(env, main), 'A');
  await loadOneByOne(env);
  assert.deepEqual(order(env), B.map(url));
  check(env, ALL);
});

test('Absturz während des Nachlegens und „Wiederherstellen“: getrennte Gruppen mit gleichem Titel bleiben getrennt', async () => {
  const spec = {
    pinned: ['p1'],
    workspaces: {
      A: ['a1', 'a2'],
      B: B.map((n, i) => (i >= 3 && i < 9 ? { url: n, group: 'G1' } : i >= 9 && i < 15 ? { url: n, group: 'G2' } : n)),
    },
  };
  const env = await setup(spec);
  const { b } = env;
  // Beide Gruppen ohne Titel und grau
  for (const g of b.groups.values()) await b.chrome.tabGroups.update(g.id, { title: '', color: 'grey' });
  await b.worker.settle();
  b.restart({ restore: 'none' });
  b.holdLoads = true;
  b.startWorker('startup');
  await tick(env);
  await request(env, { type: 'switch', windowId: b.mains()[0].id, wsId: env.ids.B });
  b.loadOnly(3);
  await tick(env);
  assert.deepEqual(open(b), B.slice(0, 6));
  b.restart({ restore: 'crash' });
  b.holdLoads = false;
  b.startWorker('startup');
  await tick(env);
  b.restoreAfterCrash();
  await b.worker.settle();
  assert.deepEqual(order(env), B.map(url));
  const gid = (n) => b.tabsByUrl(url(n))[0].groupId;
  const groupOf = (names) => [...new Set(names.map(gid))];
  assert.equal(groupOf(B.slice(3, 9)).length, 1, 'erste Gruppe zerteilt');
  assert.equal(groupOf(B.slice(9, 15)).length, 1, 'zweite Gruppe zerteilt');
  assert.notEqual(gid('b4'), gid('b10'), 'getrennte Gruppen zusammengelegt');
  assert.ok(gid('b4') >= 0 && gid('b10') >= 0);
});

test('Absturz während des Nachlegens und „Wiederherstellen“: dieselbe Adresse in zwei Gruppen führt nicht in die falsche', async () => {
  // b5 hat dieselbe Adresse wie b2, liegt aber in der anderen Gruppe
  const names = B.map((n) => (n === 'b5' ? 'b2' : n));
  const color = (i) => (i >= 1 && i < 3 ? 'blue' : i >= 3 && i < 9 ? 'red' : null);
  const spec = {
    pinned: ['p1'],
    workspaces: { A: ['a1', 'a2'], B: names.map((n, i) => (color(i) ? { url: n, group: color(i), color: color(i) } : n)) },
  };
  const env = await setup(spec);
  const { b } = env;
  b.restart({ restore: 'none' });
  b.holdLoads = true;
  b.startWorker('startup');
  await tick(env);
  await request(env, { type: 'switch', windowId: b.mains()[0].id, wsId: env.ids.B });
  b.loadOnly(3);
  await tick(env);
  b.restart({ restore: 'crash' });
  b.holdLoads = false;
  b.startWorker('startup');
  await tick(env);
  b.restoreAfterCrash();
  await b.worker.settle();
  const tabs = b.mains()[0].tabs.filter((t) => !t.pinned);
  assert.deepEqual(tabs.map((t) => t.url), names.map(url));
  const groupColor = (t) => (t.groupId >= 0 ? b.groups.get(t.groupId).color : null);
  assert.deepEqual(tabs.map(groupColor), names.map((_, i) => color(i)));
  assert.equal(new Set(tabs.filter((t, i) => color(i) === 'red').map((t) => t.groupId)).size, 1, 'rote Gruppe zerteilt');
});
