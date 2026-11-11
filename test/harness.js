'use strict';
// Aufbau typischer Ausgangslagen und Prüfung der Invarianten, die nach jeder Aktion
// gelten müssen: Jeder Tab ist genau einmal vorhanden, steht im richtigen Workspace,
// Gruppen und angeheftete Tabs sind erhalten und die Sicherung entspricht dem Bestand.

const assert = require('node:assert/strict');
const { Browser, NEWTAB } = require('./fake-browser');

const url = (name) => `https://${name}.test/`;

// Ein Eintrag der Erwartung: 'a1' oder { url: 'a1', group: 'Mathe', color: 'blue' }
const norm = (item) => (typeof item === 'string' ? { url: url(item) } : { ...item, url: url(item.url) });

async function openTabs(b, windowId, items) {
  const groups = new Map();
  for (const it of items.map(norm)) {
    const t = await b.chrome.tabs.create({ windowId, url: it.url, active: false });
    if (it.group) {
      if (!groups.has(it.group)) groups.set(it.group, { color: it.color || 'grey', collapsed: !!it.collapsed, ids: [] });
      groups.get(it.group).ids.push(t.id);
    }
  }
  for (const [title, g] of groups) {
    const gid = await b.chrome.tabs.group({ tabIds: g.ids });
    await b.chrome.tabGroups.update(gid, { title, color: g.color, collapsed: g.collapsed });
  }
}

// spec: { pinned: ['p1'], workspaces: { A: [...], B: [...] } }. Baut den Zustand über die
// Erweiterung selbst auf: erster Workspace im vorhandenen Fenster, jeder weitere wird
// angelegt, angezeigt und befüllt. Am Ende zeigt das Fenster wieder den ersten.
async function setup(spec) {
  const b = new Browser();
  const names = Object.keys(spec.workspaces);
  const win = b.createWindow({ url: NEWTAB });
  for (const p of spec.pinned || []) {
    const t = await b.chrome.tabs.create({ windowId: win.id, url: url(p), active: false });
    await b.chrome.tabs.update(t.id, { pinned: true });
  }
  await openTabs(b, win.id, spec.workspaces[names[0]]);
  await closeNewTabs(b, win.id);

  const w = b.startWorker('installed');
  await w.settle();
  const ids = {};
  ids[names[0]] = b.local.data.workspaces[0].id;
  await ok(w.request({ type: 'update', wsId: ids[names[0]], patch: { name: names[0] } }));
  for (const name of names.slice(1)) {
    ids[name] = (await ok(w.request({ type: 'create', name }))).id;
    await ok(w.request({ type: 'switch', windowId: win.id, wsId: ids[name] }));
    await openTabs(b, win.id, spec.workspaces[name]);
    await closeNewTabs(b, win.id);
    await w.settle();
  }
  if (names.length > 1) await ok(w.request({ type: 'switch', windowId: win.id, wsId: ids[names[0]] }));
  return { b, win: win.id, ids, get w() { return b.worker; } };
}

async function closeNewTabs(b, windowId) {
  for (const t of await b.chrome.tabs.query({ windowId })) if (t.url === NEWTAB) await b.chrome.tabs.remove(t.id);
}

async function ok(replyPromise) {
  const r = await replyPromise;
  assert.ok(r, 'keine Antwort vom Service Worker');
  assert.equal(r.ok, true, `Antwort mit Fehler: ${r.error}`);
  return r.result;
}

// Wo liegt der Tab mit dieser URL? { tab, win, ws, stash }
function where(env, name) {
  const { b } = env;
  const found = b.tabsByUrl(url(name));
  assert.equal(found.length, 1, `${url(name)} ist ${found.length}× vorhanden statt einmal`);
  const win = b.windows.find((w) => w.id === found[0].windowId);
  const stash = b.stashOf(win);
  const ws = stash || b.session.data.windowWs?.[win.id];
  return { tab: found[0], win, ws, stash: !!stash };
}

