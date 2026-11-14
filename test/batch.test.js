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
async function startHeld() {
  const env = await setup(BIG);
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
