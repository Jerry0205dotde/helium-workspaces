// Workspaces für Helium – Hintergrundlogik.
//
// Prinzip: Jedes normale Fenster ("Hauptfenster") zeigt genau einen Workspace.
// Die Tabs der gerade nicht gezeigten Workspaces liegen in je einem eigenen
// "Ablage-Fenster" (erster Tab = stash.html#<id>). Beim Wechseln werden Tabs
// per tabs.move/tabGroups.move zwischen Fenstern verschoben – dabei bleiben sie
// geladen (kein Neuladen, Videos laufen weiter). Ein KWin-Skript versteckt die
// Ablage-Fenster anhand ihres Titels ("HWS-Ablage").
//
// Angeheftete Tabs bleiben im Hauptfenster und gelten für alle Workspaces.

const STASH_PAGE = chrome.runtime.getURL('stash.html');
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];

let switching = 0; // > 0, solange wir selbst Tabs verschieben

// ---------------------------------------------------------------- Speicher

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

async function getConfig() {
  let { workspaces, lastWs } = await chrome.storage.local.get(['workspaces', 'lastWs']);
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    workspaces = [{ id: newId(), name: 'Standard', color: COLORS[0], emoji: '' }];
    await chrome.storage.local.set({ workspaces });
  }
  if (!workspaces.some((w) => w.id === lastWs)) lastWs = workspaces[0].id;
  return { workspaces, lastWs };
}

async function saveWorkspaces(workspaces) {
  await chrome.storage.local.set({ workspaces });
  await buildMenus();
}

// Laufzeitzustand (überlebt Neustarts des Service Workers, nicht des Browsers)
async function sess() {
  const s = await chrome.storage.session.get(['windowWs', 'lastTab', 'tabOrigin']);
  return { windowWs: s.windowWs || {}, lastTab: s.lastTab || {}, tabOrigin: s.tabOrigin || {} };
}

async function saveSess(s) {
  await chrome.storage.session.set(s);
}

async function getBackup() {
  const { backup, backupPinned } = await chrome.storage.local.get(['backup', 'backupPinned']);
  return { backup: backup || {}, backupPinned: backupPinned || [] };
}

// ---------------------------------------------------------------- Ablauf

// Alle Änderungen laufen nacheinander, damit sich nichts überschneidet.
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error('[workspaces]', e));
  return p;
}

// Zusammenfassen von Ereignissen, aber spätestens nach maxMs ausführen.
const timers = {};
const firstCall = {};
function debounce(name, ms, fn, maxMs = Infinity) {
  firstCall[name] ??= Date.now();
  clearTimeout(timers[name]);
  const wait = Math.max(0, Math.min(ms, firstCall[name] + maxMs - Date.now()));
  timers[name] = setTimeout(() => {
    delete firstCall[name];
    serial(fn);
  }, wait);
}

const scheduleReconcile = () => debounce('reconcile', 800, reconcile);
const scheduleSnapshot = () => debounce('snapshot', 300, snapshot, 2000);

// ---------------------------------------------------------------- Fenster erkennen

function isStashTab(t) {
  const u = t.url || t.pendingUrl || '';
  return u.startsWith(STASH_PAGE);
}

function stashWsOf(win) {
  for (const t of win.tabs || []) {
    if (isStashTab(t)) return (t.url || t.pendingUrl).split('#')[1] || null;
  }
  return null;
}

async function scan() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const stash = new Map();
  const mains = [];
  const dups = [];
  for (const w of wins) {
    if (w.incognito) continue;
    const ws = stashWsOf(w);
    if (ws) {
      if (stash.has(ws)) dups.push(w);
      else stash.set(ws, w);
    } else {
      mains.push(w);
    }
  }
  return { stash, mains, dups };
}

const stashTabsOf = (win) => win.tabs.filter((t) => !isStashTab(t));
const movableTabsOf = (win) => win.tabs.filter((t) => !t.pinned);

// ---------------------------------------------------------------- Tabs bewegen

// Verschiebt Tabs in ihrer Reihenfolge ans Ende von windowId. Gruppen werden als
// Ganzes verschoben, damit Titel/Farbe erhalten bleiben. Gibt die Tab-IDs zurück.
async function moveOrdered(tabs, windowId) {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const ids = [];
  const doneGroups = new Set();
  let seg = [];
  const flush = async () => {
    if (seg.length) {
      await chrome.tabs.move(seg, { windowId, index: -1 });
      seg = [];
    }
  };
  for (const t of sorted) {
    ids.push(t.id);
    if (typeof t.groupId === 'number' && t.groupId >= 0) {
      if (doneGroups.has(t.groupId)) continue;
      await flush();
      doneGroups.add(t.groupId);
      await chrome.tabGroups.move(t.groupId, { windowId, index: -1 });
    } else {
      seg.push(t.id);
    }
  }
  await flush();
  return ids;
}

