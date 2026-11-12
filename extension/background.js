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

importScripts('exchange.js', 'label.js');

const STASH_PAGE = chrome.runtime.getURL('stash.html');
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#64748b'];

let switching = 0; // > 0, solange wir selbst Tabs verschieben

// Führt fn aus, während die Tab-Ereignisse die eigenen Änderungen übergehen
async function moving(fn) {
  switching++;
  try {
    return await fn();
  } finally {
    switching--;
  }
}

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

// Geräteeigener Schlüssel im Titel der Ablage-Fenster (stash.js). Das KWin-Skript
// versteckt nur Fenster mit diesem Schlüssel, install.sh trägt ihn in kwinrc ein.
async function ensureToken() {
  let { token } = await chrome.storage.local.get('token');
  if (!token) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ token });
  }
  return token;
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

// Gesicherte Tabs eines Workspace: erst die gezeigten, dann die der Ablage
const savedOf = (b) => [...(b?.shown || []), ...(b?.stash || [])];

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

// Für Aktionen (Popup, Tastenkürzel, Menü): Nach Browserstart oder Neuladen der
// Erweiterung ist storage.session leer, bis der erste Abgleich gelaufen ist. Bis dahin
// gälte jedes Fenster als lastWs, deshalb den Abgleich vorziehen. Er läuft nicht schon
// beim Laden des Skripts, damit onStartup vorher die veralteten Fenster-IDs verwirft.
function userAction(fn) {
  return serial(async () => {
    const { entriesUntil } = await chrome.storage.session.get('entriesUntil');
    if (entriesUntil === undefined) await reconcile();
    return fn();
  });
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

const urlOf = (t) => t.url || t.pendingUrl;

function isStashTab(t) {
  return (urlOf(t) || '').startsWith(STASH_PAGE);
}

const isNewTab = (t) => /^chrome:\/\/(newtab|new-tab-page)\//.test(urlOf(t) || '');

function stashWsOf(win) {
  for (const t of win.tabs || []) {
    if (isStashTab(t)) return urlOf(t).split('#')[1] || null;
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

// Ablage (sw) und Hauptfenster (showing), in denen die Tabs von wsId gerade liegen
const windowsOf = (wsId, s, stash, mains) => ({
  sw: stash.get(wsId),
  showing: mains.filter((w) => s.windowWs[w.id] === wsId),
});

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

// Während ein Tab gezogen wird, lehnt der Browser Änderungen an Tabs vorübergehend ab
// („Tabs cannot be edited right now (user may be dragging a tab).“). Solche Aufrufe
// werden nach kurzer Pause wiederholt, insgesamt etwa drei Sekunden lang.
const BUSY = /cannot be edited right now/i;
async function whenIdle(fn, tries = 15) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !BUSY.test(err?.message || '')) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const groupProps = (e) => ({ title: e.gt || '', color: e.gc || 'grey', collapsed: !!e.gx });

// Legt gesicherte Tabs neu an (nur nötig, wenn ihr Fenster nicht mehr existiert).
// Gibt die neuen Tab-IDs und die Einträge zurück, die nicht angelegt werden konnten.
// Lässt sich eine Gruppe nicht anlegen, werden ihre Tabs wieder geschlossen und
// zählen samt Gruppenangaben als fehlgeschlagen, damit ein erneuter Versuch sie
// wieder als Gruppe anlegt. Fehlgeschlagene Gruppenmitglieder merken sich die URLs
// ihrer Geschwister (gs), denn Gruppen-IDs ändern sich bei jeder Wiederherstellung
// und jedem Browserstart. Mit join treten sie beim erneuten Versuch der Gruppe bei,
// in der ein Geschwister-Tab liegt (das Fenster zeigt dann nur diesen Workspace).
// have sind Tabs, die ein abgebrochener Aufruf für die ersten Einträge schon angelegt
// hat: Sie werden nicht noch einmal angelegt, aber mit dem Rest gruppiert.
async function recreate(list, windowId, pinned = false, join = false, have = []) {
  const ids = [];
  const failed = [];
  const groups = new Map();
  const used = new Set(); // in diesem Aufruf belegte Gruppen gehören zu einer anderen Sicherung
  const fail = (e) => {
    if (!e.g || pinned) return failed.push(e);
    const gs = list.filter((o) => o !== e && o.g === e.g).map((o) => o.url);
    failed.push({ ...e, gs: [...new Set([...(e.gs || []), ...gs])] });
  };
  let n = 0;
  for (const e of list) {
    if (!e.url) continue;
    try {
      const t = have[n++] || (await whenIdle(() => chrome.tabs.create({ windowId, url: e.url, active: false, pinned })));
      ids.push(t.id);
      if (e.g && !pinned) {
        if (!groups.has(e.g)) groups.set(e.g, []);
        groups.get(e.g).push({ id: t.id, e });
      }
    } catch (err) {
      console.warn('[workspaces] Tab nicht wiederherstellbar:', e.url, err);
      fail(e);
    }
  }
  for (const members of groups.values()) {
    const { e } = members[0];
    const props = groupProps(e);
    const tabIds = members.map((m) => m.id);
    try {
      let same = null;
      const gs = new Set(members.flatMap((m) => m.e.gs || []));
      if (join && gs.size) {
        for (const t of await chrome.tabs.query({ windowId })) {
          if (t.groupId < 0 || used.has(t.groupId) || !gs.has(urlOf(t))) continue;
          const g = await chrome.tabGroups.get(t.groupId);
          if (g.title === props.title && g.color === props.color) {
            same = g;
            break;
          }
        }
      }
      if (same) {
        used.add(await whenIdle(() => chrome.tabs.group({ groupId: same.id, tabIds })));
      } else {
        const gid = await whenIdle(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
        used.add(gid);
        await whenIdle(() => chrome.tabGroups.update(gid, props));
      }
    } catch (err) {
      console.warn('[workspaces] Gruppe nicht wiederherstellbar', err);
      for (const m of members) {
        try {
          await chrome.tabs.remove(m.id);
          ids.splice(ids.indexOf(m.id), 1);
          fail(m.e);
        } catch {
          // Tab bleibt ohne Gruppe erhalten
        }
      }
    }
  }
  return { ids, failed };
}

// Fehlgeschlagene angeheftete Tabs kennzeichnet p
const asPinned = (failed) => failed.map((e) => ({ ...e, p: true }));

// Bewahrt fehlgeschlagene Einträge getrennt von shown/stash auf, damit snapshot()
// sie nicht durch die lebenden Tabs ersetzt. Aus shown/stash (bzw. den angehefteten
// Tabs) werden sie entfernt, damit jeder Eintrag nur an einer Stelle steht.
async function keepFailed(wsId, failed) {
  if (!failed.length) return;
  const { backup, backupPinned } = await getBackup();
  const b = (backup[wsId] ??= { stash: [], shown: [] });
  for (const e of failed) {
    for (const arr of e.p ? [backupPinned] : [(b.shown ??= []), (b.stash ??= [])]) {
      const i = arr.findIndex((a) => a.url === e.url);
      if (i >= 0) {
        arr.splice(i, 1);
        break;
      }
    }
  }
  b.failed = [...(b.failed || []), ...failed];
  await chrome.storage.local.set({ backup, backupPinned });
}

// Legt die fehlgeschlagenen Tabs eines Workspace erneut an, im Fenster windowId.
// Zeigt das Fenster einen anderen Workspace, wird vorher dorthin gewechselt.
async function retryFailed(windowId, wsId) {
  await resumeSwitch();
  if ((await sess()).windowWs[windowId] !== wsId) await switchTo(windowId, wsId);
  if ((await sess()).windowWs[windowId] !== wsId) return;
  const list = (await getBackup()).backup[wsId]?.failed || [];
  if (!list.length) return;
  const still = await moving(async () => {
    const p = await recreate(list.filter((e) => e.p), windowId, true);
    const r = await recreate(list.filter((e) => !e.p), windowId, false, true);
    return [...p.failed, ...r.failed];
  });
  const { backup } = await getBackup();
  backup[wsId].failed = still;
  await chrome.storage.local.set({ backup });
  await updateAllIcons();
  await snapshot();
}

async function dismissFailed(wsId) {
  const { backup } = await getBackup();
  if (!backup[wsId]?.failed) return;
  delete backup[wsId].failed;
  await chrome.storage.local.set({ backup });
  await updateAllIcons();
}

async function ensureStash(wsId, restoreBackup) {
  const { stash } = await scan();
  const w = stash.get(wsId);
  if (w) return { windowId: w.id, tabId: w.tabs.find(isStashTab).id };
  const win = await chrome.windows.create({ url: `${STASH_PAGE}#${wsId}`, focused: false, state: 'minimized' });
  const tabId = win.tabs[0].id;
  await chrome.tabs.update(tabId, { pinned: true });
  if (restoreBackup) {
    const b = (await getBackup()).backup[wsId];
    if (b) await keepFailed(wsId, (await recreate(savedOf(b), win.id)).failed);
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
  try {
    await moving(async () => {
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
          const r = await recreate(savedOf(b), windowId);
          brought = r.ids;
          await keepFailed(targetWs, r.failed);
          await setPending(p);
        }
      }
      if (!brought.length) {
        const t = await chrome.tabs.create({ windowId, active: true });
        brought = [t.id];
      }
      const want = s.lastTab[targetWs];
      await chrome.tabs.update(brought.includes(want) ? want : brought[0], { active: true });
    });
  } catch (err) {
    console.warn('[workspaces] Wechsel unterbrochen, schließe ihn anhand der Fenster ab:', err);
    failed = err;
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
  return moving(async () => {
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
      // Service Worker endete beim Neuanlegen aus der Sicherung: den Rest ergänzen und
      // die Gruppen anlegen, auch für die schon angekommenen Tabs
      const list = savedOf((await getBackup()).backup[p.to]);
      await keepFailed(p.to, (await recreate(list, p.windowId, false, false, arrived)).failed);
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
  });
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
  // Das Ziel kann inzwischen gelöscht sein (Löschen oder Import lief noch); ohne diese
  // Prüfung entstünde eine Ablage, die der Abgleich als „Wiederhergestellt“ zurückholt
  const cfg = await getConfig();
  if (!cfg.workspaces.some((w) => w.id === wsId)) return;
  const tab = await chrome.tabs.get(tabId);
  const s = await sess();
  if (s.windowWs[tab.windowId] === wsId) return;
  const { mains } = await scan();
  const main = mains.find((w) => w.id === tab.windowId);
  if (!main) return;

  await moving(async () => {
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
  });
  const s2 = await sess();
  delete s2.tabOrigin[tabId];
  await saveSess(s2);
  await setTabIcon(tabId, wsId);
  await snapshot();
}

// Ein Tab in einer Ablage wurde aktiv, ohne dass die Erweiterung es war (z. B. über die
// Tab-Suche des Browsers). Die Ablage verliert dadurch ihren Titel und wird sichtbar.
// Deshalb zeigt das zuletzt benutzte Hauptfenster diesen Workspace mit dem gewählten Tab.
async function showStashTab(tabId) {
  await resumeSwitch();
  const s = await sess();
  const { stash, mains } = await scan();
  const sw = [...stash.values()].find((w) => w.tabs.some((t) => t.id === tabId && t.active && !isStashTab(t)));
  if (!sw) return;
  const { lastMain } = await chrome.storage.session.get('lastMain');
  const main = mains.find((w) => w.id === lastMain && s.windowWs[w.id]) || mains.find((w) => s.windowWs[w.id]);
  if (!main) return; // noch kein Hauptfenster zugeordnet: der Abgleich räumt auf
  const ws = stashWsOf(sw);
  s.lastTab[ws] = tabId;
  await saveSess(s);
  if (s.windowWs[main.id] !== ws) {
    await switchTo(main.id, ws);
  } else {
    // Das Fenster zeigt den Workspace schon, die Ablage stammt von einem zweiten Fenster
    await moving(async () => {
      await moveOrdered(stashTabsOf(sw), main.id);
      await chrome.tabs.update(tabId, { active: true });
    });
    await updateIcons(main.id);
    await snapshot();
  }
  await chrome.windows.update(sw.id, { state: 'minimized' }).catch(() => {});
  await chrome.windows.update(main.id, { focused: true }).catch(() => {});
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
  ws.name = wsName(ws.name);
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
  // Fehlgeschlagene Einträge waren nie in einem Fenster und bleiben für einen erneuten Versuch
  const failed = backup[wsId]?.failed;
  backup[wsId] = { stash: [], shown: [], ...(failed?.length ? { failed } : {}) };
  await chrome.storage.local.set({ backup });
}

// ---------------------------------------------------------------- Sicherung

function serTab(t, groups) {
  const e = { url: urlOf(t) || '', title: t.title || '' };
  if (typeof t.groupId === 'number' && t.groupId >= 0) {
    const g = groups.get(t.groupId);
    e.g = String(t.groupId);
    e.gt = g?.title || '';
    e.gc = g?.color || 'grey';
    e.gx = !!g?.collapsed;
  }
  return e;
}

// Angeheftete Tabs aller Hauptfenster, jede Adresse so oft, wie sie in einem einzelnen
// Fenster höchstens vorkommt: dieselbe Adresse in zwei Fenstern zählt einmal.
function pinnedOf(mains, groups) {
  const out = [];
  const most = new Map();
  for (const w of mains) {
    const own = new Map();
    for (const e of w.tabs.filter((t) => t.pinned).map((t) => serTab(t, groups))) {
      const n = (own.get(e.url) || 0) + 1;
      own.set(e.url, n);
      if (n > (most.get(e.url) || 0)) {
        most.set(e.url, n);
        out.push(e);
      }
    }
  }
  return out;
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
    const { sw, showing } = windowsOf(ws.id, s, stash, mains);
    if (!sw && !showing.length) continue; // nichts Lebendes → alten Stand behalten
    const failed = backup[ws.id]?.failed;
    backup[ws.id] = {
      stash: sw ? stashTabsOf(sw).map((t) => serTab(t, groups)) : [],
      shown: showing.flatMap((w) => movableTabsOf(w).map((t) => serTab(t, groups))),
      ...(failed?.length ? { failed } : {}),
    };
  }
  for (const k of Object.keys(backup)) {
    if (!cfg.workspaces.some((w) => w.id === k)) delete backup[k];
  }
  // Ablage-Fenster merken, um sie nach einem Neuladen der Erweiterung zu reparieren
  const stashWins = {};
  for (const [ws, w] of stash) stashWins[w.id] = { ws, tabs: stashTabsOf(w).map((t) => t.id) };

  const backupWindows = mains.map((w) => ({
    id: w.id,
    ws: s.windowWs[w.id],
    urls: movableTabsOf(w).map(urlOf),
  }));

  await chrome.storage.local.set({ backup, stashWins, backupWindows, backupPinned: pinnedOf(mains, groups) });
}

// ---------------------------------------------------------------- Abgleich

// Ordnet neue Hauptfenster einem Workspace zu. entries sind die beim letzten Mal
// gesicherten Fenster (ID, Workspace und URLs); jeder Eintrag wird höchstens einmal vergeben.
// Fenster, die nur geraten zugeordnet wurden (Schritt 4), landen in guessed.
function assignWindows(wins, s, cfg, entries, guessed = new Set()) {
  const ids = cfg.workspaces.map((w) => w.id);
  const result = new Map();
  const rest = [];
  // 1. Tab wurde aus einem anderen Fenster herausgezogen
  for (const win of wins) {
    const o = win.tabs.map((t) => s.tabOrigin[t.id]).find((x) => x && ids.includes(x));
    if (o) result.set(win.id, o);
    else rest.push(win);
  }
  // 2. Nach Neuladen der Erweiterung: über die gesicherte Fenster-ID. Sie gilt nur
  //    innerhalb einer Browsersitzung, onStartup entfernt sie deshalb.
  const used = new Set();
  for (const win of rest) {
    const i = entries.findIndex((e, j) => e.id === win.id && !used.has(j) && ids.includes(e.ws));
    if (i < 0) continue;
    result.set(win.id, entries[i].ws);
    used.add(i);
  }
  // 3. Beim Browserstart wiederhergestellte Fenster: über die gesicherten URLs.
  //    Seiten, die in mehreren Einträgen vorkommen (z. B. ChatGPT in jedem Workspace),
  //    zählen entsprechend weniger. Vergeben wird nach dem besten Paar über alle
  //    Fenster, nicht der Reihe nach, damit ein Fenster nicht einem anderen den
  //    passenderen Eintrag wegnimmt.
  const valid = entries.map((e, i) => ({ ...e, i })).filter((e) => ids.includes(e.ws) && !used.has(e.i));
  const df = new Map();
  for (const e of valid) for (const u of new Set(e.urls)) df.set(u, (df.get(u) || 0) + 1);
  const urlsOf = (win) =>
    movableTabsOf(win)
      .filter((t) => !isNewTab(t))
      .map(urlOf)
      .filter(Boolean);
  const pairs = [];
  for (const win of rest) {
    if (result.has(win.id)) continue;
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
  for (const p of pairs) {
    if (result.has(p.win) || used.has(p.e.i)) continue;
    result.set(p.win, p.e.ws);
    used.add(p.e.i);
  }
  for (const i of [...used].sort((a, b) => b - a)) entries.splice(i, 1);
  // 4. Neues Fenster (Strg+N): Workspace des zuletzt benutzten Fensters
  for (const win of rest) {
    if (result.has(win.id)) continue;
    result.set(win.id, cfg.lastWs);
    guessed.add(win.id);
  }
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
    const { sw, showing: wins } = windowsOf(ws.id, s, stash, mains);
    if (!b || (!wins.length && !sw)) continue;
    const live = [...wins.flatMap(movableTabsOf), ...(sw ? stashTabsOf(sw) : [])];
    const shown = (b.shown || []).filter((e) => e.url);
    const saved = savedOf(b).filter((e) => e.url);
    let budget = saved.length - live.length;
    if (budget <= 0) continue;
    const match = align(
      saved.map((e) => e.url),
      live.map(urlOf),
    );
    // Wie oft fehlt jede URL? (unabhängig von der Reihenfolge der Fenster)
    const need = new Map();
    for (const e of saved) need.set(e.url, (need.get(e.url) || 0) + 1);
    for (const u of live.map(urlOf)) if (need.has(u)) need.set(u, need.get(u) - 1);
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
          await chrome.tabGroups.update(gid, groupProps(e));
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
      // War die Ablage leer, hat Chromium statt ihrer Ablage-Seite eine neue Tab-Seite
      // geladen, damit das Fenster offen bleibt. Diese gehört nicht in den Workspace.
      const ids = new Set(rec.tabs);
      const blank = !ids.size && w.tabs.length && w.tabs.every(isNewTab);
      if (!blank && !w.tabs.some((t) => ids.has(t.id))) continue;
      await chrome.tabs.create({ windowId: w.id, url: `${STASH_PAGE}#${rec.ws}`, index: 0, pinned: true, active: true });
      if (blank) await chrome.tabs.remove(w.tabs.map((t) => t.id)).catch(() => {});
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
  // Eine neue Tab-Seite dort stammt von der Starteinstellung „Neuer-Tab-Seite“ und wird
  // geschlossen, sonst sammelt sich bei jedem Start eine weitere im Workspace an.
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
    await moving(async () => {
      const target = cfg.lastWs;
      const win = await chrome.windows.create({ focused: true });
      const blank = win.tabs[0].id;
      s.windowWs[win.id] = target;
      await saveSess(s);
      const p = await recreate(backupPinned, win.id, true);
      const r = await recreate(backup[target]?.shown || [], win.id);
      await keepFailed(target, [...asPinned(p.failed), ...r.failed]);
      let ids = r.ids;
      const st = stash.get(target);
      if (st) ids = ids.concat(await moveOrdered(stashTabsOf(st), win.id));
      const links = foreign.filter((t) => !isNewTab(t));
      if (links.length) ids = (await moveOrdered(links, win.id)).concat(ids);
      if (ids.length) {
        await chrome.tabs.update(ids[0], { active: true });
        await chrome.tabs.remove(blank);
      }
      for (const t of foreign) if (isNewTab(t)) await chrome.tabs.remove(t.id).catch(() => {});
    });
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
  const guessed = new Set();
  if (fresh.length) {
    for (const [id, ws] of assignWindows(fresh, s, cfg, entries, guessed)) s.windowWs[id] = ws;
    changed = true;
  }
  // Ein neues Fenster (Strg+N) hat den Fokus bekommen, bevor es zugeordnet war
  const focused = fresh.find((w) => w.focused);
  await chrome.storage.session.set({ entries, entriesUntil, ...(focused ? { lastMain: focused.id } : {}) });

  // Start ohne wiederhergestellte Fenster (Starteinstellung „Neuer-Tab-Seite“): Chromium
  // öffnet nur ein neues Fenster, höchstens mit den angehefteten Tabs. Den zuletzt aktiven
  // Workspace darin aus der Sicherung aufbauen, bevor ein Snapshot die Sicherung durch die
  // neue Tab-Seite ersetzt. Die anderen Workspaces kommen beim Wechseln aus der Sicherung.
  // Nur beim ersten Abgleich mit Fenstern, nachdem storage.session leer war.
  const { startChecked } = await chrome.storage.session.get('startChecked');
  if (!startChecked && mains.length) {
    await chrome.storage.session.set({ startChecked: true });
    if (!stash.size && mains.every((w) => guessed.has(w.id))) {
      if (await restoreStart(mains, s.windowWs[mains[0].id])) {
        ({ stash, mains } = await scan());
        changed = true;
      }
    }
  }
  if (starting && (await moving(() => repairFromBackup(cfg, s, stash, mains)))) changed = true;
  s.tabOrigin = {};
  await saveSess(s);

  await updateAllIcons();
  if (changed) await snapshot();
}

// Legt die gesicherten Tabs von wsId und die angehefteten Tabs im ersten Fenster an,
// soweit sie nicht schon offen sind (z. B. von Chromium wiederhergestellte angeheftete
// Tabs). Ein beim Start übergebener Link bleibt aktiv; eine einzelne neue Tab-Seite wird
// ersetzt.
async function restoreStart(wins, wsId) {
  const win = wins[0];
  const { backup, backupPinned } = await getBackup();
  const open = (pinned) => wins.flatMap((w) => w.tabs.filter((t) => !!t.pinned === pinned).map((t) => ({ url: urlOf(t) })));
  const saved = savedOf(backup[wsId]);
  const pinned = missingIn(backupPinned.filter((e) => e.url), open(true));
  const tabs = missingIn(saved.filter((e) => e.url), open(false));
  if (!pinned.length && !tabs.length) return false;
  await moving(async () => {
    const p = await recreate(pinned, win.id, true);
    const r = await recreate(tabs, win.id);
    await keepFailed(wsId, [...asPinned(p.failed), ...r.failed]);
    const ids = r.ids;
    const own = movableTabsOf(win);
    const blank = own.length === 1 && isNewTab(own[0]) ? own[0] : null;
    if (blank && ids.length && !saved.some((e) => e.url === urlOf(blank))) {
      await chrome.tabs.update(ids[0], { active: true });
      await chrome.tabs.remove(blank.id);
    }
  });
  console.info('[workspaces] Workspace nach dem Start aus der Sicherung aufgebaut');
  return true;
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

// ---------------------------------------------------------------- Export und Import

// Einträge aus list, deren URL in have nicht (oft genug) vorkommt
function missingIn(list, have) {
  const n = new Map();
  for (const e of have) n.set(e.url, (n.get(e.url) || 0) + 1);
  return list.filter((e) => {
    const k = n.get(e.url) || 0;
    n.set(e.url, k - 1);
    return k <= 0;
  });
}

// Inhalt aller Workspaces im Sicherungsformat: die lebenden Tabs, für Workspaces ohne
// Fenster die Sicherung, dahinter die nicht wiederhergestellten Einträge. Die
// Gruppenschlüssel werden je Herkunft getrennt, damit sich alte und neue Gruppen-IDs
// nicht vermischen.
async function collectAll() {
  const cfg = await getConfig();
  const s = await sess();
  const { stash, mains } = await scan();
  const { backup, backupPinned } = await getBackup();
  const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
  const tag = (list, p) => list.filter((e) => e.url).map((e) => (e.g ? { ...e, g: p + e.g } : e));
  const list = cfg.workspaces.map((ws) => {
    const { sw, showing } = windowsOf(ws.id, s, stash, mains);
    const b = backup[ws.id] || {};
    const live = !!sw || showing.length > 0;
    const open = live
      ? [...showing.flatMap(movableTabsOf), ...(sw ? stashTabsOf(sw) : [])].map((t) => serTab(t, groups))
      : savedOf(b);
    const failed = b.failed || [];
    return {
      ws,
      live,
      window: showing[0]?.id ?? sw?.id,
      open: tag(open, 'a').length,
      failed: failed.length,
      entries: [...tag(open, 'a'), ...tag(failed.filter((e) => !e.p), 'f')],
      pinnedFailed: failed.filter((e) => e.p),
    };
  });
  // Angeheftete Tabs aller Hauptfenster; was ein früheres Fenster schon hat, zählt einmal
  let pinnedOpen = backupPinned;
  if (mains.length) {
    pinnedOpen = [];
    const seen = new Set();
    for (const w of mains) {
      const own = w.tabs.filter((t) => t.pinned).map((t) => serTab(t, groups));
      pinnedOpen.push(...own.filter((e) => !seen.has(e.url)));
      for (const e of own) seen.add(e.url);
    }
  }
  pinnedOpen = pinnedOpen.filter((e) => e.url);
  const pinned = [...pinnedOpen, ...list.flatMap((x) => x.pinnedFailed).filter((e) => e.url)];
  return { cfg, mains, list, pinned, pinnedOpen };
}

async function exportAll() {
  await resumeSwitch();
  const { list, pinned } = await collectAll();
  return buildExchange(list, pinned, chrome.runtime.getURL(''));
}

// Ordnet beim Zusammenführen jedem importierten Workspace einen vorhandenen zu: zuerst
// über die ID (derselbe Workspace, etwa bei einem erneuten Import), sonst über den
// gleichen Namen. Jeder vorhandene Workspace wird höchstens einmal vergeben. Ergänzt
// werden nur Tabs, deren URL dort noch nicht (so oft) vorkommt.
// Beim Ersetzen verschwinden die fehlgeschlagenen angehefteten Tabs mit ihren alten
// Workspaces, dann zählen nur die offenen als vorhanden.
function planImport(data, all, mode = 'merge') {
  const byId = new Map(all.list.map((x) => [x.ws.id, x]));
  const used = new Set();
  const match = data.workspaces.map((imp) => {
    const t = imp.id && byId.get(imp.id);
    if (!t) return null;
    used.add(t.ws.id);
    return { target: t, by: 'id' };
  });
  data.workspaces.forEach((imp, i) => {
    if (match[i]) return;
    const t = all.list.find((x) => !used.has(x.ws.id) && x.ws.name.trim() === imp.name);
    if (!t) return;
    used.add(t.ws.id);
    match[i] = { target: t, by: 'name' };
  });
  return {
    merge: data.workspaces.map((imp, i) => ({
      imp,
      target: match[i]?.target || null,
      by: match[i]?.by || null,
      add: match[i] ? missingIn(imp.tabs, match[i].target.entries) : imp.tabs,
    })),
    pinnedAdd: missingIn(data.pinned, mode === 'replace' ? all.pinnedOpen : all.pinned),
  };
}

// Prüft die Datei und beschreibt, was Zusammenführen bzw. Ersetzen ändern würde.
async function previewImport(text) {
  const data = parseExchange(text, chrome.runtime.getURL(''));
  await resumeSwitch();
  const all = await collectAll();
  const plan = planImport(data, all);
  return {
    exported: data.exported,
    pinned: data.pinned.length,
    pinnedAdd: plan.pinnedAdd.length,
    workspaces: plan.merge.map(({ imp, target, by, add }) => ({
      name: imp.name,
      color: imp.color,
      emoji: imp.emoji,
      tabs: imp.tabs.length,
      groups: imp.groups,
      target: target && { name: target.ws.name, by },
      add: add.length,
    })),
    current: all.list.map((x) => ({ name: x.ws.name, open: x.open, failed: x.failed })),
  };
}

// Macht die Gruppenschlüssel eines Imports eindeutig. Die Geschwister einer Gruppe kommen
// aus allen Tabs der Datei (from), auch aus den übersprungenen, die schon vorhanden sind.
// Liegt eines davon in der Sicherung (existing) in einer Gruppe mit gleichem Namen und
// gleicher Farbe, übernimmt der neue Tab deren Schlüssel. Mit join merken sich die Tabs die
// URLs ihrer Geschwister (gs), damit recreate(…, join) sie der schon offenen Gruppe hinzufügt.
function importEntries(tabs, stamp, { from = tabs, existing = [], join = false } = {}) {
  const gs = new Map();
  for (const e of from) if (e.g) gs.set(e.g, [...(gs.get(e.g) || []), e.url]);
  const key = new Map(); // Importgruppe → Schlüssel; jeder vorhandene Schlüssel nur einmal
  const taken = new Set();
  return tabs.map((e) => {
    if (!e.g) return e;
    const sib = gs.get(e.g);
    if (!key.has(e.g)) {
      const same = existing.find((x) => x.g && !taken.has(x.g) && x.gt === e.gt && x.gc === e.gc && sib.includes(x.url));
      if (same) taken.add(same.g);
      key.set(e.g, same ? same.g : `${stamp}:${e.g}`);
    }
    const r = { ...e, g: key.get(e.g) };
    if (join) r.gs = sib;
    return r;
  });
}

// Angeheftete Tabs werden nur ergänzt, nie geschlossen.
async function addPinned(list) {
  if (!list.length) return { added: 0, failed: 0 };
  const { mains } = await scan();
  if (!mains.length) {
    const { backupPinned } = await getBackup();
    await chrome.storage.local.set({ backupPinned: [...backupPinned, ...list] });
    return { added: list.length, failed: 0 };
  }
  const r = await moving(() => recreate(list, mains[0].id, true));
  const ws = (await sess()).windowWs[mains[0].id] || (await getConfig()).lastWs;
  await keepFailed(ws, asPinned(r.failed));
  return { added: r.ids.length, failed: r.failed.length };
}

// Übernimmt eine Export-Datei. Die Datei wird vorher vollständig geprüft; ist sie
// ungültig, ändert sich nichts. 'merge' legt fehlende Workspaces an und ergänzt
// vorhandene, ohne etwas zu schließen. 'replace' legt alle Workspaces der Datei neu an
// und löscht danach die bisherigen samt ihren Tabs, deshalb nur mit Bestätigung.
async function importExchange(text, mode, confirmed) {
  const data = parseExchange(text, chrome.runtime.getURL(''));
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Unbekannte Import-Art.');
  if (mode === 'replace' && !confirmed) throw new Error('Ersetzen schließt Tabs und muss bestätigt werden.');
  await resumeSwitch();
  const all = await collectAll();
  const plan = planImport(data, all, mode);
  const stamp = `i${Date.now().toString(36)}`;
  const cfg = await getConfig();
  const { backup } = await getBackup();
  const taken = new Set(cfg.workspaces.map((w) => w.id));
  const res = { created: 0, merged: 0, added: 0, skipped: 0, failed: 0, removed: 0, closed: 0 };

  // Neuer Workspace, Tabs zunächst nur in der Sicherung. Die ID aus der Datei bleibt,
  // solange sie hier frei ist, damit ein späterer Import ihn wiedererkennt.
  const addWs = (imp) => {
    let id = imp.id && !taken.has(imp.id) ? imp.id : newId();
    while (taken.has(id)) id = newId();
    taken.add(id);
    cfg.workspaces.push({ id, name: imp.name, color: imp.color, emoji: imp.emoji });
    backup[id] = { stash: importEntries(imp.tabs, stamp), shown: [] };
    res.created++;
    res.added += imp.tabs.length;
    return id;
  };

  if (mode === 'replace') {
    const oldIds = cfg.workspaces.map((w) => w.id);
    const ids = data.workspaces.map(addWs);
    await chrome.storage.local.set({ backup });
    await saveWorkspaces(cfg.workspaces);
    // Erst alle Fenster zum ersten neuen Workspace wechseln, dann die alten löschen
    for (const w of all.mains) await switchTo(w.id, ids[0]);
    for (const id of oldIds) await deleteWs(id);
    await chrome.storage.local.set({ lastWs: ids[0] });
    res.removed = oldIds.length;
    res.closed = all.list.reduce((n, x) => n + x.open, 0);
  } else {
    for (const m of plan.merge) {
      if (!m.target) {
        addWs(m.imp);
        continue;
      }
      res.skipped += m.imp.tabs.length - m.add.length;
      if (!m.add.length) continue;
      res.merged++;
      if (!m.target.live) {
        const b = (backup[m.target.ws.id] ??= { stash: [], shown: [] });
        const existing = savedOf(b);
        b.stash = [...(b.stash || []), ...importEntries(m.add, stamp, { from: m.imp.tabs, existing })];
        res.added += m.add.length;
      }
    }
    await chrome.storage.local.set({ backup });
    await saveWorkspaces(cfg.workspaces);
    // Workspaces mit Fenster: Tabs gleich dort anlegen, sonst ersetzt der nächste
    // Snapshot die Sicherung wieder durch die lebenden Tabs.
    for (const m of plan.merge) {
      if (!m.target?.live || !m.add.length) continue;
      const entries = importEntries(m.add, stamp, { from: m.imp.tabs, join: true });
      const r = await moving(() => recreate(entries, m.target.window, false, true));
      await keepFailed(m.target.ws.id, r.failed);
      res.added += r.ids.length;
      res.failed += r.failed.length;
    }
  }
  const p = await addPinned(plan.pinnedAdd);
  res.pinned = p.added;
  res.failed += p.failed;
  res.pinnedSkipped = data.pinned.length - plan.pinnedAdd.length;
  await updateAllIcons();
  await snapshot();
  return res;
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
  const label = wsLabel(ws);
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

// Workspaces und Sicherung, aus denen die Symbole entstehen. Bei Aktualisierungen
// mehrerer Tabs einmal geladen und an setTabIcon übergeben.
async function iconSource() {
  const { workspaces } = await getConfig();
  const { backup } = await getBackup();
  return { workspaces, backup };
}

async function setTabIcon(tabId, wsId, src) {
  src ??= await iconSource();
  const ws = src.workspaces.find((w) => w.id === wsId);
  if (!ws) return;
  // Unvollständig wiederhergestellt: Zahl der fehlenden Tabs als Plakette
  const missing = src.backup[wsId]?.failed?.length || 0;
  let title = `Workspace: ${ws.name}`;
  if (missing) title += ` – ${missing} ${missing === 1 ? 'Tab' : 'Tabs'} nicht wiederhergestellt`;
  await chrome.action.setIcon({ tabId, imageData: iconFor(ws) }).catch(() => {});
  await chrome.action.setTitle({ tabId, title }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: missing ? String(missing) : '' }).catch(() => {});
  if (missing) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => {});
}

async function updateIcons(windowId, src) {
  const s = await sess();
  const wsId = s.windowWs[windowId];
  if (!wsId) return;
  const tabs = await chrome.tabs.query({ windowId });
  src ??= await iconSource();
  await Promise.all(tabs.map((t) => setTabIcon(t.id, wsId, src)));
}

async function updateAllIcons() {
  const s = await sess();
  const src = await iconSource();
  await Promise.all(Object.keys(s.windowWs).map((id) => updateIcons(Number(id), src)));
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
  userAction(() => moveTabToWs(tab.id, wsId));
});

// ---------------------------------------------------------------- Ereignisse

chrome.windows.onCreated.addListener(() => scheduleReconcile(), { windowTypes: ['normal'] });
chrome.windows.onRemoved.addListener((id) => serial(() => onWindowRemoved(id)), { windowTypes: ['normal'] });

chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  const s = await sess();
  const ws = s.windowWs[winId];
  if (!ws) return;
  await chrome.storage.local.set({ lastWs: ws });
  await chrome.storage.session.set({ lastMain: winId });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (switching) return;
  serial(async () => {
    const s = await sess();
    const ws = s.windowWs[windowId];
    if (!ws) return showStashTab(tabId);
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
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined) scheduleSnapshot();
  // Chromium setzt Symbol, Titel und Plakette eines Tabs beim Laden einer Seite zurück
  if (info.status === 'complete') {
    const ws = (await sess()).windowWs[tab.windowId];
    if (ws) await setTabIcon(tabId, ws);
  }
});
chrome.tabs.onMoved.addListener(() => scheduleSnapshot());
chrome.tabGroups.onUpdated.addListener(() => scheduleSnapshot());

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  let windowId = tab?.windowId;
  if (!windowId) windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  if (cmd === 'next-workspace') userAction(() => switchRelative(windowId, 1));
  if (cmd === 'prev-workspace') userAction(() => switchRelative(windowId, -1));
});

