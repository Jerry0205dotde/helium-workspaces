'use strict';
// Die Handschritte aus der Doku gegen einen echten Chromium: Wechsel mit Gruppe und
// angeheftetem Tab, Neuladen der Erweiterung, Beenden und Neustart mit „Dort
// weitermachen, wo ich aufgehört habe“ und mit „Neuer Tab“, Schließen per X und
// Neustart, dazu der Umstieg auf die feste Erweiterungs-ID. Läuft nur, wenn CHROME auf
// einen Chromium-Browser zeigt, z. B.:
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
const { Chromium, EXT, EXT_ID, extIdOf, waitFor } = require('./chromium');
const { spawnSync } = require('node:child_process');
const { messages } = require('./i18n');

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

// Testseiten von 127.0.0.1. Jeder Abruf einer Testseite wird gezählt (nicht etwa
// /favicon.ico): Lädt die Erweiterung einen Tab neu, steigt die Zahl.
const PAGES = new Set([...SPEC.pinned, ...Object.values(SPEC.workspaces).flat()].map((e) => norm(e).name));

function startServer() {
  const hits = new Map();
  // /slow schickt den Anfang der Seite und hält den Rest zurück, bis held() ihn freigibt:
  // Die Seite ist übernommen, lädt aber weiter
  const slow = [];
  const server = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (name === 'slow') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.write('<!doctype html><title>slow</title><p>slow');
      slow.push(res);
      return;
    }
    if (PAGES.has(name)) hits.set(name, (hits.get(name) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>${name}</title><p>${name}</p>`);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/`, release: () => slow.splice(0).forEach((r) => r.end()) }),
    ),
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
  constructor(bin, base, ext) {
    this.base = base;
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-chromium-'));
    this.browser = new Chromium(bin, this.profile, ext);
    this.ids = {};
  }

  // Adresse der Ablage-Seite unter der ID, die die Erweiterung gerade hat
  get stash() {
    return `chrome-extension://${this.browser.extId}/stash.html#`;
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

  // Prüft den ganzen Bestand gegen SPEC: Der angezeigte Workspace hat alle Tabs im
  // Hauptfenster (seine Ablage bleibt leer bestehen), die übrigen in ihrer Ablage. Jeder
  // Workspace muss so in der Sicherung stehen. Workspaces ohne Fenster
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
      if (first?.url?.startsWith(this.stash)) {
        const name = nameOf(first.url.slice(this.stash.length));
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
      if (shown[w.name]) {
        assert.deepEqual(shown[w.name], want, `Tabs von ${w.name} im Hauptfenster`);
        assert.deepEqual(stashed[w.name] || [], [], `Ablage des angezeigten Workspace ${w.name} ist nicht leer`);
      } else if (stashed[w.name]) {
        assert.deepEqual(stashed[w.name], want, `Tabs von ${w.name} in der Ablage`);
      } else {
        assert.ok(!live, `${w.name} hat kein Fenster`);
      }
    }
    return { main: st.windows.find((w) => !w.tabs[0]?.url?.startsWith(this.stash)), shows: mains[0] };
  }

  // Fenster und Tabs in Kurzform, für Fehlermeldungen
  describe(st) {
    const ws = (id) => st.workspaces.find((x) => x.id === id)?.name || id;
    return st.windows
      .map((w) => {
        const first = w.tabs[0]?.url || '';
        const head = first.startsWith(this.stash) ? `Ablage ${ws(first.slice(this.stash.length))}` : `Hauptfenster ${ws(st.windowWs[w.id])}`;
        const tabs = w.tabs.map((t) => `${t.pinned ? '📌' : ''}${this.name(t.url)}${t.groupId >= 0 ? `(g${t.groupId})` : ''}${t.status === 'complete' ? '' : `(${t.status}${t.discarded ? ', verworfen' : ''})`}`);
        return `  ${w.id} ${head} [${w.state}]: ${tabs.join(' ')}`;
      })
      .join('\n');
  }

  // Wartet, bis der Bestand stimmt und keine Seite mehr lädt (entladene Tabs, etwa aus
  // der Sicherung angelegte, bleiben ungeladen)
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
        const loading = st.windows.flatMap((w) => w.tabs).filter((t) => t.status === 'loading');
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

// Baut SPEC im ersten Fenster auf, zuletzt zeigt es A
async function build(env, st) {
  const b = env.browser;
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
}

const bin = process.env.CHROME;

