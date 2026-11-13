'use strict';
// Nachbildung der Chrome-APIs, die background.js nutzt: Fenster, Tabs, Tab-Gruppen,
// storage.local/session und Ereignisse. Die Hintergrundlogik läuft unverändert in einem
// eigenen vm-Kontext mit steuerbarer Uhr. So lassen sich Wechsel, Neustarts, das
// Neuladen der Erweiterung und gezielte API-Fehler ohne echten Browser durchspielen.
//
// Nachgebildetes Chromium-Verhalten, auf das sich die Erweiterung verlässt:
// - Angeheftete Tabs stehen immer vor den anderen.
// - Ein Fenster ohne Tabs wird geschlossen, eine Gruppe ohne Tabs verschwindet.
// - Ein einzeln in ein anderes Fenster verschobener Tab verlässt seine Gruppe,
//   tabGroups.move nimmt die ganze Gruppe samt ID mit.
// - Ein Tab, der zwischen zwei Tabs derselben Gruppe landet, tritt ihr bei.
// - Nach einem Browserstart bekommen alle Fenster, Tabs und Gruppen neue IDs.
// - Stummschalten merkt sich, wer es war (mutedInfo.reason 'user' oder 'extension' mit
//   extensionId). Tabs kommen nach einem Browserstart ohne Stummschaltung wieder.
// - storage.session ist nach einem Browserstart und nach dem Neuladen der Erweiterung
//   leer, beim Neustart nur des Service Workers bleibt es erhalten.
// - Ein neu angelegter Tab meldet kurz darauf status 'complete' (geladen).
// - tabs.discard gibt dem Tab eine neue ID (tabs.onReplaced) und hebt seine
//   Stummschaltung auf, wie Helium 0.21.3 mit Chromium 157. Ein entladener Tab lädt neu,
//   sobald er aktiv wird.
// - Wecker (chrome.alarms) klingeln nur, während ein Test mit advance() Zeit vergehen lässt.
// Ereignisse werden sofort zugestellt, noch bevor der auslösende API-Aufruf zurückkehrt.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const NEWTAB = 'chrome://newtab/';
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

class StorageArea {
  constructor(browser, name) {
    this.browser = browser;
    this.name = name;
    this.data = {};
  }

  get(keys) {
    if (keys === undefined || keys === null) return clone(this.data);
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) {
      for (const k of keys) if (k in this.data) out[k] = clone(this.data[k]);
    } else {
      for (const [k, d] of Object.entries(keys)) out[k] = k in this.data ? clone(this.data[k]) : d;
    }
    return out;
  }

  set(items) {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.data[k], newValue: clone(v) };
      this.data[k] = clone(v);
    }
    this.browser.fire('storage.onChanged', clone(changes), this.name);
  }

  remove(keys) {
    const changes = {};
    for (const k of typeof keys === 'string' ? [keys] : keys) {
      if (!(k in this.data)) continue;
      changes[k] = { oldValue: this.data[k] };
      delete this.data[k];
    }
    if (Object.keys(changes).length) this.browser.fire('storage.onChanged', changes, this.name);
  }

  clear() {
    this.data = {};
  }
}

class Browser {
  constructor({ extId = 'hwstestextensionid' } = {}) {
    this.origin = `chrome-extension://${extId}/`;
    this.now = Date.UTC(2026, 0, 5, 9, 0, 0);
    this.next = { win: 1, tab: 1, group: 1 };
    this.windows = []; // { id, state, focused, tabs: [{ id, url, title, pinned, active, groupId }] }
    this.groups = new Map(); // id → { id, windowId, title, color, collapsed }
    this.local = new StorageArea(this, 'local');
    this.session = new StorageArea(this, 'session');
    this.listeners = new Map(); // gehören zum laufenden Service Worker
    this.faults = [];
    this.calls = [];
    this.errors = []; // Ausnahmen in Ereignis-Listenern
    this.worker = null;
    this.menus = [];
    this.alarms = new Map(); // Name → { name, scheduledTime, periodInMinutes }
    this.chrome = this.buildApi(null); // für Bedienschritte im Test, wie von Hand im Browser
  }

  // ------------------------------------------------------------ Ereignisse

  event(name) {
    return {
      addListener: (fn) => {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(fn);
      },
      removeListener: (fn) => {
        const l = this.listeners.get(name) || [];
        if (l.includes(fn)) l.splice(l.indexOf(fn), 1);
      },
      hasListener: (fn) => (this.listeners.get(name) || []).includes(fn),
    };
  }

  fire(name, ...args) {
    for (const fn of [...(this.listeners.get(name) || [])]) {
      try {
        const r = fn(...args.map((a) => (typeof a === 'function' ? a : clone(a))));
        if (r && typeof r.then === 'function') r.then(undefined, (e) => this.errors.push({ name, error: e }));
      } catch (e) {
        this.errors.push({ name, error: e });
      }
    }
  }

  // ------------------------------------------------------------ Fehler gezielt auslösen