// Legt gesicherte Tabs neu an (nur nötig, wenn ihr Fenster nicht mehr existiert).
async function recreate(list, windowId, pinned = false) {
  const ids = [];
  const groups = new Map();
  for (const e of list) {
    if (!e.url) continue;
    try {
      const t = await chrome.tabs.create({ windowId, url: e.url, active: false, pinned });
      ids.push(t.id);
      if (e.g && !pinned) {
        if (!groups.has(e.g)) groups.set(e.g, { ids: [], title: e.gt, color: e.gc, collapsed: e.gx });
        groups.get(e.g).ids.push(t.id);
      }
    } catch (err) {
      console.warn('[workspaces] Tab nicht wiederherstellbar:', e.url, err);
    }
  }
  for (const g of groups.values()) {
    try {
      const gid = await chrome.tabs.group({ tabIds: g.ids, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed });
    } catch (err) {
      console.warn('[workspaces] Gruppe nicht wiederherstellbar', err);
    }
  }
  return ids;
}

async function ensureStash(wsId, restoreBackup) {
  const { stash } = await scan();
  const w = stash.get(wsId);
  if (w) return { windowId: w.id, tabId: w.tabs.find(isStashTab).id };
  const win = await chrome.windows.create({ url: `${STASH_PAGE}#${wsId}`, focused: false, state: 'minimized' });
  const tabId = win.tabs[0].id;
  await chrome.tabs.update(tabId, { pinned: true });
  if (restoreBackup) {
    const { backup } = await getBackup();
    const b = backup[wsId];
    if (b) await recreate([...(b.shown || []), ...(b.stash || [])], win.id);
    await chrome.tabs.update(tabId, { active: true });
  }
  return { windowId: win.id, tabId, created: true };
}

// ---------------------------------------------------------------- Wechseln

// Ein begonnener Wechsel steht in storage.session ('pendingSwitch': Fenster, alter und
// neuer Workspace, IDs der alten Tabs). Solange er dort steht, ist der Tab-Bestand im
// Übergang: snapshot() sichert dann nichts, und finishSwitch() schließt ihn ab – nach
// einem Fehler, beim nächsten Wechsel oder nach einem Neustart des Service Workers.
async function getPending() {
  return (await chrome.storage.session.get('pendingSwitch')).pendingSwitch || null;
}

async function setPending(p) {
  if (p) await chrome.storage.session.set({ pendingSwitch: p });
  else await chrome.storage.session.remove('pendingSwitch');
}

// Setzt einen unterbrochenen Wechsel fort, bevor etwas anderes die Zuordnung liest.
async function resumeSwitch() {
  const p = await getPending();
  if (!p) return false;
  console.info('[workspaces] setze unterbrochenen Wechsel fort:', p.from, '→', p.to);
  console.info('[workspaces] Ergebnis:', await finishSwitch());
  return true;
}

async function switchTo(windowId, targetWs) {
  await resumeSwitch();
  const cfg = await getConfig();
  if (!cfg.workspaces.some((w) => w.id === targetWs)) return;
  const s = await sess();
  const { stash, mains } = await scan();
  const main = mains.find((w) => w.id === windowId);
  if (!main) return;
  const cur = s.windowWs[windowId] || cfg.lastWs;
  if (cur === targetWs) return;

  // Mehrere Fenster dürfen denselben Workspace zeigen (z. B. nach Strg+N).
  // Die Ablage eines Workspace landet immer im Fenster, das zu ihm wechselt.
  const oldTabs = movableTabsOf(main);
  const active = main.tabs.find((t) => t.active);
  if (active && !active.pinned) s.lastTab[cur] = active.id;
  await saveSess(s);
  const p = { windowId, from: cur, to: targetWs, oldTabs: oldTabs.map((t) => t.id) };
  await setPending(p);

  // 1. Tabs des Ziel-Workspace holen (zuerst, damit das Fenster nie leer wird)
  let failed = null;
  switching++;
  try {
    let brought = [];
    const tStash = stash.get(targetWs);
    if (tStash) {
      brought = await moveOrdered(stashTabsOf(tStash), windowId);
    } else if (!mains.some((w) => w.id !== windowId && s.windowWs[w.id] === targetWs)) {
      // Nur wiederherstellen, wenn die Tabs nicht schon lebend in einem anderen Fenster sind
      const { backup } = await getBackup();
      const b = backup[targetWs];
      if (b) {
        await setPending({ ...p, restoring: true });
        brought = await recreate([...(b.shown || []), ...(b.stash || [])], windowId);
        await setPending(p);
      }
    }
    if (!brought.length) {
      const t = await chrome.tabs.create({ windowId, active: true });
      brought = [t.id];
    }
    const want = s.lastTab[targetWs];
    await chrome.tabs.update(brought.includes(want) ? want : brought[0], { active: true });
  } catch (err) {
    console.warn('[workspaces] Wechsel unterbrochen, schließe ihn anhand der Fenster ab:', err);
    failed = err;
  } finally {
    switching--;
  }

  // 2. Alte Tabs in die Ablage des alten Workspace (nach einem Fehler nur, was davon übrig ist)
  let done;
  try {
    done = await finishSwitch();
  } catch (err) {
    scheduleReconcile(); // erneut versuchen, bis dahin keine Snapshots
    throw err;
  } finally {
    await updateIcons(windowId);
  }
  await snapshot();
  if (failed && done !== 'forward') throw failed;
}

