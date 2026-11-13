'use strict';
// Die Handschritte aus der README gegen einen echten Chromium: Wechsel mit Gruppe und
// angeheftetem Tab, Neuladen der Erweiterung, Beenden und Neustart mit „Dort
// weitermachen, wo ich aufgehört habe“ und mit „Neuer Tab“, Schließen per X und
// Neustart. Läuft nur, wenn CHROME auf einen Chromium-Browser zeigt, z. B.:
//
//   CHROME=/usr/bin/chromium node --test test/chromium.test.js
//
// Ohne DISPLAY bleibt der Browser unsichtbar. Das Verstecken der Ablagen durch KWin prüft
// dieser Test nicht, nur den Fenstertitel, an dem KWin sie erkennt. Bedient wird die
// Erweiterung über ihren Service Worker (siehe chromium.js), nicht über das Popup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Chromium, EXT_ID, waitFor } = require('./chromium');

const STASH = `chrome-extension://${EXT_ID}/stash.html#`;
const NEWTAB = /^chrome:\/\/(newtab|new-tab-page)\//;

const SPEC = {
  pinned: ['p1'],
  workspaces: {
    A: ['a1', { name: 'a2', group: 'Mathe', color: 'blue' }, { name: 'a3', group: 'Mathe', color: 'blue' }, 'a4'],
    B: ['b1', { name: 'b2', group: 'Lesen', color: 'red', collapsed: true }, { name: 'b3', group: 'Lesen', color: 'red', collapsed: true }],
    C: ['c1', 'c2'],
  },
};

const norm = (e) => (typeof e === 'string' ? { name: e } : e);

// Testseiten von 127.0.0.1. Jeder Abruf wird gezählt: Lädt die Erweiterung einen Tab
// neu, steigt die Zahl.
function startServer() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    hits.set(name, (hits.get(name) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>${name}</title><p>${name}</p>`);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/` })),
  );
}

// Bestand aus Sicht der Erweiterung: Fenster mit Tabs, Gruppen, Workspaces, Zuordnung
// der Hauptfenster und Sicherung
const STATE = `
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const groups = await chrome.tabGroups.query({});
  const { workspaces, backup, token } = await chrome.storage.local.get(['workspaces', 'backup', 'token']);
  const { windowWs, pendingSwitch } = await chrome.storage.session.get(['windowWs', 'pendingSwitch']);
  return {
    windows: wins.map((w) => ({
      id: w.id,
      state: w.state,
      tabs: w.tabs.map((t) => ({ id: t.id, url: t.url || t.pendingUrl, title: t.title, pinned: t.pinned, groupId: t.groupId, status: t.status, discarded: t.discarded })),
    })),
    groups,
    workspaces: workspaces || [],
    windowWs: windowWs || {},
    backup: backup || {},
    token,
    pending: !!pendingSwitch,
  };`;

class Env {
  constructor(bin, base) {
    this.base = base;
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-chromium-'));
    this.browser = new Chromium(bin, this.profile);
    this.ids = {};
  }

  name(url) {
    return url.startsWith(this.base) ? url.slice(this.base.length) : url;
  }

  state() {
    return this.browser.sw(STATE);
  }

  // Einträge eines Workspace oder der angehefteten Tabs als lesbare Zeichenketten,
  // z. B. 'a2 [Mathe blue]' oder 'b2 [Lesen red zu]'
  label(e) {
    const g = e.group ? ` [${e.group} ${e.color}${e.collapsed ? ' zu' : ''}]` : '';
    return e.name + g;
  }