  // Lässt den nächsten passenden Aufruf von name (z. B. 'tabs.move') scheitern.
  // when(...args) wählt Aufrufe aus, after überspringt so viele passende Aufrufe,
  // times begrenzt die Zahl der Fehlschläge, hang lässt den Aufruf nie zurückkehren
  // (wie ein Service Worker, der mitten im Aufruf beendet wird), hold hält die Antwort
  // (mit dem Stand beim Aufruf) zurück, bis der Test f.release() aufruft.
  fail(name, { when = () => true, after = 0, times = 1, hang = false, hold = false, message } = {}) {
    const f = { name, when, skip: after, left: times, hang, hold, message, hits: 0 };
    this.faults.push(f);
    return f;
  }

  // Führt fn(...args) aus, wenn ein passender Aufruf von name beginnt, etwa um mitten in
  // einem Wechsel einen Tab zu öffnen. Optionen wie bei fail().
  during(name, fn, opts = {}) {
    const f = this.fail(name, opts);
    f.run = fn;
    return f;
  }

  matchFault(name, args) {
    for (const f of this.faults) {
      if (f.name !== name || f.left <= 0 || !f.when(...args)) continue;
      if (f.skip > 0) {
        f.skip--;
        continue;
      }
      f.left--;
      f.hits++;
      return f;
    }
    return null;
  }

  api(name, fn, owner) {
    return async (...args) => {
      await null;
      if (owner?.dead) return new Promise(() => {}); // ein beendeter Worker bekommt keine Antworten mehr
      this.calls.push({ name, args: clone(args) });
      const f = this.matchFault(name, args);
      if (f?.run) f.run(...args);
      else if (f) {
        if (f.hang) return new Promise(() => {});
        if (f.hold) {
          const v = clone(fn(...args));
          return new Promise((r) => (f.release = () => r(v)));
        }
        throw new Error(f.message || `${name} gescheitert (Test)`);
      }
      return clone(fn(...args));
    };
  }

  // ------------------------------------------------------------ Fenster und Tabs

  findWin(id) {
    const w = this.windows.find((x) => x.id === id);
    if (!w) throw new Error(`No window with id: ${id}.`);
    return w;
  }

  findTab(id) {
    for (const w of this.windows) {
      const t = w.tabs.find((x) => x.id === id);
      if (t) return { t, w };
    }
    throw new Error(`No tab with id: ${id}.`);
  }

  tabInfo(t, w) {
    return {
      id: t.id,
      windowId: w.id,
      index: w.tabs.indexOf(t),
      url: t.url,
      title: t.title,
      pinned: t.pinned,
      active: t.active,
      highlighted: t.active,
      groupId: t.groupId,
      status: t.discarded ? 'unloaded' : 'complete',
      discarded: !!t.discarded,
      audible: !!t.audible,
      mutedInfo: clone(t.mutedInfo || { muted: false }),
      incognito: false,
    };
  }

  winInfo(w, populate = true) {
    const info = { id: w.id, state: w.state, focused: w.focused, incognito: false, type: w.type };
    if (populate) info.tabs = w.tabs.map((t) => this.tabInfo(t, w));
    return info;
  }

  groupInfo(g) {
    return { id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed };
  }

  pinnedCount(w) {
    return w.tabs.filter((t) => t.pinned).length;
  }

  // Fügt t an index ein (angeheftete vorne). Landet ein Tab zwischen zwei Tabs derselben
  // Gruppe, tritt er ihr bei.
  insert(w, t, index) {
    const pc = this.pinnedCount(w);
    let i = index === undefined || index === null || index < 0 || index > w.tabs.length ? w.tabs.length : index;
    i = t.pinned ? Math.min(i, pc) : Math.max(i, pc);
    w.tabs.splice(i, 0, t);
    if (!t.pinned) {
      const l = w.tabs[i - 1];
      const r = w.tabs[i + 1];
      if (l && r && l.groupId >= 0 && l.groupId === r.groupId) this.setGroup(t, w, l.groupId);
    }
    return i;
  }

  setGroup(t, w, gid) {
    if (t.groupId === gid) return;
    const old = t.groupId;
    t.groupId = gid;
    this.fire('tabs.onUpdated', t.id, { groupId: gid }, this.tabInfo(t, w));
    this.dropEmptyGroup(old);
  }

  dropEmptyGroup(gid) {
    if (gid < 0 || !this.groups.has(gid)) return;
    if (this.windows.some((w) => w.tabs.some((t) => t.groupId === gid))) return;
    const g = this.groups.get(gid);
    this.groups.delete(gid);
    this.fire('tabGroups.onRemoved', this.groupInfo(g));
  }