const nameOf = (env, id) => Object.keys(env.ids).find((n) => env.ids[n] === id) || id;
const sortUrls = (list) => [...list].sort();
const isExtra = (b, u) => u === NEWTAB || u.startsWith(b.origin);

// Prüft den gesamten Bestand gegen expected: { A: [...], B: [...], pinned: [...] }.
// Workspaces ohne Fenster werden gegen ihre Sicherung geprüft. allowNewTab: neue
// Tab-Seiten dürfen zusätzlich vorkommen (z. B. in einem leeren Workspace). groups: false
// lässt die Prüfung der Tab-Gruppen aus.
function check(env, expected, { allowNewTab = true, groups = true } = {}) {
  const { b, w } = env;
  assert.deepEqual(b.errors.map((e) => `${e.name}: ${e.error?.stack || e.error}`), [], 'Fehler in Ereignis-Listenern');
  assert.equal(b.session.data.pendingSwitch, undefined, 'ein Wechsel ist noch nicht abgeschlossen');
  assert.equal(w.eval('switching'), 0, 'switching wurde nicht zurückgesetzt');
  const wsList = b.local.data.workspaces;
  const windowWs = b.session.data.windowWs || {};
  const backup = b.local.data.backup || {};

  // Hauptfenster sind zugeordnet, Ablagen sind eindeutig, minimiert und richtig markiert
  const stashSeen = new Set();
  for (const win of b.windows) {
    const s = b.stashOf(win);
    if (s) {
      assert.ok(!stashSeen.has(s), `zwei Ablagen für ${nameOf(env, s)}`);
      stashSeen.add(s);
      assert.ok(wsList.some((x) => x.id === s), `Ablage ohne Workspace: ${s}`);
      assert.ok(win.tabs[0].url.startsWith(b.origin + 'stash.html'), 'Ablage-Seite ist nicht der erste Tab');
      assert.ok(win.tabs[0].pinned && win.tabs[0].active, 'Ablage-Seite ist nicht angeheftet und aktiv');
      assert.equal(win.state, 'minimized', 'Ablage-Fenster ist nicht minimiert');
      assert.equal(win.tabs.filter((t) => t.url.startsWith(b.origin)).length, 1, 'mehrere Ablage-Seiten in einem Fenster');
    } else {
      assert.ok(wsList.some((x) => x.id === windowWs[win.id]), `Hauptfenster ${win.id} ist keinem Workspace zugeordnet`);
      assert.ok(win.tabs.some((t) => t.active), `Hauptfenster ${win.id} hat keinen aktiven Tab`);
    }
  }

  // Jede URL genau einmal
  const all = b.windows.flatMap((x) => x.tabs.map((t) => t.url)).filter((u) => !isExtra(b, u));
  const want = Object.entries(expected).flatMap(([k, items]) => (k === 'pinned' ? items.map(url) : items.map((i) => norm(i).url)));
  const live = new Set(Object.keys(expected).filter((k) => k !== 'pinned' && isLive(env, k)));
  const wantLive = Object.entries(expected)
    .filter(([k]) => k === 'pinned' || live.has(k))
    .flatMap(([k, items]) => (k === 'pinned' ? items.map(url) : items.map((i) => norm(i).url)));
  assert.deepEqual(sortUrls(all), sortUrls(wantLive), 'offene Tabs weichen ab (fehlend oder doppelt)');
  assert.equal(new Set(want).size, want.length, 'Testfehler: URLs der Erwartung sind nicht eindeutig');

  // Angeheftete Tabs im ersten Hauptfenster
  if (expected.pinned) {
    const main = b.mains()[0];
    if (main) assert.deepEqual(main.tabs.filter((t) => t.pinned).map((t) => t.url), expected.pinned.map(url), 'angeheftete Tabs');
    assert.deepEqual(sortUrls((b.local.data.backupPinned || []).map((e) => e.url)), sortUrls(expected.pinned.map(url)), 'gesicherte angeheftete Tabs');
  }

  for (const [name, items] of Object.entries(expected)) {
    if (name === 'pinned') continue;
    const id = env.ids[name];
    assert.ok(id, `Testfehler: unbekannter Workspace ${name}`);
    const exp = items.map(norm);
    const saved = [...(backup[id]?.shown || []), ...(backup[id]?.stash || [])].filter((e) => !(allowNewTab && e.url === NEWTAB));
    // Sicherung stimmt mit dem Bestand überein
    assert.deepEqual(sortUrls(saved.map((e) => e.url)), sortUrls(exp.map((e) => e.url)), `Sicherung von ${name}`);
    if (live.has(name)) {
      const tabs = liveTabs(env, id).filter((t) => !(allowNewTab && t.url === NEWTAB));
      assert.deepEqual(sortUrls(tabs.map((t) => t.url)), sortUrls(exp.map((e) => e.url)), `Tabs von ${name}`);
      if (groups) checkGroups(name, exp, (u) => {
        const t = tabs.find((x) => x.url === u);
        const g = b.groups.get(t.groupId);
        return t.groupId >= 0 ? { key: t.groupId, title: g.title, color: g.color, collapsed: g.collapsed } : null;
      });
    }
    if (groups) checkGroups(`${name} (Sicherung)`, exp, (u) => {
      const e = saved.find((x) => x.url === u);
      return e.g ? { key: e.g, title: e.gt, color: e.gc, collapsed: e.gx } : null;
    });
  }
}