// Schließt einen begonnenen Wechsel anhand der tatsächlich vorhandenen Tabs ab. Sind schon
// Tabs des Ziels im Fenster, wird er zu Ende geführt: restliche Ziel-Tabs holen, übrige alte
// Tabs in die Ablage. Sonst gilt er als nicht begonnen. Wirft bei einem Fehler; der Wechsel
// bleibt dann vermerkt und wird beim nächsten Versuch fortgesetzt.
async function finishSwitch() {
  const p = await getPending();
  if (!p) return null;
  switching++;
  try {
    const s = await sess();
    const { stash, mains } = await scan();
    const main = mains.find((w) => w.id === p.windowId);
    const old = new Set(p.oldTabs);
    const tabs = main ? movableTabsOf(main) : [];
    const arrived = tabs.filter((t) => !old.has(t.id));
    if (!main || !arrived.length) {
      await setPending(null);
      return main ? 'back' : 'gone';
    }

    const tStash = stash.get(p.to);
    if (tStash) {
      await moveOrdered(stashTabsOf(tStash), p.windowId);
    } else if (p.restoring) {
      // Service Worker endete beim Neuanlegen aus der Sicherung: den Rest ergänzen
      const b = (await getBackup()).backup[p.to];
      const list = [...(b?.shown || []), ...(b?.stash || [])].filter((e) => e.url);
      await recreate(list.slice(arrived.length), p.windowId);
    }

    const oldLeft = tabs.filter((t) => old.has(t.id));
    if (oldLeft.length) {
      const st = await ensureStash(p.from, false);
      await moveOrdered(oldLeft, st.windowId);
      await chrome.tabs.update(st.tabId, { active: true });
      if (st.created) await chrome.windows.update(p.windowId, { focused: true }).catch(() => {});
    } else if (!p.oldTabs.length) {
      await clearBackup(p.from);
    }

    s.windowWs[p.windowId] = p.to;
    await saveSess(s);
    await chrome.storage.local.set({ lastWs: p.to });
    await setPending(null);
    return 'forward';
  } finally {
    switching--;
  }
}

async function switchRelative(windowId, step) {
  const cfg = await getConfig();
  const s = await sess();
  const cur = s.windowWs[windowId] || cfg.lastWs;
  const i = cfg.workspaces.findIndex((w) => w.id === cur);
  const n = cfg.workspaces.length;
  if (n < 2) return;
  await switchTo(windowId, cfg.workspaces[(i + step + n) % n].id);
}

// ---------------------------------------------------------------- Tab verschieben