  // Wird ein Tab einer eingeklappten Gruppe aktiv, klappt Chromium die Gruppe auf.
  activate(t, w) {
    if (t.active) return;
    for (const x of w.tabs) x.active = false;
    t.active = true;
    this.fire('tabs.onActivated', { tabId: t.id, windowId: w.id });
    if (t.discarded) {
      t.discarded = false;
      this.fire('tabs.onUpdated', t.id, { discarded: false }, this.tabInfo(t, w));
      this.loaded(t);
    }
    const g = this.groups.get(t.groupId);
    if (g?.collapsed) {
      g.collapsed = false;
      this.fire('tabGroups.onUpdated', this.groupInfo(g));
    }
  }

  // Nimmt t aus w heraus; war es aktiv, wird der rechte (sonst linke) Nachbar aktiv.
  detach(t, w) {
    const i = w.tabs.indexOf(t);
    w.tabs.splice(i, 1);
    if (t.active && w.tabs.length) {
      t.active = false;
      this.activate(w.tabs[Math.min(i, w.tabs.length - 1)], w);
    }
    t.active = false;
    return i;
  }

  closeIfEmpty(w) {
    if (w.tabs.length || !this.windows.includes(w)) return;
    this.windows.splice(this.windows.indexOf(w), 1);
    if (w.focused) this.focusFallback();
    this.fire('windows.onRemoved', w.id);
  }

  focusFallback() {
    const last = this.windows.filter((w) => w.state !== 'minimized').at(-1);
    if (last) {
      last.focused = true;
      this.fire('windows.onFocusChanged', last.id);
    } else {
      this.fire('windows.onFocusChanged', -1);
    }
  }

  focus(w) {
    if (w.focused) return;
    for (const x of this.windows) x.focused = false;
    w.focused = true;
    if (w.state === 'minimized') w.state = 'normal';
    this.fire('windows.onFocusChanged', w.id);
  }

  // Meldet kurz darauf, dass der Tab fertig geladen hat (nach der Antwort des Aufrufs)
  loaded(t) {
    setImmediate(() => {
      for (const w of this.windows) {
        if (w.tabs.includes(t) && !t.discarded) this.fire('tabs.onUpdated', t.id, { status: 'complete' }, this.tabInfo(t, w));
      }
    });
  }

  // Entlädt den Tab; er bekommt eine neue ID
  discardTab(id) {
    const { t, w } = this.findTab(id);
    if (t.discarded) return this.tabInfo(t, w);
    t.id = this.next.tab++;
    t.discarded = true;
    t.audible = false;
    t.mutedInfo = { muted: false };
    this.fire('tabs.onReplaced', t.id, id);
    this.fire('tabs.onUpdated', t.id, { discarded: true, status: 'unloaded' }, this.tabInfo(t, w));
    return this.tabInfo(t, w);
  }

  newTab(url, pinned = false) {
    return { id: this.next.tab++, url: url || NEWTAB, title: url || 'Neuer Tab', pinned, active: false, groupId: -1 };
  }

  createWindow({ url, focused = true, state = 'normal', type = 'normal' } = {}) {
    const urls = url === undefined ? [NEWTAB] : [].concat(url);
    const w = { id: this.next.win++, type, state, focused: false, tabs: [] };
    this.windows.push(w);
    for (const u of urls) w.tabs.push(this.newTab(u));
    w.tabs[0].active = true;
    this.fire('windows.onCreated', this.winInfo(w, false));
    for (const t of w.tabs) this.fire('tabs.onCreated', this.tabInfo(t, w));
    this.fire('tabs.onActivated', { tabId: w.tabs[0].id, windowId: w.id });
    if (focused && state !== 'minimized') this.focus(w);
    return w;
  }

  createTab({ windowId, url, active = true, pinned = false, index } = {}) {
    const w = windowId === undefined ? this.windows.find((x) => x.focused) || this.windows[0] : this.findWin(windowId);
    const t = this.newTab(url, !!pinned);
    this.insert(w, t, index);
    this.fire('tabs.onCreated', this.tabInfo(t, w));
    if (active || w.tabs.length === 1) this.activate(t, w);
    this.loaded(t);
    return { t, w };
  }

  removeTab(id) {
    const { t, w } = this.findTab(id);
    const closing = w.tabs.length === 1;
    if (closing) this.lastClosed = this.snap(w);
    this.detach(t, w);
    this.fire('tabs.onRemoved', t.id, { windowId: w.id, isWindowClosing: closing });
    this.dropEmptyGroup(t.groupId);
    this.closeIfEmpty(w);
  }

  removeWindow(id) {
    const w = this.findWin(id);
    this.lastClosed = this.snap(w);
    for (const t of [...w.tabs]) this.fire('tabs.onRemoved', t.id, { windowId: w.id, isWindowClosing: true });
    const gids = new Set(w.tabs.map((t) => t.groupId));
    w.tabs = [];
    for (const g of gids) this.dropEmptyGroup(g);
    this.closeIfEmpty(w);
  }