test('Echter Chromium: Wechsel, Neuladen, Neustart und Schließen per X', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 600000 }, async (t) => {
  const { server, hits, base, release } = await startServer();
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
    // Texte aus _locales in der Sprache des Browsers, sonst Englisch; $1 und $2 ersetzt
    const lang = await b.sw('return chrome.i18n.getUILanguage();');
    const msgs = messages(lang.startsWith('de') ? 'de' : 'en');
    assert.equal(st.workspaces[0].name, msgs.defaultWorkspace.message, `erster Workspace (${lang})`);
    const where = await b.sw("return tr('exWhereWsNamed', 2, 'X');");
    assert.equal(where, msgs.exWhereWsNamed.message.replace('$1', '2').replace('$2', 'X'));
    // Ohne tabId zeigt das Symbol den Workspace des zuletzt fokussierten Fensters (#187)
    const title = msgs.iconTitle.message.replace('$1', st.workspaces[0].name);
    await waitFor(async () => assert.equal(await b.sw('return chrome.action.getTitle({});'), title, 'Titel ohne Tab'));
    await build(env, st);
  });

  await step('Wechsel hin und her: Gruppen und angehefteter Tab bleiben, nichts lädt neu', async () => {
    const before = await env.settled();
    const loads = new Map(hits);
    const tabIds = before.st.windows.flatMap((w) => w.tabs.map((x) => `${x.id} ${x.url}`)).sort();
    const after = await env.cycle();
    assert.deepEqual(new Map(hits), loads, 'eine Seite wurde neu geladen');
    assert.deepEqual(after.st.windows.flatMap((w) => w.tabs.map((x) => `${x.id} ${x.url}`)).sort(), tabIds, 'Tabs wurden ersetzt');
  });

  await step('Strg+N und Wechsel: die leere neue Tab-Seite kommt nicht in die Ablage (#219)', async () => {
    await env.settled({ live: true });
    const win2 = await b.sw('return (await chrome.windows.create({ focused: true })).id;');
    await waitFor(async () => assert.ok((await env.state()).windowWs[win2], 'neues Fenster ist noch nicht zugeordnet'));
    await b.action('(w, ws) => switchTo(w, ws)', win2, env.ids.B);
    const st = await env.state();
    assert.equal(st.windowWs[win2], env.ids.B);
    const blanks = st.windows.flatMap((w) => w.tabs).filter((x) => NEWTAB.test(x.url));
    assert.deepEqual(blanks.map((x) => x.url), [], `neue Tab-Seite ist geblieben\n${env.describe(st)}`);
    // Zurück zu A, das das erste Fenster zeigt: B geht in seine Ablage, im zweiten Fenster
    // bleibt nur eine neue Tab-Seite, und es wird geschlossen
    await b.action('(w, ws) => switchTo(w, ws)', win2, env.ids.A);
    await b.sw('await chrome.windows.remove(args[0]);', win2);
    await env.cycle();
  });

  await step('Seite lädt noch: Das Symbol zeigt schon den Workspace (#187)', async () => {
    const { main, shows } = await env.settled({ live: true });
    const want = await b.sw('return tr("iconTitle", args[0]);', shows);
    const id = await b.sw('return (await chrome.tabs.create({ windowId: args[0], url: args[1], active: true })).id;', main.id, base + 'slow');
    // Chromium setzt Symbol, Titel und Plakette des Tabs zurück, sobald es die Seite übernimmt
    await waitFor(async () => {
      const t = await b.sw('return chrome.tabs.get(args[0]);', id);
      assert.equal(t.url, base + 'slow');
      assert.equal(t.status, 'loading');
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await b.sw('return (await chrome.tabs.get(args[0])).status;', id), 'loading', 'die Seite ist schon fertig');
    assert.equal(await b.sw('return chrome.action.getTitle({ tabId: args[0] });', id), want, 'Titel während des Ladens');
    release();
    await waitFor(async () => assert.equal(await b.sw('return (await chrome.tabs.get(args[0])).status;', id), 'complete'));
    assert.equal(await b.sw('return chrome.action.getTitle({ tabId: args[0] });', id), want, 'Titel nach dem Laden');
    await b.sw('await chrome.tabs.remove(args[0]);', id);
    await env.settled({ live: true });
  });

  await step('Ablagen stummschalten: Ein neuer Tab in einer Ablage ist gleich stumm', async () => {
    await b.sw('await userAction(() => chrome.storage.local.set({ muteStash: true }));');
    // Wie target=_blank aus einem Tab der Ablage von B, ohne Aktion oder Abgleich danach
    const id = await b.sw(
      `const [page, url] = args;
       const tabs = await chrome.tabs.query({});
       const windowId = tabs.find((t) => (t.url || t.pendingUrl) === page).windowId;
       const opener = tabs.find((t) => t.windowId === windowId && !t.pinned);
       return (await chrome.tabs.create({ windowId, openerTabId: opener.id, url, active: false })).id;`,
      env.stash + env.ids.B,
      base + 'neu',
    );
    const mutedInfo = () => b.sw('return (await chrome.tabs.get(args[0])).mutedInfo;', id);
    await waitFor(async () => assert.deepEqual(await mutedInfo(), { muted: true, reason: 'extension', extensionId: EXT_ID }));
    await b.sw('await chrome.tabs.remove(args[0]); await userAction(() => chrome.storage.local.set({ muteStash: false }));', id);
    assert.deepEqual(await b.sw("return (await chrome.storage.local.get('stashMuted')).stashMuted;"), []);
    await env.settled({ live: true });
  });

  await step('Ablage-Seite geschlossen: das Fenster wird wieder zur Ablage (#159)', async () => {
    await env.settled({ live: true });
    const win = await b.sw(
      `const t = (await chrome.tabs.query({})).find((x) => (x.url || x.pendingUrl) === args[0]);
       await chrome.tabs.remove(t.id);
       return t.windowId;`,
      env.stash + env.ids.B,
    );
    await waitFor(async () => {
      const tabs = await b.sw('return chrome.tabs.query({ windowId: args[0] });', win);
      assert.equal(tabs[0]?.url, env.stash + env.ids.B, 'Ablage-Seite von B fehlt');
    });
    await env.settled({ live: true });
  });

  await step('Link in Workspace öffnen: Der Link kommt als Tab in die Ablage von C (#157)', async () => {
    const { main, shows } = await env.settled({ live: true });
    // Das Untermenü gibt es für jeden Workspace, nur auf Links
    for (const id of Object.values(env.ids)) await b.sw('await chrome.contextMenus.update(args[0], {});', `link:${id}`);
    await b.action('(u, ws, w) => openLinkInWs(u, ws, w)', base + 'link', env.ids.C, main.id);
    const id = await waitFor(async () => {
      const st = await env.state();
      const stash = st.windows.find((w) => w.tabs[0]?.url === env.stash + env.ids.C);
      assert.deepEqual(stash.tabs.slice(1).map((t) => env.name(t.url)), ['c1', 'c2', 'link']);
      assert.equal(env.name(st.backup[env.ids.C].stash.at(-1).url), 'link', 'Sicherung von C');
      assert.equal(st.windowWs[main.id], env.ids[shows], 'das Hauptfenster hat gewechselt');
      return stash.tabs.at(-1).id;
    });
    assert.equal((await b.sw('return (await chrome.tabs.get(args[0])).active;', id)), false, 'der Link ist in der Ablage vorne');
    await b.sw('await chrome.tabs.remove(args[0]);', id);
    await env.settled({ live: true });
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
    // Der Start hebt den Stand von vorher als früheren Stand auf (#189)
    const urlsOf = "return Object.values(s.backup).flatMap((x) => [...x.shown, ...x.stash].map((e) => e.url)).sort();";
    const before = await b.sw(`const s = await chrome.storage.local.get('backup'); ${urlsOf}`);
    const kept = (await b.sw("return (await chrome.storage.local.get('earlier')).earlier?.length || 0;"));
    await b.quit();
    await env.launch('last');
    const r = await env.settled();
    assert.equal(r.shows, 'B');
    assert.deepEqual(await b.sw(`const s = (await chrome.storage.local.get('earlier')).earlier[0]; ${urlsOf}`), before);
    assert.equal(await b.sw("return (await chrome.storage.local.get('earlier')).earlier.length;"), Math.min(kept + 1, 3));
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

  await step('Sicherung scheitert beim Schließen per X: Ablagen bleiben offen und verlieren den Schlüssel im Titel', async () => {
    const { main } = await env.switchTo('A');
    // Wie bei voller Speichergrenze scheitert die Sicherung
    await b.sw(
      `globalThis.realSet = chrome.storage.local.set;
       chrome.storage.local.set = (o) => ('backup' in o ? Promise.reject(new Error('Speicher voll')) : realSet.call(chrome.storage.local, o));`,
    );
    // Eine Änderung, deren Sicherung beim Schließen nachgeholt wird
    await b.sw(
      `await chrome.tabs.create({ windowId: args[0], url: args[1], active: false });
       await chrome.windows.remove(args[0]);`,
      main.id,
      `${base}x1`,
    );
    const st = await waitFor(async () => {
      const s = await env.state();
      assert.equal(s.windows.length, 3, 'Ablagen wurden geschlossen');
      for (const w of s.windows) {
        const [id] = w.tabs[0].url.split('#').slice(1);
        const name = s.workspaces.find((x) => x.id === id)?.name;
        assert.equal(w.tabs[0].url, `chrome-extension://${EXT_ID}/stash.html?shown#${id}`);
        assert.equal(w.tabs[0].title, `HWS-Ablage · ${name}`, 'Titel der sichtbar gemachten Ablage');
      }
      return s;
    });
    assert.ok(!st.windows.some((w) => w.tabs[0].title.includes(st.token)), 'Schlüssel noch im Titel');
    // Der nächste Abgleich baut ein Hauptfenster aus der Sicherung auf und versteckt die Ablagen
    await b.sw('chrome.storage.local.set = realSet; delete globalThis.realSet;');
    await b.sw('await serial(reconcile);');
    const r = await env.settled({ live: true });
    assert.equal(r.shows, 'A');
  });

  for (const restore of ['last', 'newtab']) {
    await step(`Schließen per X und Neustart (${restore === 'last' ? '„Dort weitermachen“' : '„Neuer Tab“'})`, async () => {
      // C ist der vor A zuletzt gezeigte Workspace, B hat mehr Tabs. c1 bekommt einen
      // zweiten Eintrag im Verlauf.
      await env.switchTo('C');
      if (restore === 'last') {
        await b.inPage(`${base}c1`, 'history.pushState(null, "", location.href)');
        assert.equal(await b.historyOf(`${base}c1`), 2);
      }
      const { main } = await env.switchTo('A');
      // Ein noch ausstehender Abgleich nach den Wechseln sähe nach dem Schließen nur Ablagen
      // und baute ein neues Hauptfenster auf
      await waitFor(() => b.sw("await serial(() => {}); if (firstCall.reconcile) throw new Error('Abgleich steht aus');"));
      // Das letzte Hauptfenster schließen (wie per X): Die Erweiterung schließt die
      // Ablagen mit, damit sich der Browser beendet
      b.sw('await chrome.windows.remove(args[0]);', main.id).catch(() => {});
      await b.waitExit();
      await env.launch(restore);
      const r = await env.settled();
      assert.equal(r.shows, 'A');
      if (restore === 'last') {
        // Chromium stellt nur das zuletzt geschlossene Fenster samt Verlauf wieder her: Das
        // ist die Ablage von C, dem zuletzt vor A gezeigten Workspace (#191)
        const back = r.st.windows.filter((w) => w.tabs[0].url.startsWith(env.stash) && w.tabs.length > 1);
        assert.deepEqual(back.map((w) => r.st.workspaces.find((x) => `${env.stash}${x.id}` === w.tabs[0].url).name), ['C'], env.describe(r.st));
        assert.equal(await b.historyOf(`${base}c1`), 2, 'c1 hat keinen Verlauf mehr');
      }
      await env.cycle(['B', 'C', 'A']);
    });
  }
});

// Der Umstieg aus docs/updating.de.md: Eine Installation ohne Schlüssel im Manifest hat eine ID aus
// dem Pfad. Mit dem Schlüssel bekommt sie beim Neuladen die feste ID und leeren Speicher,
// Chromium schließt die Ablage-Seiten der alten ID. Ersetzen mit dem vorher gemachten
// Export übernimmt dann die alten Fenster samt Tabs (#156).
test('Echter Chromium: Umstieg auf die feste Erweiterungs-ID per Export und Ersetzen', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 300000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-ext-'));
  fs.cpSync(EXT, dir, { recursive: true });
  const manifest = path.join(dir, 'manifest.json');
  const { key, ...old } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.ok(key, 'kein Schlüssel im Manifest');
  fs.writeFileSync(manifest, JSON.stringify(old));
  const env = new Env(bin, base, dir);
  const b = env.browser;
  t.after(async () => {
    await b.kill();
    server.close();
    for (const d of [env.profile, dir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  await env.launch('last');
  assert.notEqual(b.extId, EXT_ID);
  await build(env, await env.state());
  const file = JSON.stringify(await b.action('() => exportAll()'));
  const tabIds = (st) => st.windows.flatMap((w) => w.tabs.filter((x) => !x.url.startsWith('chrome-extension:')).map((x) => `${x.id} ${x.url}`)).sort();
  const before = tabIds(await env.state());
  const loads = new Map(hits);

  // Wie git pull und Neuladen unter chrome://extensions
  fs.copyFileSync(path.join(EXT, 'manifest.json'), manifest);
  b.sw('chrome.runtime.reload();').catch(() => {});
  b.extId = extIdOf(dir);
  assert.equal(b.extId, EXT_ID);
  await b.attachWorker();
  const fresh = await waitFor(async () => {
    const st = await env.state();
    assert.ok(Object.keys(st.windowWs).length, 'noch kein Hauptfenster zugeordnet');
    return st;
  });
  assert.equal(fresh.workspaces.length, 1, 'Speicher der neuen ID ist nicht leer');
  assert.ok(!fresh.windows.some((w) => w.tabs.some((x) => x.url.startsWith('chrome-extension:'))), 'Ablage-Seite der alten ID noch offen');
  assert.deepEqual(fresh.windows.map((w) => w.state).sort(), ['minimized', 'minimized', 'minimized', 'normal']);

  const res = await b.action('(text) => importExchange(text, "replace", true)', file);
  assert.deepEqual([res.kept, res.closed, res.failed], [9, 0, 0]);
  for (const w of (await env.state()).workspaces) env.ids[w.name] = w.id;
  const r = await env.settled({ live: true });
  assert.equal(r.shows, 'A');
  assert.equal(r.st.windows.length, 3, 'die leere alte Ablage ist noch offen');
  assert.deepEqual(tabIds(r.st), before, 'Tabs wurden geschlossen oder neu angelegt');
  await env.cycle();
  assert.deepEqual(new Map(hits), loads, 'eine Seite wurde neu geladen');
  assert.deepEqual(b.errors, [], 'unbehandelte Fehler im Service Worker');
});

// Ersetzen mit dem eigenen Export, nachdem im gezeigten A umsortiert, eine Gruppe umbenannt,
// umgefärbt, eingeklappt und ein Tab aus ihr gelöst wurde: Das Fenster wird übernommen und
// bekommt Reihenfolge und Gruppen der Datei zurück, ohne dass eine Seite neu lädt (#230, #231).
test('Echter Chromium: Ersetzen stellt Reihenfolge und Gruppen eines übernommenen Fensters her', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 180000 }, async (t) => {
  const { server, hits, base } = await startServer();
  const env = new Env(bin, base);
  const b = env.browser;
  t.after(async () => {
    await b.kill();
    server.close();
    fs.rmSync(env.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  await env.launch('last');
  await build(env, await env.state());
  const file = JSON.stringify(await b.action('() => exportAll()'));
  const { main } = await env.settled();
  const ids = () => main.tabs.filter((x) => !x.pinned).map((x) => x.id);
  await b.sw(
    `const [windowId, base] = args;
     const tabs = await chrome.tabs.query({ windowId });
     const at = (n) => tabs.find((x) => x.url === base + n);
     await chrome.tabGroups.update(at('a2').groupId, { title: 'Original', color: 'red', collapsed: true });
     await chrome.tabs.ungroup(at('a3').id);
     await chrome.tabs.move(at('a4').id, { index: 1 });`,
    main.id,
    base,
  );
  const changed = (await env.state()).windows.find((w) => w.id === main.id);
  assert.notDeepEqual(changed.tabs.map((x) => `${x.url} ${x.groupId}`), main.tabs.map((x) => `${x.url} ${x.groupId}`), 'Testfehler: nichts geändert');
  const loads = new Map(hits);

  const res = await b.action('(text) => importExchange(text, "replace", true)', file);
  assert.deepEqual([res.kept, res.failed], [4, 0]);
  for (const w of (await env.state()).workspaces) env.ids[w.name] = w.id;
  const r = await env.settled();
  assert.equal(r.shows, 'A');
  assert.equal(r.main.id, main.id);
  assert.deepEqual(r.main.tabs.filter((x) => !x.pinned).map((x) => x.id), ids(), 'Tabs wurden geschlossen oder neu angelegt');
  assert.deepEqual(new Map(hits), loads, 'eine Seite wurde neu geladen');
  assert.deepEqual(b.errors, [], 'unbehandelte Fehler im Service Worker');
});

// install.sh mit nachgebildeten KDE-Befehlen, kwinrc ist eine Datei je Schlüssel. Chromium
// nutzt das Profil unter $XDG_CONFIG_HOME/chromium wie sein Standardprofil, install.sh meldet
// den Host also genau dort an, wo Chromium ihn sucht. ext: Ordner der Erweiterung.
// extra: weitere Umgebungsvariablen für Browser und install.sh, etwa XDG_DATA_HOME
function hostEnv(t, ext = EXT, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-host-'));
  const ROOT = path.join(__dirname, '..');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  for (const f of ['install.sh', 'native-host.sh']) fs.copyFileSync(path.join(ROOT, f), path.join(repo, f));
  fs.cpSync(path.join(ROOT, 'kwin'), path.join(repo, 'kwin'), { recursive: true });
  const kde = path.join(dir, 'bin');
  const kwinrc = path.join(dir, 'kwinrc');
  const log = path.join(dir, 'log');
  fs.mkdirSync(kde);
  fs.mkdirSync(kwinrc);
  const fake = (name, body) => fs.writeFileSync(path.join(kde, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  fake('kreadconfig6', `cat "${kwinrc}/$6" 2>/dev/null; exit 0`);
  fake('kwriteconfig6', `if [ "$7" = --delete ]; then rm -f "${kwinrc}/$6"; else printf '%s\\n' "$7" > "${kwinrc}/$6"; fi`);
  fake('kpackagetool6', 'exit 0');
  fake('qdbus6', 'echo true');
  const env = { ...process.env, PATH: `${kde}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(dir, 'config'), LANG: 'de_DE.UTF-8', ...extra };
  for (const k of ['LANGUAGE', 'LC_ALL', 'LC_MESSAGES']) delete env[k];
  const b = new Chromium(bin, path.join(dir, 'config', 'chromium'), ext);
  b.env = env;
  t.after(async () => {
    await b.kill();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const tokenFile = path.join(kwinrc, 'token');
  return {
    b,
    // Erstinstallation ohne Schlüssel: Enter an der Frage
    install() {
      const r = spawnSync('bash', [path.join(repo, 'install.sh')], { input: '\n', env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Noch kein Schlüssel eingetragen\. Die Erweiterung trägt ihn selbst ein/);
    },
    key: () => (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''),
    // Wie oft install.sh das KWin-Skript eingerichtet hat
    installs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('kpackagetool6 --type=KWin/Script -u')).length : 0),
    token: () =>
      waitFor(async () => {
        const { token } = await b.sw("return chrome.storage.local.get('token');");
        assert.match(token || '', /^[0-9a-f]{24}$/);
        return token;
      }),
    delivered: async () => (await b.sw("return chrome.storage.session.get('keyDelivered');")).keyDelivered,
  };
}

test('Echter Chromium: install.sh meldet native-host.sh an, das Popup trägt den Schlüssel ein', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 120000 }, async (t) => {
  const h = hostEnv(t);
  const { b } = h;
  await b.launch();
  const token = await h.token();
  // Ohne angemeldeten Host bleibt kwinrc leer, sonst passiert nichts
  assert.equal(h.key(), '');
  h.install();
  assert.equal(h.key(), '');
  assert.equal(h.installs(), 1);

  // Das Popup öffnen genügt, der Host trägt den Schlüssel mit install.sh ein
  await b.sw("await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });");
  await waitFor(() => assert.equal(h.key(), token), { timeout: 30000 });
  assert.equal(h.installs(), 2);
  await waitFor(async () => assert.equal(await h.delivered(), token));

  // Nach dem Neuladen schickt die Erweiterung ihn wieder, der Host lässt kwinrc dann in Ruhe
  b.sw('chrome.runtime.reload();').catch(() => {});
  await b.attachWorker();
  await waitFor(async () => assert.equal(await h.delivered(), token), { timeout: 30000 });
  assert.equal(h.installs(), 2);
  assert.equal(h.key(), token);
  assert.deepEqual(b.errors, [], 'unbehandelte Fehler im Service Worker');
});

// Wie ein Update per install.sh --update: Die installierte Fassung kennt nativeMessaging noch
// nicht, Neuladen unter chrome://extensions bringt die Berechtigung ohne Rückfrage mit
test('Echter Chromium: Nach dem Update auf die Fassung mit nativeMessaging trägt schon das Neuladen den Schlüssel ein', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-ext-'));
  fs.cpSync(EXT, dir, { recursive: true });
  const manifest = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  fs.writeFileSync(manifest, JSON.stringify({ ...m, permissions: m.permissions.filter((p) => p !== 'nativeMessaging') }));
  const h = hostEnv(t, dir);
  // Nach dem Beenden des Browsers (hostEnv), Hooks laufen in der Reihenfolge des Anlegens
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { b } = h;
  await b.launch();
  const token = await h.token();
  h.install();
  // Ohne die Berechtigung kommt nichts an, auch nicht beim Öffnen des Popups
  await b.sw("await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });");
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(h.key(), '');

  fs.copyFileSync(path.join(EXT, 'manifest.json'), manifest);
  b.sw('chrome.runtime.reload();').catch(() => {});
  await b.attachWorker();
  await waitFor(() => assert.equal(h.key(), token), { timeout: 30000 });
  assert.equal(await h.token(), token, 'Schlüssel hat sich beim Neuladen geändert');
  assert.equal(h.installs(), 2);
  assert.deepEqual(b.errors, [], 'unbehandelte Fehler im Service Worker');
});

// Wie in #215: zwei Profile, derselbe Datenordner. Jedes schreibt über native-host.sh in einen
// eigenen Ordner außerhalb von Downloads (#221), und keines überschreibt die Dateien des anderen.
test('Echter Chromium: automatische Sicherung über native-host.sh, je Profil ein eigener Ordner (#215)', { skip: !bin && 'CHROME ist nicht gesetzt', timeout: 180000 }, async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-data-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const backups = path.join(data, 'helium-workspaces', 'backups');
  const backup = 'await chrome.storage.local.set({ autoBackupAt: 0 }); const r = await userAction(() => setAutoBackup(1)); await r?.done; return autoBackupState();';
  const profiles = [];
  for (const names of [['A1', 'A2', 'A3'], ['B1']]) {
    const h = hostEnv(t, EXT, { XDG_DATA_HOME: data });
    await h.b.launch();
    const token = await h.token();
    h.install();
    await h.b.sw(`const { workspaces } = await getConfig();
      await userAction(() => updateWs(workspaces[0].id, { name: args[0][0] }));
      for (const name of args[0].slice(1)) await userAction(() => createWs(name));`, names);
    profiles.push({ ...h, token, names, dir: path.join(backups, token) });
  }
  const slot = (p, n) => path.join(p.dir, `helium-workspaces-auto-${n}.json`);
  const names = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).workspaces.map((w) => w.name).sort();

  // Beide erreichen Platz 1 und 2, B jeweils nach A
  for (let n = 1; n <= 2; n++) {
    for (const p of profiles) {
      const st = await p.b.sw(backup);
      assert.equal(st.error, null, p.names[0]);
      assert.equal(st.last.file, slot(p, n));
      assert.equal(st.dir, p.dir + '/');
    }
  }
  for (const p of profiles) {
    for (let n = 1; n <= 2; n++) assert.deepEqual(names(slot(p, n)), p.names, `Datei ${n} von ${p.names[0]}`);
    // Nur für den Benutzer lesbar, und nichts in Downloads
    assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(slot(p, 1)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(p.b.profile, 'Downloads')), false);
  }

  // A sichert zehn weitere Male: Es bleiben zehn Dateien, die Platz 1 und 2 wurden überschrieben
  const [a, b] = profiles;
  let last;
  for (let i = 0; i < 10; i++) last = (await a.b.sw(backup)).last;
  assert.equal(last.file, slot(a, 2));
  assert.deepEqual(fs.readdirSync(a.dir).sort(), Array.from({ length: 10 }, (_, i) => `helium-workspaces-auto-${i + 1}.json`).sort());
  assert.ok(fs.statSync(slot(a, 1)).mtimeMs > fs.statSync(slot(a, 10)).mtimeMs, 'Datei 1 wurde nicht überschrieben');
  assert.deepEqual(fs.readdirSync(b.dir).sort(), ['helium-workspaces-auto-1.json', 'helium-workspaces-auto-2.json']);
  assert.deepEqual(names(slot(b, 1)), ['B1']);
  for (const p of profiles) assert.deepEqual(p.b.errors, [], 'unbehandelte Fehler im Service Worker');
});