async function moveTabToWs(tabId, wsId) {
  await resumeSwitch();
  const tab = await chrome.tabs.get(tabId);
  const s = await sess();
  if (s.windowWs[tab.windowId] === wsId) return;
  const { mains } = await scan();
  const main = mains.find((w) => w.id === tab.windowId);
  if (!main) return;

  switching++;
  try {
    // Fenster darf nicht leer werden
    if (main.tabs.length === 1 || (!tab.pinned && movableTabsOf(main).length <= 1)) {
      await chrome.tabs.create({ windowId: tab.windowId, active: true });
    }
    if (tab.pinned) await chrome.tabs.update(tabId, { pinned: false });

    const shownIn = mains.find((w) => s.windowWs[w.id] === wsId);
    if (shownIn) {
      await chrome.tabs.move(tabId, { windowId: shownIn.id, index: -1 });
    } else {
      const st = await ensureStash(wsId, true);
      await chrome.tabs.move(tabId, { windowId: st.windowId, index: -1 });
      await chrome.tabs.update(st.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  } finally {
    switching--;
  }
  const s2 = await sess();
  delete s2.tabOrigin[tabId];
  await saveSess(s2);
  await setTabIcon(tabId, wsId);
  await snapshot();
}

// ---------------------------------------------------------------- Workspaces verwalten

async function createWs(name) {
  const cfg = await getConfig();
  const used = new Set(cfg.workspaces.map((w) => w.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[cfg.workspaces.length % COLORS.length];
  const ws = { id: newId(), name: name || `Workspace ${cfg.workspaces.length + 1}`, color, emoji: '' };
  cfg.workspaces.push(ws);
  await saveWorkspaces(cfg.workspaces);
  return ws;
}

async function updateWs(id, patch) {
  const cfg = await getConfig();
  const ws = cfg.workspaces.find((w) => w.id === id);
  if (!ws) return;
  for (const k of ['name', 'color', 'emoji']) if (typeof patch[k] === 'string') ws[k] = patch[k];
  ws.name = ws.name.trim() || 'Workspace';
  await saveWorkspaces(cfg.workspaces);
  iconCache.clear();
  await updateAllIcons();
}

async function reorderWs(ids) {
  const cfg = await getConfig();
  const byId = new Map(cfg.workspaces.map((w) => [w.id, w]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  for (const w of cfg.workspaces) if (!next.includes(w)) next.push(w);
  await saveWorkspaces(next);
}

async function deleteWs(id) {
  await resumeSwitch();
  const cfg = await getConfig();
  if (cfg.workspaces.length < 2) return;
  const idx = cfg.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const fallback = cfg.workspaces[idx === 0 ? 1 : idx - 1].id;

  // Fenster, die diesen Workspace zeigen, vorher wegwechseln
  const s = await sess();
  for (const [winId, ws] of Object.entries(s.windowWs)) {
    if (ws === id) await switchTo(Number(winId), fallback);
  }
  const { stash } = await scan();
  const w = stash.get(id);
  if (w) await chrome.windows.remove(w.id).catch(() => {});

  cfg.workspaces.splice(idx, 1);
  await saveWorkspaces(cfg.workspaces);
  const { backup } = await getBackup();
  delete backup[id];
  await chrome.storage.local.set({ backup });
  if (cfg.lastWs === id) await chrome.storage.local.set({ lastWs: fallback });
}

async function clearBackup(wsId) {
  const { backup } = await getBackup();
  backup[wsId] = { stash: [], shown: [] };
  await chrome.storage.local.set({ backup });
}

// ---------------------------------------------------------------- Sicherung

function serTab(t, groups) {
  const e = { url: t.url || t.pendingUrl || '', title: t.title || '' };
  if (typeof t.groupId === 'number' && t.groupId >= 0) {
    const g = groups.get(t.groupId);
    e.g = String(t.groupId);
    e.gt = g?.title || '';
    e.gc = g?.color || 'grey';
    e.gx = !!g?.collapsed;
  }
  return e;
}

// Sichert den Inhalt aller Workspaces, falls ein Fenster verloren geht
// (z. B. wenn das Hauptfenster per X geschlossen wird).
async function snapshot() {
  if (await getPending()) return; // Wechsel noch nicht abgeschlossen
  const cfg = await getConfig();
  const s = await sess();
  const { stash, mains } = await scan();
  // Ohne (zugeordnete) Hauptfenster ist der Zustand im Übergang (Start, Beenden,
  // neues Fenster): alte Sicherung behalten, reconcile sichert danach.
  if (!mains.length || mains.some((w) => !s.windowWs[w.id])) return;
  const { backup } = await getBackup();
  const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));

  for (const ws of cfg.workspaces) {
    const sw = stash.get(ws.id);
    const showing = mains.filter((w) => s.windowWs[w.id] === ws.id);
    if (!sw && !showing.length) continue; // nichts Lebendes → alten Stand behalten
    backup[ws.id] = {
      stash: sw ? stashTabsOf(sw).map((t) => serTab(t, groups)) : [],
      shown: showing.flatMap((w) => movableTabsOf(w).map((t) => serTab(t, groups))),
    };
  }
  for (const k of Object.keys(backup)) {
    if (!cfg.workspaces.some((w) => w.id === k)) delete backup[k];
  }
  // Ablage-Fenster merken, um sie nach einem Neuladen der Erweiterung zu reparieren
  const prev = (await chrome.storage.local.get('stashWins')).stashWins || {};
  const stashWins = {};
  for (const [ws, w] of stash) stashWins[w.id] = { ws, tabs: stashTabsOf(w).map((t) => t.id) };
  for (const w of mains) if (prev[w.id] && !s.windowWs[w.id]) stashWins[w.id] = prev[w.id];

  const backupWindows = mains.map((w) => ({
    ws: s.windowWs[w.id],
    urls: movableTabsOf(w).map((t) => t.url || t.pendingUrl),
  }));

  const data = { backup, stashWins, backupWindows };
  if (mains.length) data.backupPinned = mains[0].tabs.filter((t) => t.pinned).map((t) => serTab(t, groups));
  await chrome.storage.local.set(data);
}

// ---------------------------------------------------------------- Abgleich

// Ordnet neue Hauptfenster einem Workspace zu. entries sind die beim letzten Mal
// gesicherten Fenster (Workspace + URLs); jeder Eintrag wird höchstens einmal vergeben.
function assignWindows(wins, s, cfg, entries) {
  const ids = cfg.workspaces.map((w) => w.id);
  const result = new Map();
  const rest = [];
  // 1. Tab wurde aus einem anderen Fenster herausgezogen
  for (const win of wins) {
    const o = win.tabs.map((t) => s.tabOrigin[t.id]).find((x) => x && ids.includes(x));
    if (o) result.set(win.id, o);
    else rest.push(win);
  }
  // 2. Beim Browserstart wiederhergestellte Fenster: über die gesicherten URLs.
  //    Seiten, die in mehreren Einträgen vorkommen (z. B. ChatGPT in jedem Workspace),
  //    zählen entsprechend weniger. Vergeben wird nach dem besten Paar über alle
  //    Fenster, nicht der Reihe nach, damit ein Fenster nicht einem anderen den
  //    passenderen Eintrag wegnimmt.
  const valid = entries.map((e, i) => ({ ...e, i })).filter((e) => ids.includes(e.ws));
  const df = new Map();
  for (const e of valid) for (const u of new Set(e.urls)) df.set(u, (df.get(u) || 0) + 1);
  const urlsOf = (win) =>
    movableTabsOf(win)
      .map((t) => t.url || t.pendingUrl)
      .filter((u) => u && !u.startsWith('chrome://newtab'));
  const pairs = [];
  for (const win of rest) {
    const urls = urlsOf(win);
    for (const e of valid) {
      const left = new Map();
      for (const u of e.urls) left.set(u, (left.get(u) || 0) + 1);
      let score = 0;
      for (const u of urls) {
        if (left.get(u) > 0) {
          left.set(u, left.get(u) - 1);
          score += 1 / df.get(u);
        }
      }
      if (score > 0) pairs.push({ win: win.id, e, score, diff: Math.abs(e.urls.length - urls.length) });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.diff - b.diff);
  const used = new Set();
  for (const p of pairs) {
    if (result.has(p.win) || used.has(p.e.i)) continue;
    result.set(p.win, p.e.ws);
    used.add(p.e.i);
  }
  for (const i of [...used].sort((a, b) => b - a)) entries.splice(i, 1);
  // 3. Neues Fenster (Strg+N): Workspace des zuletzt benutzten Fensters
  for (const win of rest) if (!result.has(win.id)) result.set(win.id, cfg.lastWs);
  return result;
}

// Ordnet die gesicherten URLs den lebenden zu (längste gemeinsame Teilfolge).
// Ergebnis: für jeden gesicherten Eintrag der Index des lebenden Tabs oder -1.
function align(saved, live) {
  const n = saved.length;
  const m = live.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = saved[i] === live[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const match = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (saved[i] === live[j]) match[i++] = j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return match;
}

// Nach dem Browserstart: Tabs ergänzen, die Chromium beim Wiederherstellen verloren hat.
// Chromium baut seine Session-Datei nach 250 Änderungen sofort neu auf. Fällt das in den
// Moment, in dem die Erweiterung einen Tab zwischen zwei Fenstern verschiebt (er ist dann
// kurz in keinem Fenster), fehlt dieser Tab in der Datei und kommt nach dem nächsten
// Start nicht wieder. Ergänzt wird nur, wo ein Workspace weniger Tabs hat als gesichert,
// und höchstens so viele, wie fehlen. Gleich viele abweichende Tabs an einer Stelle
// gelten als umgeleitete Seiten, nicht als verloren.
async function repairFromBackup(cfg, s, stash, mains) {
  const { backup } = await getBackup();
  let changed = false;
  for (const ws of cfg.workspaces) {
    const b = backup[ws.id];
    const wins = mains.filter((w) => s.windowWs[w.id] === ws.id);
    const sw = stash.get(ws.id);
    if (!b || (!wins.length && !sw)) continue;
    const live = [...wins.flatMap(movableTabsOf), ...(sw ? stashTabsOf(sw) : [])];
    const shown = (b.shown || []).filter((e) => e.url);
    const saved = [...shown, ...(b.stash || []).filter((e) => e.url)];
    let budget = saved.length - live.length;
    if (budget <= 0) continue;
    const match = align(
      saved.map((e) => e.url),
      live.map((t) => t.url || t.pendingUrl),
    );
    // Wie oft fehlt jede URL? (unabhängig von der Reihenfolge der Fenster)
    const need = new Map();
    for (const e of saved) need.set(e.url, (need.get(e.url) || 0) + 1);
    for (const t of live) {
      const u = t.url || t.pendingUrl;
      if (need.has(u)) need.set(u, need.get(u) - 1);
    }
    // Kandidaten zuerst aus Lücken, in denen die Sicherung mehr Einträge hat als die
    // Fenster; gleich viele abweichende Tabs sind eher umgeleitete Seiten.
    const gap = [];
    for (let i = 0; i < saved.length; ) {
      if (match[i] >= 0) {
        i++;
        continue;
      }
      let k = i;
      while (k < saved.length && match[k] < 0) k++;
      const prev = i > 0 ? match[i - 1] : -1;
      const next = k < saved.length ? match[k] : live.length;
      const deficit = k - i - (next - prev - 1);
      for (let x = Math.max(i, k - deficit); x < k; x++) gap.push(x);
      i = k;
    }
    const missing = new Set();
    for (const x of [...gap, ...saved.keys()]) {
      const u = saved[x].url;
      if (budget > 0 && match[x] < 0 && !missing.has(x) && need.get(u) > 0) {
        missing.add(x);
        need.set(u, need.get(u) - 1);
        budget--;
      }
    }
    if (!missing.size) continue;

    const created = new Map();
    let anchor = null;
    for (let x = 0; x < saved.length; x++) {
      if (x === shown.length) anchor = null; // Ablage-Abschnitt: nicht hinter Tabs des Hauptfensters
      if (match[x] >= 0) {
        anchor = live[match[x]].id;
        continue;
      }
      if (!missing.has(x)) continue;
      const a = anchor && (await chrome.tabs.get(anchor).catch(() => null));
      let windowId;
      let index;
      if (a) {
        windowId = a.windowId;
        index = a.index + 1;
      } else {
        windowId = (x < shown.length ? wins[0] || sw : sw || wins[0]).id;
        index = (await chrome.tabs.query({ windowId })).filter((t) => t.pinned).length;
      }
      try {
        const t = await chrome.tabs.create({ windowId, index, url: saved[x].url, active: false });
        created.set(x, t);
        anchor = t.id;
        changed = true;
        console.info('[workspaces] verlorenen Tab ergänzt:', saved[x].url);
      } catch (err) {
        console.warn('[workspaces] Tab nicht ergänzbar:', saved[x].url, err);
      }
    }
    // Gruppen: der Gruppe eines Nachbarn mit derselben gesicherten Gruppe beitreten,
    // sonst die Gruppe neu anlegen.
    for (const [x, t] of created) {
      const e = saved[x];
      if (!e.g) continue;
      try {
        let gid = -1;
        for (let y = 0; y < saved.length && gid < 0; y++) {
          if (y === x || saved[y].g !== e.g) continue;
          const other = match[y] >= 0 ? live[match[y]] : created.get(y);
          const cur = other && (await chrome.tabs.get(other.id).catch(() => null));
          if (cur && cur.windowId === t.windowId && cur.groupId >= 0) gid = cur.groupId;
        }
        if (gid >= 0) {
          await chrome.tabs.group({ groupId: gid, tabIds: [t.id] });
        } else {
          gid = await chrome.tabs.group({ tabIds: [t.id], createProperties: { windowId: t.windowId } });
          await chrome.tabGroups.update(gid, { title: e.gt || '', color: e.gc || 'grey', collapsed: !!e.gx });
        }
      } catch (err) {
        console.warn('[workspaces] Gruppe nicht ergänzbar', err);
      }
    }
  }
  return changed;
}

let resumeTries = 0;

async function reconcile() {
  let changed = false;
  try {
    changed = await resumeSwitch();
    resumeTries = 0;
  } catch (err) {
    console.warn('[workspaces] Wechsel noch nicht abschließbar:', err);
    if (++resumeTries < 20) scheduleReconcile();
    return; // Zuordnung stimmt noch nicht, z. B. würde repairFromBackup sonst Tabs doppelt anlegen
  }
  const cfg = await getConfig();
  const s = await sess();
  let { stash, mains, dups } = await scan();

  // Ablage-Fenster, deren Ablage-Seite fehlt (z. B. weil die Erweiterung neu geladen
  // wurde und Chromium dabei ihre Seiten schließt), wieder zu Ablagen machen.
  const { stashWins } = await chrome.storage.local.get('stashWins');
  if (stashWins) {
    let repaired = false;
    for (const w of mains) {
      const rec = stashWins[w.id];
      if (!rec || s.windowWs[w.id] || !cfg.workspaces.some((x) => x.id === rec.ws)) continue;
      const ids = new Set(rec.tabs);
      if (!w.tabs.some((t) => ids.has(t.id))) continue;
      await chrome.tabs.create({ windowId: w.id, url: `${STASH_PAGE}#${rec.ws}`, index: 0, pinned: true, active: true });
      repaired = true;
    }
    if (repaired) {
      ({ stash, mains, dups } = await scan());
      changed = true;
    }
  }

  // Doppelte Ablagen zusammenführen
  for (const d of dups) {
    const target = stash.get(stashWsOf(d));
    await moveOrdered(stashTabsOf(d), target.id);
    await chrome.windows.remove(d.id).catch(() => {});
    changed = true;
  }

  // Ablagen, deren Workspace fehlt, als Workspace zurückholen
  for (const wsId of stash.keys()) {
    if (!cfg.workspaces.some((w) => w.id === wsId)) {
      cfg.workspaces.push({ id: wsId, name: 'Wiederhergestellt', color: '#64748b', emoji: '' });
      await saveWorkspaces(cfg.workspaces);
    }
  }

  // Ablage-Fenster: minimiert, Ablage-Tab angeheftet und aktiv (wichtig für den Titel).
  // Ohne Hauptfenster kann Chromium einen beim Start übergebenen Link in eine
  // wiederhergestellte Ablage gelegt haben – diesen merken und gleich sichtbar machen.
  const foreign = [];
  for (const w of stash.values()) {
    const st = w.tabs.find(isStashTab);
    const act = w.tabs.find((t) => t.active);
    if (!mains.length && act && !isStashTab(act)) foreign.push(act);
    if (!st.pinned) await chrome.tabs.update(st.id, { pinned: true });
    if (!st.active) await chrome.tabs.update(st.id, { active: true });
    if (w.state !== 'minimized') await chrome.windows.update(w.id, { state: 'minimized' }).catch(() => {});
  }

  const { backup, backupPinned } = await getBackup();

  // Kein Hauptfenster, aber Ablagen (z. B. nach Schließen per X und Neustart):
  // Hauptfenster neu aufbauen.
  if (!mains.length && stash.size) {
    switching++;
    try {
      const target = cfg.lastWs;
      const win = await chrome.windows.create({ focused: true });
      const blank = win.tabs[0].id;
      s.windowWs[win.id] = target;
      await saveSess(s);
      await recreate(backupPinned, win.id, true);
      let ids = await recreate(backup[target]?.shown || [], win.id);
      const st = stash.get(target);
      if (st) ids = ids.concat(await moveOrdered(stashTabsOf(st), win.id));
      if (foreign.length) ids = (await moveOrdered(foreign, win.id)).concat(ids);
      if (ids.length) {
        await chrome.tabs.update(ids[0], { active: true });
        await chrome.tabs.remove(blank);
      }
    } finally {
      switching--;
    }
    ({ stash, mains } = await scan());
    changed = true;
  }

  // Zuordnungen verschwundener Fenster entfernen, neue Fenster zuordnen
  for (const id of Object.keys(s.windowWs)) {
    if (!mains.some((w) => String(w.id) === id)) delete s.windowWs[id];
  }
  // Nach Browserstart oder Neuladen der Erweiterung ist storage.session leer: dann die
  // gesicherten Fenster-Einträge für 20 s zur Zuordnung wiederhergestellter Fenster nutzen.
  let { entries, entriesUntil } = await chrome.storage.session.get(['entries', 'entriesUntil']);
  if (entriesUntil === undefined) {
    entries = (await chrome.storage.local.get('backupWindows')).backupWindows || [];
    entriesUntil = Date.now() + 20000;
  }
  // Solange läuft auch die Reparatur verlorener Tabs. Sie hängt nicht nur am ersten
  // Abgleich, weil der Service Worker vor der Sitzungswiederherstellung laufen kann.
  const starting = Date.now() <= entriesUntil;
  if (!starting) entries = [];
  const fresh = mains.filter((w) => !s.windowWs[w.id]);
  if (fresh.length) {
    for (const [id, ws] of assignWindows(fresh, s, cfg, entries)) s.windowWs[id] = ws;
    changed = true;
  }
  await chrome.storage.session.set({ entries, entriesUntil });
  if (starting) {
    switching++;
    try {
      if (await repairFromBackup(cfg, s, stash, mains)) changed = true;
    } finally {
      switching--;
    }
  }
  s.tabOrigin = {};
  await saveSess(s);

  await updateAllIcons();
  if (changed) await snapshot();
}

async function onWindowRemoved(winId) {
  const s = await sess();
  const ws = s.windowWs[winId];
  if ((await getPending())?.windowId === winId) scheduleReconcile();
  if (ws === undefined) {
    scheduleReconcile();
    return;
  }
  delete s.windowWs[winId];
  await saveSess(s);
  const { stash, mains } = await scan();

  if (!mains.length) {
    // Letztes sichtbares Fenster geschlossen → Ablagen auch schließen, damit der
    // Browser wirklich beendet wird. Die Tabs stehen in der Sicherung.
    for (const w of stash.values()) await chrome.windows.remove(w.id).catch(() => {});
    return;
  }
  // Ein Fenster von mehreren wurde geschlossen: seine Tabs sind bewusst weg.
  if (!mains.some((w) => s.windowWs[w.id] === ws) && !stash.has(ws)) await clearBackup(ws);
  await snapshot();
}

// ---------------------------------------------------------------- Symbole

const iconCache = new Map();

function drawIcon(ws, size) {
  const c = new OffscreenCanvas(size, size);
  const x = c.getContext('2d');
  const r = size * 0.24;
  x.fillStyle = ws.color || COLORS[0];
  x.beginPath();
  x.roundRect(0, 0, size, size, r);
  x.fill();
  const label = ws.emoji || (ws.name.trim()[0] || '?').toUpperCase();
  x.fillStyle = '#ffffff';
  x.font = `600 ${Math.round(size * (ws.emoji ? 0.7 : 0.64))}px system-ui, sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(label, size / 2, size / 2 + size * 0.05);
  return x.getImageData(0, 0, size, size);
}

function iconFor(ws) {
  const key = `${ws.id}|${ws.color}|${ws.emoji}|${ws.name}`;
  if (!iconCache.has(key)) iconCache.set(key, { 16: drawIcon(ws, 16), 32: drawIcon(ws, 32) });
  return iconCache.get(key);
}

async function setTabIcon(tabId, wsId) {
  const cfg = await getConfig();
  const ws = cfg.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  await chrome.action.setIcon({ tabId, imageData: iconFor(ws) }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: `Workspace: ${ws.name}` }).catch(() => {});
}

async function updateIcons(windowId) {
  const s = await sess();
  const wsId = s.windowWs[windowId];
  if (!wsId) return;
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(tabs.map((t) => setTabIcon(t.id, wsId)));
}

async function updateAllIcons() {
  const s = await sess();
  await Promise.all(Object.keys(s.windowWs).map((id) => updateIcons(Number(id))));
}

// ---------------------------------------------------------------- Kontextmenü

async function buildMenus() {
  const cfg = await getConfig();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'move',
    title: 'Tab in Workspace verschieben',
    contexts: ['page', 'action'],
  });
  for (const ws of cfg.workspaces) {
    chrome.contextMenus.create({
      id: `move:${ws.id}`,
      parentId: 'move',
      title: `${ws.emoji ? ws.emoji + ' ' : ''}${ws.name}`,
      contexts: ['page', 'action'],
    });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !String(info.menuItemId).startsWith('move:')) return;
  const wsId = String(info.menuItemId).slice(5);
  serial(() => moveTabToWs(tab.id, wsId));
});

// ---------------------------------------------------------------- Ereignisse

chrome.windows.onCreated.addListener(() => scheduleReconcile(), { windowTypes: ['normal'] });
chrome.windows.onRemoved.addListener((id) => serial(() => onWindowRemoved(id)), { windowTypes: ['normal'] });

chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  const s = await sess();
  const ws = s.windowWs[winId];
  if (ws) await chrome.storage.local.set({ lastWs: ws });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (switching) return;
  serial(async () => {
    const s = await sess();
    const ws = s.windowWs[windowId];
    if (!ws) return;
    s.lastTab[ws] = tabId;
    await saveSess(s);
  });
});

chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  if (switching) return;
  serial(async () => {
    const s = await sess();
    if (s.windowWs[oldWindowId]) {
      s.tabOrigin[tabId] = s.windowWs[oldWindowId];
      await saveSess(s);
    }
  });
  scheduleSnapshot();
});

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  if (switching) return;
  const s = await sess();
  if (s.windowWs[newWindowId]) await setTabIcon(tabId, s.windowWs[newWindowId]);
  scheduleSnapshot();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (switching) return;
  const s = await sess();
  if (s.windowWs[tab.windowId]) await setTabIcon(tab.id, s.windowWs[tab.windowId]);
  scheduleSnapshot();
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) return;
  scheduleReconcile(); // falls eine Ablage-Seite geschlossen wurde
  scheduleSnapshot();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined) scheduleSnapshot();
});
chrome.tabs.onMoved.addListener(() => scheduleSnapshot());
chrome.tabGroups.onUpdated.addListener(() => scheduleSnapshot());

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  let windowId = tab?.windowId;
  if (!windowId) windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  if (cmd === 'next-workspace') serial(() => switchRelative(windowId, 1));
  if (cmd === 'prev-workspace') serial(() => switchRelative(windowId, -1));
});

// ---------------------------------------------------------------- Nachrichten (Popup, Ablage-Seite)

async function stateFor(windowId) {
  const cfg = await getConfig();
  const s = await sess();
  const { stash, mains } = await scan();
  const { backup } = await getBackup();
  const list = cfg.workspaces.map((ws) => {
    const sw = stash.get(ws.id);
    const showing = mains.filter((w) => s.windowWs[w.id] === ws.id);
    let count;
    if (sw || showing.length) {
      count = (sw ? stashTabsOf(sw).length : 0) + showing.reduce((n, w) => n + movableTabsOf(w).length, 0);
    } else {
      const b = backup[ws.id];
      count = b ? (b.stash?.length || 0) + (b.shown?.length || 0) : 0;
    }
    return { ...ws, count, elsewhere: showing.some((w) => w.id !== windowId) };
  });
  return { workspaces: list, current: s.windowWs[windowId] || null, colors: COLORS };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = async () => {
    switch (msg.type) {
      case 'state':
        return stateFor(msg.windowId);
      case 'switch':
        return serial(() => switchTo(msg.windowId, msg.wsId));
      case 'create': {
        const ws = await serial(() => createWs(msg.name));
        return ws;
      }
      case 'update':
        return serial(() => updateWs(msg.wsId, msg.patch));
      case 'reorder':
        return serial(() => reorderWs(msg.ids));
      case 'delete':
        return serial(() => deleteWs(msg.wsId));
      case 'moveTab':
        return serial(() => moveTabToWs(msg.tabId, msg.wsId));
    }
  };
  run().then(
    (r) => reply({ ok: true, result: r }),
    (e) => reply({ ok: false, error: String(e) }),
  );
  return true;
});

// ---------------------------------------------------------------- Start

chrome.runtime.onInstalled.addListener(() => serial(buildMenus));
chrome.runtime.onStartup.addListener(() =>
  serial(async () => {
    // Fenster- und Tab-IDs gelten nur innerhalb einer Browsersitzung.
    await chrome.storage.local.remove('stashWins');
    await buildMenus();
  }),
);
scheduleReconcile();