  // Schließen per X wie in Chromium: die Tabs verschwinden einzeln, das Fenster bleibt
  // bis zuletzt abfragbar. between() läuft nach jedem Tab, etwa um die Zeit laufen zu
  // lassen oder andere Ereignisse auszulösen.
  async closeWindowByX(id, between = async () => {}) {
    const w = this.findWin(id);
    this.lastClosed = this.snap(w);
    while (w.tabs.length) {
      const t = w.tabs.pop();
      t.active = false;
      this.fire('tabs.onRemoved', t.id, { windowId: w.id, isWindowClosing: true });
      this.dropEmptyGroup(t.groupId);
      await between();
    }
    this.closeIfEmpty(w);
  }

  // Verschiebt einen einzelnen Tab (verlässt dabei seine Gruppe, außer keepGroup).
  moveTab(t, from, to, index, keepGroup = false) {
    const oldIndex = this.detach(t, from);
    const oldGroup = t.groupId;
    if (!keepGroup) t.groupId = -1;
    const pc = this.pinnedCount(to);
    let i = index === undefined || index < 0 || index > to.tabs.length ? to.tabs.length : index;
    i = t.pinned ? Math.min(i, pc) : Math.max(i, pc);
    to.tabs.splice(i, 0, t);
    if (!keepGroup && !t.pinned) {
      const l = to.tabs[i - 1];
      const r = to.tabs[i + 1];
      if (l && r && l.groupId >= 0 && l.groupId === r.groupId) t.groupId = l.groupId;
    }
    if (from === to) {
      this.fire('tabs.onMoved', t.id, { windowId: to.id, fromIndex: oldIndex, toIndex: i });
    } else {
      this.fire('tabs.onDetached', t.id, { oldWindowId: from.id, oldPosition: oldIndex });
      this.fire('tabs.onAttached', t.id, { newWindowId: to.id, newPosition: i });
    }
    if (t.groupId !== oldGroup) {
      this.fire('tabs.onUpdated', t.id, { groupId: t.groupId }, this.tabInfo(t, to));
      this.dropEmptyGroup(oldGroup);
    }
    return i;
  }

  groupTabs(gid) {
    for (const w of this.windows) {
      const tabs = w.tabs.filter((t) => t.groupId === gid);
      if (tabs.length) return { w, tabs };
    }
    return { w: null, tabs: [] };
  }

  // ------------------------------------------------------------ chrome.*