  // Prüft den ganzen Bestand gegen SPEC: Ein Workspace besteht aus den Tabs im
  // Hauptfenster, das ihn zeigt, und denen in seiner Ablage (die bleibt beim Zeigen leer
  // bestehen). Jeder Workspace muss so in der Sicherung stehen. Workspaces ohne Fenster
  // gibt es nur in der Sicherung, außer live: true verlangt für jeden ein Fenster.
  check(st, { live = false } = {}) {
    assert.equal(st.pending, false, 'ein Wechsel ist noch nicht abgeschlossen');
    const groups = new Map(st.groups.map((g) => [g.id, g]));
    const entry = (t) => {
      const g = groups.get(t.groupId);
      return this.label({ name: this.name(t.url), group: g?.title, color: g?.color, collapsed: g?.collapsed });
    };
    const nameOf = (id) => st.workspaces.find((x) => x.id === id)?.name;
    assert.deepEqual(st.workspaces.map((w) => w.name).sort(), Object.keys(SPEC.workspaces).sort(), 'Workspaces');
    const shown = {};
    const stashed = {};
    for (const w of st.windows) {
      const first = w.tabs[0];
      if (first?.url?.startsWith(STASH)) {
        const name = nameOf(first.url.slice(STASH.length));
        assert.ok(name, `Ablage ohne Workspace: ${first.url}`);
        assert.ok(!stashed[name], `zwei Ablagen für ${name}`);
        assert.ok(first.pinned, `Ablage-Seite von ${name} ist nicht angeheftet`);
        // An diesem Titel erkennt das KWin-Skript die Ablage
        assert.equal(first.title, `HWS-Ablage ${st.token} · ${name}`, 'Titel der Ablage');
        assert.equal(w.state, 'minimized', `Ablage von ${name} ist nicht minimiert`);
        stashed[name] = w.tabs.slice(1).map(entry);
      } else {
        const name = nameOf(st.windowWs[w.id]);
        assert.ok(name, `Hauptfenster ${w.id} ist keinem Workspace zugeordnet`);
        assert.ok(!shown[name], `zwei Hauptfenster zeigen ${name}`);
        const pinned = w.tabs.filter((t) => t.pinned).map(entry);
        assert.deepEqual(pinned, SPEC.pinned.map((n) => this.label(norm(n))), 'angeheftete Tabs');
        shown[name] = w.tabs.filter((t) => !t.pinned && !NEWTAB.test(t.url)).map(entry);
      }
    }
    const mains = Object.keys(shown);
    assert.equal(mains.length, 1, `ein Hauptfenster erwartet, gefunden: ${mains.join(', ')}`);
    for (const w of st.workspaces) {
      const want = SPEC.workspaces[w.name].map((e) => this.label(norm(e)));
      const b = st.backup[w.id];
      const saved = [...(b?.shown || []), ...(b?.stash || [])].filter((e) => !NEWTAB.test(e.url));
      const got = saved.map((e) => this.label({ name: this.name(e.url), group: e.gt, color: e.gc, collapsed: e.gx }));
      assert.deepEqual(got, want, `Sicherung von ${w.name}`);
      if (shown[w.name] || stashed[w.name]) {
        assert.deepEqual([...(shown[w.name] || []), ...(stashed[w.name] || [])], want, `Tabs von ${w.name}`);
      } else {
        assert.ok(!live, `${w.name} hat kein Fenster`);
      }
    }
    return { main: st.windows.find((w) => !w.tabs[0]?.url?.startsWith(STASH)), shows: mains[0] };
  }

  // Fenster und Tabs in Kurzform, für Fehlermeldungen
  describe(st) {
    const ws = (id) => st.workspaces.find((x) => x.id === id)?.name || id;
    return st.windows
      .map((w) => {
        const first = w.tabs[0]?.url || '';
        const head = first.startsWith(STASH) ? `Ablage ${ws(first.slice(STASH.length))}` : `Hauptfenster ${ws(st.windowWs[w.id])}`;
        const tabs = w.tabs.map((t) => `${t.pinned ? '📌' : ''}${this.name(t.url)}${t.groupId >= 0 ? `(g${t.groupId})` : ''}${t.status === 'complete' ? '' : `(${t.status}${t.discarded ? ', verworfen' : ''})`}`);
        return `  ${w.id} ${head} [${w.state}]: ${tabs.join(' ')}`;
      })
      .join('\n');
  }

  // Wartet, bis der Bestand stimmt und alle Seiten geladen sind
  settled(opts) {
    return waitFor(
      async () => {
        const st = await this.state();
        let r;
        try {
          r = this.check(st, opts);
        } catch (e) {
          e.message += `\n${this.describe(st)}`;
          throw e;
        }
        const loading = st.windows.flatMap((w) => w.tabs).filter((t) => t.status !== 'complete');
        assert.deepEqual(loading.map((t) => t.url), [], 'Seiten laden noch');
        return { ...r, st };
      },
      { timeout: 30000 },
    );
  }

  // Wie die Auswahl im Popup (runtime.onMessage, type 'switch')
  async switchTo(name) {
    const { main } = await this.settled();
    await this.browser.action('(w, ws) => switchTo(w, ws)', main.id, this.ids[name]);
    const r = await this.settled();
    assert.equal(r.shows, name, `Hauptfenster zeigt ${r.shows} statt ${name}`);
    return r;
  }

  async cycle(names = ['B', 'C', 'A']) {
    for (const n of names) await this.switchTo(n);
    return this.settled({ live: true });
  }

  async launch(restore) {
    await this.browser.launch({ restore });
    // Die Namen der Workspaces zu ihren IDs, sobald der erste Abgleich gelaufen ist
    const st = await waitFor(async () => {
      const s = await this.state();
      assert.ok(Object.keys(s.windowWs).length, 'noch kein Hauptfenster zugeordnet');
      return s;
    });
    for (const w of st.workspaces) this.ids[w.name] = w.id;
  }
}