function checkGroups(label, exp, groupOf) {
  const keys = new Map();
  for (const e of exp) {
    const g = groupOf(e.url);
    if (!e.group) {
      assert.equal(g, null, `${label}: ${e.url} sollte in keiner Gruppe sein`);
      continue;
    }
    assert.ok(g, `${label}: ${e.url} sollte in Gruppe „${e.group}“ sein`);
    assert.equal(g.title, e.group, `${label}: Gruppentitel von ${e.url}`);
    assert.equal(g.color, e.color || 'grey', `${label}: Gruppenfarbe von ${e.url}`);
    assert.equal(!!g.collapsed, !!e.collapsed, `${label}: Gruppe von ${e.url} eingeklappt?`);
    if (!keys.has(e.group)) keys.set(e.group, g.key);
    assert.equal(g.key, keys.get(e.group), `${label}: „${e.group}“ ist auf mehrere Gruppen verteilt`);
  }
  assert.equal(new Set(keys.values()).size, keys.size, `${label}: verschiedene Gruppen teilen sich eine`);
}

function isLive(env, name) {
  const id = env.ids[name];
  const windowWs = env.b.session.data.windowWs || {};
  return env.b.windows.some((w) => env.b.stashOf(w) === id || (!env.b.stashOf(w) && windowWs[w.id] === id));
}

function liveTabs(env, id) {
  const { b } = env;
  const windowWs = b.session.data.windowWs || {};
  return b.windows.flatMap((w) => {
    if (b.stashOf(w) === id) return w.tabs.filter((t) => !t.url.startsWith(b.origin));
    if (!b.stashOf(w) && windowWs[w.id] === id) return w.tabs.filter((t) => !t.pinned);
    return [];
  });
}

// Workspace, den ein Hauptfenster zeigt (Name)
const shows = (env, windowId) => nameOf(env, env.b.session.data.windowWs?.[windowId]);

// Tab-IDs aller offenen Tabs nach URL, um zu prüfen, dass nichts neu geladen wurde
function tabIds(env) {
  const m = {};
  for (const w of env.b.windows) for (const t of w.tabs) if (!isExtra(env.b, t.url)) m[t.url] = t.id;
  return m;
}

module.exports = { setup, check, ok, url, where, shows, tabIds, openTabs, closeNewTabs, NEWTAB };