  // owner: der Worker, dem dieses chrome-Objekt gehört (null für Aktionen im Test)
  buildApi(owner) {
    const b = this;
    const api = (name, fn) => this.api(name, fn, owner);
    return {
      runtime: {
        id: new URL(b.origin).host,
        getURL: (p) => b.origin + String(p).replace(/^\//, ''),
        onMessage: b.event('runtime.onMessage'),
        onInstalled: b.event('runtime.onInstalled'),
        onStartup: b.event('runtime.onStartup'),
      },
      storage: {
        local: {
          get: api('storage.local.get', (k) => b.local.get(k)),
          set: api('storage.local.set', (i) => b.local.set(i)),
          remove: api('storage.local.remove', (k) => b.local.remove(k)),
        },
        session: {
          get: api('storage.session.get', (k) => b.session.get(k)),
          set: api('storage.session.set', (i) => b.session.set(i)),
          remove: api('storage.session.remove', (k) => b.session.remove(k)),
        },
        onChanged: b.event('storage.onChanged'),
      },
      windows: {
        WINDOW_ID_NONE: -1,
        getAll: api('windows.getAll', ({ populate = false, windowTypes } = {}) =>
          b.windowsOf(windowTypes).map((w) => b.winInfo(w, populate)),
        ),
        getLastFocused: api('windows.getLastFocused', ({ populate = false, windowTypes } = {}) => {
          const wins = b.windowsOf(windowTypes);
          const w = wins.find((x) => x.focused) || wins.at(-1);
          if (!w) throw new Error('No last-focused window');
          return b.winInfo(w, populate);
        }),
        create: api('windows.create', (o = {}) => b.winInfo(b.createWindow(o))),
        update: api('windows.update', (id, o = {}) => {
          const w = b.findWin(id);
          if (o.state) w.state = o.state;
          if (o.focused) b.focus(w);
          return b.winInfo(w, false);
        }),
        remove: api('windows.remove', (id) => b.removeWindow(id)),
        onCreated: b.event('windows.onCreated'),
        onRemoved: b.event('windows.onRemoved'),
        onFocusChanged: b.event('windows.onFocusChanged'),
      },
      tabs: {
        get: api('tabs.get', (id) => {
          const { t, w } = b.findTab(id);
          return b.tabInfo(t, w);
        }),
        query: api('tabs.query', (q = {}) => {
          const out = [];
          for (const w of b.windows) {
            if (q.windowId !== undefined && w.id !== q.windowId) continue;
            for (const t of w.tabs) {
              if (q.active !== undefined && t.active !== q.active) continue;
              if (q.pinned !== undefined && t.pinned !== q.pinned) continue;
              out.push(b.tabInfo(t, w));
            }
          }
          return out;
        }),
        create: api('tabs.create', (o = {}) => {
          const { t, w } = b.createTab(o);
          return b.tabInfo(t, w);
        }),
        update: api('tabs.update', (id, o = {}) => {
          const { t, w } = b.findTab(id);
          if (o.url !== undefined && o.url !== t.url) {
            t.url = o.url;
            t.title = o.url;
            b.fire('tabs.onUpdated', t.id, { url: o.url }, b.tabInfo(t, w));
          }
          if (o.pinned !== undefined && !!o.pinned !== t.pinned) {
            const from = w.tabs.indexOf(t);
            w.tabs.splice(from, 1);
            const oldGroup = t.groupId;
            t.pinned = !!o.pinned;
            t.groupId = -1;
            const to = b.pinnedCount(w);
            w.tabs.splice(to, 0, t);
            b.fire('tabs.onUpdated', t.id, { pinned: t.pinned }, b.tabInfo(t, w));
            if (from !== to) b.fire('tabs.onMoved', t.id, { windowId: w.id, fromIndex: from, toIndex: to });
            b.dropEmptyGroup(oldGroup);
          }
          if (o.muted !== undefined) {
            // Ohne owner schaltet der Test wie von Hand im Browser
            t.mutedInfo = owner ? { muted: !!o.muted, reason: 'extension', extensionId: new URL(b.origin).host } : { muted: !!o.muted, reason: 'user' };
            b.fire('tabs.onUpdated', t.id, { mutedInfo: clone(t.mutedInfo) }, b.tabInfo(t, w));
          }
          if (o.active) b.activate(t, w);
          return b.tabInfo(t, w);
        }),
        move: api('tabs.move', (ids, { windowId, index = -1 } = {}) => {
          const list = [].concat(ids);
          const out = [];
          let at = index;
          for (const id of list) {
            const { t, w } = b.findTab(id);
            const to = windowId === undefined ? w : b.findWin(windowId);
            const i = b.moveTab(t, w, to, at);
            if (at >= 0) at = i + 1;
            out.push(b.tabInfo(t, to));
            if (w !== to) b.closeIfEmpty(w);
          }
          return Array.isArray(ids) ? out : out[0];
        }),
        remove: api('tabs.remove', (ids) => {
          for (const id of [].concat(ids)) b.removeTab(id);
        }),
        discard: api('tabs.discard', (id) => b.discardTab(id)),
        group: api('tabs.group', ({ tabIds, groupId, createProperties } = {}) => {
          const list = [].concat(tabIds).map((id) => b.findTab(id));
          if (!list.length) throw new Error('No tabs given.');
          if (list.some(({ t }) => t.pinned)) throw new Error('Cannot group pinned tabs.');
          let g;
          let to;
          if (groupId !== undefined) {
            g = b.groups.get(groupId);
            if (!g) throw new Error(`No group with id: ${groupId}.`);
            to = b.findWin(g.windowId);
          } else {
            to = createProperties?.windowId !== undefined ? b.findWin(createProperties.windowId) : list[0].w;
            g = { id: b.next.group++, windowId: to.id, title: '', color: GROUP_COLORS[b.groups.size % GROUP_COLORS.length], collapsed: false };
            b.groups.set(g.id, g);
            b.fire('tabGroups.onCreated', b.groupInfo(g));
          }
          // Mitglieder hinter den letzten Tab der Gruppe, sonst an die Stelle des ersten Tabs
          const members = to.tabs.filter((t) => t.groupId === g.id);
          let at = members.length ? to.tabs.indexOf(members.at(-1)) + 1 : list[0].w === to ? to.tabs.indexOf(list[0].t) : -1;
          for (const { t, w } of list) {
            if (t.groupId === g.id) continue;
            if (w === to && at >= 0 && to.tabs.indexOf(t) < at) at--;
            const i = b.moveTab(t, w, to, at, true);
            at = i + 1;
            b.setGroup(t, to, g.id);
            if (w !== to) b.closeIfEmpty(w);
          }
          return g.id;
        }),
        onCreated: b.event('tabs.onCreated'),
        onRemoved: b.event('tabs.onRemoved'),
        onUpdated: b.event('tabs.onUpdated'),
        onActivated: b.event('tabs.onActivated'),
        onMoved: b.event('tabs.onMoved'),
        onAttached: b.event('tabs.onAttached'),
        onDetached: b.event('tabs.onDetached'),
        onReplaced: b.event('tabs.onReplaced'),
      },
      tabGroups: {
        get: api('tabGroups.get', (id) => {
          const g = b.groups.get(id);
          if (!g) throw new Error(`No group with id: ${id}.`);
          return b.groupInfo(g);
        }),
        query: api('tabGroups.query', (q = {}) =>
          [...b.groups.values()].filter((g) => q.windowId === undefined || g.windowId === q.windowId).map((g) => b.groupInfo(g)),
        ),
        update: api('tabGroups.update', (id, o = {}) => {
          const g = b.groups.get(id);
          if (!g) throw new Error(`No group with id: ${id}.`);
          for (const k of ['title', 'color', 'collapsed']) if (o[k] !== undefined) g[k] = o[k];
          // Eingeklappt bleibt kein Tab der Gruppe aktiv: der nächste Tab außerhalb übernimmt
          const { w, tabs } = b.groupTabs(id);
          const act = tabs.find((t) => t.active);
          if (g.collapsed && act) {
            const i = w.tabs.indexOf(act);
            const out = [...w.tabs.slice(i + 1), ...w.tabs.slice(0, i).reverse()].find((t) => t.groupId !== id);
            if (out) {
              for (const x of w.tabs) x.active = false;
              out.active = true;
              b.fire('tabs.onActivated', { tabId: out.id, windowId: w.id });
            }
          }
          b.fire('tabGroups.onUpdated', b.groupInfo(g));
          return b.groupInfo(g);
        }),
        move: api('tabGroups.move', (id, { windowId, index = -1 } = {}) => {
          const g = b.groups.get(id);
          if (!g) throw new Error(`No group with id: ${id}.`);
          const { w: from, tabs } = b.groupTabs(id);
          const to = windowId === undefined ? from : b.findWin(windowId);
          let at = index;
          for (const t of tabs) {
            const i = b.moveTab(t, from, to, at, true);
            at = i + 1;
          }
          g.windowId = to.id;
          b.fire('tabGroups.onMoved', b.groupInfo(g));
          if (from !== to) b.closeIfEmpty(from);
          return b.groupInfo(g);
        }),
        onCreated: b.event('tabGroups.onCreated'),
        onUpdated: b.event('tabGroups.onUpdated'),
        onMoved: b.event('tabGroups.onMoved'),
        onRemoved: b.event('tabGroups.onRemoved'),
      },
      action: {
        setIcon: api('action.setIcon', () => {}),
        setTitle: api('action.setTitle', () => {}),
        setBadgeText: api('action.setBadgeText', () => {}),
        setBadgeBackgroundColor: api('action.setBadgeBackgroundColor', () => {}),
      },
      contextMenus: {
        create: (o) => {
          b.menus.push(clone(o));
          return o.id;
        },
        removeAll: api('contextMenus.removeAll', () => {
          b.menus = [];
        }),
        onClicked: b.event('contextMenus.onClicked'),
      },
      commands: { onCommand: b.event('commands.onCommand') },
      alarms: {
        create: api('alarms.create', (name, { periodInMinutes, delayInMinutes = periodInMinutes } = {}) => {
          b.alarms.set(name, { name, scheduledTime: b.now + delayInMinutes * 60000, periodInMinutes });
        }),
        get: api('alarms.get', (name) => b.alarms.get(name)),
        clear: api('alarms.clear', (name) => b.alarms.delete(name)),
        onAlarm: b.event('alarms.onAlarm'),
      },
    };
  }

  // ------------------------------------------------------------ Lebenszyklus

  // Startet den Service Worker (neu). event: 'installed', 'startup' oder null
  // (der Worker wurde nur wegen Untätigkeit beendet und wieder geweckt).
  startWorker(event = null) {
    this.worker?.kill();
    this.listeners = new Map();
    this.worker = new Worker(this);
    if (event === 'installed') this.fire('runtime.onInstalled', { reason: 'update' });
    if (event === 'startup') this.fire('runtime.onStartup');
    return this.worker;
  }

  // Browser beenden und neu starten. restore: 'now' stellt die letzte Sitzung vor dem
  // Start des Service Workers wieder her, 'later' erst durch finishRestore() danach,
  // 'none' öffnet nur ein Fenster mit neuer Tab-Seite (keepPinned: davor die angehefteten
  // Tabs aller Fenster), 'crash' ebenso, bietet aber restoreAfterCrash() an.
  // loseTab/loseWindow simulieren, was Chromium beim Wiederherstellen verliert.
  restart({ restore = 'now', loseTab = () => false, loseWindow = () => false, keepPinned = false } = {}) {
    this.worker?.kill();
    this.listeners = new Map();
    // Ohne offenes Fenster (zuletzt eins per X geschlossen) stellt Chromium das zuletzt
    // geschlossene Fenster wieder her.
    const saved = this.windows.length ? this.windows.map((w) => this.snap(w)) : this.lastClosed ? [this.lastClosed] : [];
    this.windows = [];
    this.groups = new Map();
    this.session.clear();
    this.alarms.clear();
    this.lastClosed = null;
    this.pendingRestore = null;
    this.crashed = restore === 'crash' ? saved : null;
    if (restore === 'none' || restore === 'crash') {
      // Wie Chromium: die angehefteten Tabs aller Fenster in einem einzigen Fenster, also
      // auch die Ablage-Markierungen
      const pinned = keepPinned ? saved.flatMap((w) => w.tabs.filter((t) => t.pinned)) : [];
      const w = { id: this.next.win++, type: 'normal', state: 'normal', focused: true, tabs: [] };
      for (const t of pinned) w.tabs.push(this.newTab(t.url, true));
      w.tabs.push(this.newTab(NEWTAB));
      w.tabs.at(-1).active = true;
      this.windows.push(w);
      return;
    }
    const kept = saved
      .filter((w) => !loseWindow(w))
      .map((w) => ({ ...w, tabs: w.tabs.filter((t) => !loseTab(t)) }))
      .filter((w) => w.tabs.length);
    if (restore === 'later') this.pendingRestore = kept;
    else this.restoreWindows(kept, false);
  }

  snap(w) {
    return {
      state: w.state,
      focused: w.focused,
      tabs: w.tabs.map((t) => ({
        url: t.url,
        pinned: t.pinned,
        active: t.active,
        group: t.groupId >= 0 ? { key: t.groupId, ...this.groupInfo(this.groups.get(t.groupId)) } : null,
      })),
    };
  }

  // Strg+Shift+T: das zuletzt geschlossene Fenster wieder öffnen
  reopenClosed() {
    const w = this.lastClosed;
    this.lastClosed = null;
    this.restoreWindows([{ ...w, focused: true }], true);
    return this.windows.at(-1).id;
  }

  finishRestore() {
    const kept = this.pendingRestore || [];
    this.pendingRestore = null;
    this.restoreWindows(kept, true);
  }

  // Klick auf „Wiederherstellen“ nach einem Absturz: Wie Chromium hängt es die Tabs des
  // ersten Fensters an das fokussierte Fenster an und öffnet die übrigen neu.
  restoreAfterCrash() {
    const [first, ...rest] = this.crashed;
    this.crashed = null;
    const into = this.windows.find((w) => w.focused) || this.windows[0];
    this.restoreWindows([first], true, into);
    this.restoreWindows(rest, true);
  }

  restoreWindows(list, events, into = null) {
    const groupIds = new Map();
    for (const s of list) {
      if (into) {
        for (const st of s.tabs) {
          const t = this.newTab(st.url, st.pinned);
          if (st.group) {
            if (!groupIds.has(st.group.key)) {
              const g = { id: this.next.group++, windowId: into.id, title: st.group.title, color: st.group.color, collapsed: st.group.collapsed };
              this.groups.set(g.id, g);
              groupIds.set(st.group.key, g.id);
            }
            t.groupId = groupIds.get(st.group.key);
          }
          this.insert(into, t);
          this.fire('tabs.onCreated', this.tabInfo(t, into));
          if (st.active) this.activate(t, into);
        }
        continue;
      }
      const w = { id: this.next.win++, type: 'normal', state: s.state, focused: false, tabs: [] };
      for (const st of s.tabs) {
        const t = this.newTab(st.url, st.pinned);
        if (st.group) {
          if (!groupIds.has(st.group.key)) {
            const g = { id: this.next.group++, windowId: w.id, title: st.group.title, color: st.group.color, collapsed: st.group.collapsed };
            this.groups.set(g.id, g);
            groupIds.set(st.group.key, g.id);
          }
          t.groupId = groupIds.get(st.group.key);
        }
        t.active = st.active;
        w.tabs.push(t);
      }
      if (!w.tabs.some((t) => t.active)) w.tabs[0].active = true;
      this.windows.push(w);
      if (events) {
        this.fire('windows.onCreated', this.winInfo(w, false));
        for (const t of w.tabs) this.fire('tabs.onCreated', this.tabInfo(t, w));
      }
      if (s.focused) {
        for (const x of this.windows) x.focused = false;
        w.focused = true;
      }
    }
  }

  // Erweiterung unter chrome://extensions neu laden: Chromium schließt dabei ihre Seiten
  // (also die Ablage-Markierungen), storage.session wird geleert.
  reloadExtension() {
    this.worker?.kill();
    this.listeners = new Map();
    // Chromium schließt die Seiten der Erweiterung. Ist eine davon der letzte Tab ihres
    // Fensters, lädt es dort stattdessen die neue Tab-Seite; der Tab bleibt angeheftet.
    for (const w of [...this.windows]) {
      for (const t of [...w.tabs]) {
        if (!t.url.startsWith(this.origin)) continue;
        if (w.tabs.length > 1) this.removeTab(t.id);
        else Object.assign(t, { url: NEWTAB, title: 'Neuer Tab' });
      }
    }
    this.session.clear();
    return this.startWorker('installed');
  }

  // ------------------------------------------------------------ Hilfen für Tests

  // Ablage-Workspace eines Fensters (ID hinter stash.html#) oder null
  stashOf(w) {
    const t = w.tabs.find((x) => x.url.startsWith(this.origin + 'stash.html'));
    return t ? t.url.split('#')[1] : null;
  }

  mains() {
    return this.windows.filter((w) => w.type === 'normal' && !this.stashOf(w));
  }

  // Fenster der angegebenen Typen wie bei windowTypes in chrome.windows, sonst alle
  windowsOf(types) {
    return types ? this.windows.filter((w) => types.includes(w.type)) : this.windows;
  }

  tabsByUrl(url) {
    return this.windows.flatMap((w) => w.tabs.filter((t) => t.url === url).map((t) => ({ ...t, windowId: w.id })));
  }
}

// Minimaler Ersatz für OffscreenCanvas (nur für die Symbole der Erweiterung)
class FakeCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }

  getContext() {
    const noop = () => {};
    return {
      beginPath: noop,
      roundRect: noop,
      fill: noop,
      fillText: noop,
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    };
  }
}