// Legt Tabs im Fenster an, gruppiert und heftet an wie von Hand
async function openTabs(env, windowId, items, pinned = false) {
  await env.browser.sw(
    `const [windowId, items, base, pinned] = args;
     const groups = new Map();
     for (const it of items) {
       const t = await chrome.tabs.create({ windowId, url: base + it.name, active: false, pinned });
       if (it.group) {
         if (!groups.has(it.group)) groups.set(it.group, { ...it, ids: [] });
         groups.get(it.group).ids.push(t.id);
       }
     }
     for (const [title, g] of groups) {
       const groupId = await chrome.tabs.group({ tabIds: g.ids });
       await chrome.tabGroups.update(groupId, { title, color: g.color, collapsed: !!g.collapsed });
     }
     const blank = await chrome.tabs.query({ windowId, pinned: false });
     const fresh = blank.filter((t) => /^chrome:\\/\\/(newtab|new-tab-page)\\//.test(t.url || t.pendingUrl));
     if (fresh.length) await chrome.tabs.remove(fresh.map((t) => t.id));`,
    windowId,
    items.map(norm),
    env.base,
    pinned,
  );
}

const bin = process.env.CHROME;

test('Echter Chromium: Wechsel, Neuladen, Neustart und Schließen per X', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 600000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const env = new Env(bin, base);
  const b = env.browser;
  t.after(async () => {
    await b.kill();
    server.close();
    fs.rmSync(env.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  // Schritte bauen aufeinander auf: Nach einem Fehler werden die übrigen übersprungen
  let broken = false;
  const step = (name, fn) =>
    t.test(name, { skip: broken && 'ein vorheriger Schritt ist fehlgeschlagen' }, async () => {
      try {
        await fn();
        assert.deepEqual(b.errors, [], 'unbehandelte Fehler im Service Worker');
      } catch (e) {
        broken = true;
        if (b.log) process.stderr.write(`Ausgabe des Browsers:\n${b.log.split('\n').slice(-40).join('\n')}\n`);
        throw e;
      }
    });

  await step('Aufbau: drei Workspaces mit Gruppen und einem angehefteten Tab', async () => {
    await env.launch('last');
    const st = await env.state();
    assert.equal(st.workspaces.length, 1);
    const win = st.windows[0].id;
    await openTabs(env, win, SPEC.pinned.map(norm), true);
    await openTabs(env, win, SPEC.workspaces.A);
    await b.action('(id) => updateWs(id, { name: "A" })', st.workspaces[0].id);
    for (const name of ['B', 'C']) {
      env.ids[name] = (await b.action('(n) => createWs(n)', name)).id;
      await b.action('(w, ws) => switchTo(w, ws)', win, env.ids[name]);
      await openTabs(env, win, SPEC.workspaces[name]);
    }
    env.ids.A = st.workspaces[0].id;
    await env.switchTo('A');
    await env.settled({ live: true });
  });

  await step('Wechsel hin und her: Gruppen und angehefteter Tab bleiben, nichts lädt neu', async () => {
    const before = await env.settled();
    const loads = new Map(hits);
    const tabIds = before.st.windows.flatMap((w) => w.tabs.map((x) => `${x.id} ${x.url}`)).sort();
    const after = await env.cycle();
    assert.deepEqual(new Map(hits), loads, 'eine Seite wurde neu geladen');
    assert.deepEqual(after.st.windows.flatMap((w) => w.tabs.map((x) => `${x.id} ${x.url}`)).sort(), tabIds, 'Tabs wurden ersetzt');
  });

  await step('Neuladen der Erweiterung: Ablagen werden wiedererkannt, Wechseln geht weiter', async () => {
    const loads = new Map(hits);
    b.sw('chrome.runtime.reload();').catch(() => {});
    await b.attachWorker();
    await env.settled({ live: true });
    await env.cycle();
    assert.deepEqual(new Map(hits), loads, 'eine Seite wurde neu geladen');
  });

  await step('Beenden und Neustart mit „Dort weitermachen, wo ich aufgehört habe“', async () => {
    await env.switchTo('B');
    await b.quit();
    await env.launch('last');
    const r = await env.settled();
    assert.equal(r.shows, 'B');
    await env.cycle(['C', 'A', 'B']);
  });

  await step('Beenden und Neustart mit „Neuer Tab“', async () => {
    await env.switchTo('C');
    await b.quit();
    await env.launch('newtab');
    const r = await env.settled();
    assert.equal(r.shows, 'C');
    await env.cycle(['A', 'B', 'C']);
  });

  for (const restore of ['last', 'newtab']) {
    await step(`Schließen per X und Neustart (${restore === 'last' ? '„Dort weitermachen“' : '„Neuer Tab“'})`, async () => {
      const { main } = await env.switchTo('A');
      // Das letzte Hauptfenster schließen (wie per X): Die Erweiterung schließt die
      // Ablagen mit, damit sich der Browser beendet
      b.sw('await chrome.windows.remove(args[0]);', main.id).catch(() => {});
      await b.waitExit();
      await env.launch(restore);
      const r = await env.settled();
      assert.equal(r.shows, 'A');
      await env.cycle(['B', 'C', 'A']);
    });
  }
});