// ---------------------------------------------------------------- Nachrichten (Popup, Export und Import)

async function stateFor(windowId) {
  const cfg = await getConfig();
  const s = await sess();
  const { stash, mains } = await scan();
  const { backup } = await getBackup();
  const list = cfg.workspaces.map((ws) => {
    const { sw, showing } = windowsOf(ws.id, s, stash, mains);
    let count;
    if (sw || showing.length) {
      count = (sw ? stashTabsOf(sw).length : 0) + showing.reduce((n, w) => n + movableTabsOf(w).length, 0);
    } else {
      count = savedOf(backup[ws.id]).length;
    }
    const failed = backup[ws.id]?.failed?.length || 0;
    return { ...ws, count, failed, elsewhere: showing.some((w) => w.id !== windowId) };
  });
  return { workspaces: list, current: s.windowWs[windowId] || null, colors: COLORS };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = async () => {
    switch (msg.type) {
      case 'state':
        return stateFor(msg.windowId);
      case 'token':
        return serial(ensureToken);
      case 'switch':
        return userAction(() => switchTo(msg.windowId, msg.wsId));
      case 'create':
        return userAction(() => createWs(msg.name));
      case 'update':
        return userAction(() => updateWs(msg.wsId, msg.patch));
      case 'reorder':
        return userAction(() => reorderWs(msg.ids));
      case 'delete':
        return userAction(() => deleteWs(msg.wsId));
      case 'moveTab':
        return userAction(() => moveTabToWs(msg.tabId, msg.wsId));
      case 'retry':
        return userAction(() => retryFailed(msg.windowId, msg.wsId));
      case 'dismiss':
        return userAction(() => dismissFailed(msg.wsId));
      case 'export':
        return userAction(exportAll);
      case 'importPreview':
        return userAction(() => previewImport(msg.text));
      case 'import':
        return userAction(() => importExchange(msg.text, msg.mode, msg.confirmed));
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
    const { backupWindows } = await chrome.storage.local.get('backupWindows');
    if (backupWindows) await chrome.storage.local.set({ backupWindows: backupWindows.map(({ id, ...e }) => e) });
    await buildMenus();
  }),
);
// Bei jedem Start, damit auch eine ältere Installation ohne Neuladen ihren Schlüssel bekommt
serial(ensureToken);
scheduleReconcile();