// Reproduzierbare Zufallszahlen, damit Workspace-IDs in jedem Lauf gleich sind
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let workerSeed = 1;

// Ein laufender Service Worker: background.js in einem eigenen Kontext mit eigener Uhr.
class Worker {
  constructor(browser) {
    this.browser = browser;
    this.timers = new Map();
    this.timerSeq = 1;
    this.logs = [];
    this.dead = false;
    const log = (level) => (...a) => this.logs.push({ level, text: a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });
    const sandbox = {
      console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      setTimeout: (fn, ms = 0) => {
        const id = this.timerSeq++;
        this.timers.set(id, { fn, at: browser.now + Math.max(0, Number(ms) || 0), seq: id });
        return id;
      },
      clearTimeout: (id) => this.timers.delete(id),
      OffscreenCanvas: FakeCanvas,
      URL,
      __now: () => browser.now,
      __random: seeded(workerSeed++),
    };
    const bytes = seeded(workerSeed++);
    sandbox.crypto = { getRandomValues: (a) => a.fill(0).map(() => Math.floor(bytes() * 256)) };
    sandbox.chrome = browser.buildApi(this);
    sandbox.self = sandbox;
    sandbox.importScripts = (...files) => {
      for (const f of files) this.run(path.join(EXT_DIR, f));
    };
    this.ctx = vm.createContext(sandbox);
    vm.runInContext('Date.now = () => __now(); Math.random = __random;', this.ctx);
    this.run(path.join(EXT_DIR, 'background.js'));
  }

  run(file) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), this.ctx, { filename: file });
  }

  kill() {
    this.dead = true;
    this.timers.clear();
  }

  // Wert eines Ausdrucks im Kontext der Hintergrundlogik (z. B. 'switching')
  eval(expr) {
    return vm.runInContext(expr, this.ctx);
  }

  // Lässt alle Promises und fälligen Zeitgeber laufen, bis nichts mehr ansteht. Die Uhr
  // springt dabei jeweils zum nächsten Zeitgeber, höchstens bis until (ms ab jetzt).
  // Mit until klingeln auch fällige Wecker.
  async settle({ until = Infinity } = {}) {
    const end = until === Infinity ? Infinity : this.browser.now + until;
    for (let step = 0; step < 100000; step++) {
      await new Promise((r) => setImmediate(r));
      if (this.dead) return;
      let next = null;
      for (const [id, t] of this.timers) if (!next || t.at < next.t.at || (t.at === next.t.at && t.seq < next.t.seq)) next = { id, t };
      const alarm = end === Infinity ? null : [...this.browser.alarms.values()].sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
      if (alarm && alarm.scheduledTime <= end && (!next || alarm.scheduledTime < next.t.at)) {
        this.browser.now = Math.max(this.browser.now, alarm.scheduledTime);
        if (alarm.periodInMinutes) alarm.scheduledTime += alarm.periodInMinutes * 60000;
        else this.browser.alarms.delete(alarm.name);
        this.browser.fire('alarms.onAlarm', { name: alarm.name, scheduledTime: this.browser.now });
        continue;
      }
      if (!next || next.t.at > end) {
        if (end !== Infinity) this.browser.now = Math.max(this.browser.now, end);
        return;
      }
      this.timers.delete(next.id);
      this.browser.now = Math.max(this.browser.now, next.t.at);
      next.t.fn();
    }
    throw new Error('settle: kein Ruhezustand erreicht');
  }

  // Lässt die Zeit um ms weiterlaufen und dabei fällige Zeitgeber laufen.
  advance(ms) {
    return this.settle({ until: ms });
  }

  // Schickt eine Nachricht wie das Popup und gibt die Antwort zurück ({ ok, result | error }).
  // Mit tabId kommt sie stattdessen von der Erweiterungsseite in diesem Tab.
  send(msg, tabId) {
    const sender = { id: this.ctx.chrome.runtime.id };
    if (tabId !== undefined) {
      const { t, w } = this.browser.findTab(tabId);
      sender.tab = this.browser.tabInfo(t, w);
    }
    return new Promise((resolve) => this.browser.fire('runtime.onMessage', msg, sender, resolve));
  }

  // send() und danach alles abarbeiten. Kommt keine Antwort, ist das Ergebnis null.
  async request(msg, tabId) {
    let reply = null;
    this.send(msg, tabId).then((r) => (reply = r));
    await this.settle();
    return reply;
  }

  warnings() {
    return this.logs.filter((l) => l.level === 'warn' || l.level === 'error');
  }
}

module.exports = { Browser, NEWTAB };
