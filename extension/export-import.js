// Hintergrundlogik: Export und Import (Dateiformat in exchange.js)

// Trennt die Gruppenschlüssel einer Herkunft (Präfix p) von denen anderer Herkünfte
const tagGroups = (list, p) => list.filter((e) => e.url).map((e) => (e.g ? { ...e, g: p + e.g } : e));

// Inhalt aller Workspaces im Sicherungsformat: die lebenden Tabs samt den noch nicht
// angelegten (keepLater), für Workspaces ohne Fenster die Sicherung, dahinter die nicht
// wiederhergestellten Einträge. Die
// Gruppenschlüssel werden je Herkunft getrennt, damit sich alte und neue Gruppen-IDs
// nicht vermischen.
async function collectAll() {
  const cfg = await getConfig();
  const s = await sess();
  const { stash, mains } = await scan();
  const { backup, backupPinned } = await getBackup();
  const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
  const list = cfg.workspaces.map((ws) => {
    const { sw, showing } = windowsOf(ws.id, s, stash, mains);
    const b = backup[ws.id] || {};
    const live = !!sw || showing.length > 0;
    const open = live
      ? [...[...showing.flatMap(movableTabsOf), ...(sw ? stashTabsOf(sw) : [])].map((t) => serTab(t, groups)), ...(b.later || [])]
      : savedOf(b);
    const failed = b.failed || [];
    return {
      ws,
      live,
      window: showing[0]?.id ?? sw?.id,
      open: tagGroups(open, 'a').length,
      failed: failed.length,
      entries: [...tagGroups(open, 'a'), ...tagGroups(failed.filter((e) => !e.p), 'f')],
      pinnedFailed: failed.filter((e) => e.p),
    };
  });
  // Angeheftete Tabs zählen wie in der Sicherung (pinnedOf), damit Export und Import
  // denselben Bestand sehen. pinnedFirst: was addPinned beim Ergänzen schon im ersten Fenster vorfindet.
  const pinnedOpen = (mains.length ? pinnedOf(mains, groups) : backupPinned).filter((e) => e.url);
  const pinnedFirst = (mains.length ? pinnedOf(mains.slice(0, 1), groups) : backupPinned).filter((e) => e.url);
  const pinnedFailed = list.flatMap((x) => x.pinnedFailed).filter((e) => e.url);
  return { cfg, mains, list, pinned: [...pinnedOpen, ...pinnedFailed], pinnedOpen, pinnedFirst, pinnedFailed };
}

async function exportAll() {
  await resumeSwitch();
  const { list, pinned } = await collectAll();
  return buildExchange(list, pinned, chrome.runtime.getURL(''), await getSettings());
}

// Ein früherer Stand (keepEarlier) als Export-Datei ohne Einstellungen, wie collectAll
// für Workspaces ohne Fenster. Die Exportseite spielt ihn wie eine Datei ein.
function earlierExchange(e) {
  const list = e.workspaces.map((ws) => {
    const b = e.backup[ws.id] || {};
    return { ws, entries: [...tagGroups(savedOf(b), 'a'), ...tagGroups((b.failed || []).filter((x) => !x.p), 'f')] };
  });
  const pinnedFailed = e.workspaces.flatMap((ws) => (e.backup[ws.id]?.failed || []).filter((x) => x.p));
  const data = buildExchange(list, [...e.backupPinned, ...pinnedFailed].filter((x) => x.url), chrome.runtime.getURL(''));
  data.exported = new Date(e.at).toISOString();
  return data;
}

// Die früheren Stände für die Exportseite, die neuesten zuerst
async function earlierStates() {
  const { earlier = [] } = await chrome.storage.local.get('earlier');
  return earlier.map((e) => {
    const data = earlierExchange(e);
    return { at: e.at, workspaces: data.workspaces.length, tabs: data.workspaces.reduce((n, w) => n + w.tabs.length, 0), pinned: data.pinned.length };
  });
}

async function earlierText(at) {
  const { earlier = [] } = await chrome.storage.local.get('earlier');
  const e = earlier.find((x) => x.at === at);
  if (!e) throw new Error(tr('earlierGone'));
  return JSON.stringify(earlierExchange(e));
}

// Die Einstellungen, die der Export mitnimmt (#161)
async function getSettings() {
  const { muteStash } = await chrome.storage.local.get('muteStash');
  return { muteStash: !!muteStash, unloadAfter: await getUnloadAfter(), autoBackup: await getAutoBackup() };
}

// Übernimmt die Einstellungen aus einer Datei und gibt zurück, wie viele sich geändert
// haben. Die automatische Sicherung startet anders als beim Einschalten auf der
// Exportseite nicht sofort, sondern mit dem Wecker, wenn der Import fertig ist.
async function applySettings(settings) {
  const now = await getSettings();
  const changed = Object.entries(settings).filter(([k, v]) => now[k] !== v);
  if (!changed.length) return 0;
  await chrome.storage.local.set(Object.fromEntries(changed));
  await scheduleUnload();
  await scheduleAutoBackup();
  return changed.length;
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
    pinnedAdd: pinnedToAdd(data.pinned, all, mode),
  };
}

// Angeheftete Tabs, die der Import ergänzt. Eine Adresse fehlt, wenn die Datei sie öfter
// enthält, als der Export sie zählt. Dann ergänzt addPinned sie im ersten Fenster, bis sie
// dort (mit den fehlgeschlagenen) so oft vorkommt wie in der Datei.
function pinnedToAdd(list, all, mode) {
  const failed = mode === 'replace' ? [] : all.pinnedFailed;
  const missing = new Set(missingIn(list, [...all.pinnedOpen, ...failed]).map((e) => e.url));
  return missingIn(list.filter((e) => missing.has(e.url)), [...all.pinnedFirst, ...failed]);
}

// Beim Ersetzen übernimmt ein Workspace der Datei ein offenes Hauptfenster, statt dessen
// Tabs zu schließen und neu anzulegen, wenn alle Tabs darin zu ihm gehören und es mehr
// als die Hälfte seiner Tabs enthält. Die Tabs behalten so ihren Verlauf, etwa beim
// Umstieg auf die feste Erweiterungs-ID: Danach sind die alten Ablagen normale Fenster
// (#156). Neue Tab-Seiten zählen auf keiner Seite mit. Vergeben wird nach den meisten Treffern,
// jedes Fenster und jeder Workspace höchstens einmal. Ergebnis: Index in der Datei → Fenster.
function planAdopt(data, mains) {
  const pairs = [];
  for (const win of mains) {
    const have = movableTabsOf(win).filter((t) => !isNewTab(t)).map((t) => ({ url: urlOf(t) }));
    if (!have.length) continue;
    data.workspaces.forEach((imp, i) => {
      const want = imp.tabs.filter((e) => !isNewTab(e));
      if (have.length * 2 > want.length && !missingIn(have, want).length) pairs.push({ win, i, hits: have.length });
    });
  }
  pairs.sort((a, b) => b.hits - a.hits);
  const adopt = new Map();
  const taken = new Set();
  for (const p of pairs) {
    if (adopt.has(p.i) || taken.has(p.win.id)) continue;
    adopt.set(p.i, p.win);
    taken.add(p.win.id);
  }
  return adopt;
}

// Tabs, die beim Ersetzen in übernommenen Fenstern offen bleiben (zählt wie collectAll)
const keptIn = (adopt) => [...adopt.values()].reduce((n, w) => n + movableTabsOf(w).filter(urlOf).length, 0);

// Macht die übernommenen Fenster zu Fenstern der neuen Workspaces (ids wie data.workspaces).
// Ein minimiertes Fenster wird wieder zur Ablage, etwa eine alte Ablage nach dem Umstieg;
// ein sichtbares zeigt den Workspace. Fehlende Tabs aus der Datei kommen dazu, die über
// LOAD_AT_ONCE hinaus zurückgestellten nach und nach (#184).
async function adoptWindows(data, ids, adopt, stamp) {
  const s = await sess();
  let failed = 0;
  for (const [i, win] of adopt) {
    const id = ids[i];
    const imp = data.workspaces[i];
    delete s.prevWs[win.id];
    if (win.state === 'minimized') {
      delete s.windowWs[win.id];
      await saveSess(s);
      await moving(() => chrome.tabs.create({ windowId: win.id, url: `${STASH_PAGE}#${id}`, index: 0, pinned: true, active: true }));
    } else {
      s.windowWs[win.id] = id;
      await saveSess(s);
    }
    const add = missingIn(imp.tabs, movableTabsOf(win).map((t) => ({ url: urlOf(t) })));
    if (!add.length) continue;
    const r = await moving(() => recreate(importEntries(add, stamp, { from: imp.tabs, join: true }), win.id, false, true));
    await keepFailed(id, r.failed);
    await keepLater(id, r.later);
    failed += r.failed.length;
  }
  return failed;
}

// Prüft die Datei und beschreibt, was Zusammenführen bzw. Ersetzen ändern würde.
async function previewImport(text) {
  const data = parseExchange(text, chrome.runtime.getURL(''));
  await resumeSwitch();
  const all = await collectAll();
  const plan = planImport(data, all);
  const now = await getSettings();
  return {
    exported: data.exported,
    settings: Object.entries(data.settings).map(([key, value]) => ({ key, value, changed: now[key] !== value })),
    keep: keptIn(planAdopt(data, all.mains)),
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
// Die Einstellungen aus der Datei gelten bei beiden Arten.
async function importExchange(text, mode, confirmed) {
  const data = parseExchange(text, chrome.runtime.getURL(''));
  if (mode !== 'merge' && mode !== 'replace') throw new Error(tr('importModeUnknown'));
  if (mode === 'replace' && !confirmed) throw new Error(tr('importReplaceUnconfirmed'));
  await resumeSwitch();
  const all = await collectAll();
  const plan = planImport(data, all, mode);
  const stamp = `i${Date.now().toString(36)}`;
  const cfg = await getConfig();
  const { backup } = await getBackup();
  const taken = new Set(cfg.workspaces.map((w) => w.id));
  const res = { created: 0, merged: 0, added: 0, skipped: 0, failed: 0, removed: 0, closed: 0, settings: 0 };

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
    const adopt = planAdopt(data, all.mains);
    const ids = data.workspaces.map(addWs);
    await chrome.storage.local.set({ backup });
    await saveWorkspaces(cfg.workspaces);
    res.failed += await adoptWindows(data, ids, adopt, stamp);
    // Erst die übrigen Fenster zu einem neuen Workspace wechseln, den noch kein übernommenes
    // Fenster zeigt, dann die alten löschen. Ein minimiertes Fenster nur mit neuen
    // Tab-Seiten ist eine alte leere Ablage (Chromium ersetzt die Ablage-Seite der alten ID
    // dann durch eine neue Tab-Seite) und wird geschlossen.
    const shown = [...adopt].filter(([, w]) => w.state !== 'minimized').map(([i]) => ids[i]);
    const target = ids.find((id) => !shown.includes(id)) ?? ids[0];
    const taken = [...adopt.values()];
    for (const w of all.mains) {
      if (taken.includes(w)) continue;
      if (w.state === 'minimized' && w.tabs.every(isNewTab)) {
        const s = await sess();
        delete s.windowWs[w.id];
        delete s.prevWs[w.id];
        await saveSess(s);
        await chrome.windows.remove(w.id).catch(() => {});
      } else {
        await switchTo(w.id, target);
      }
    }
    // Alle alten Workspaces lassen sich gemeinsam zurückholen
    const deleted = [];
    for (const id of oldIds) await deleteWs(id, deleted);
    await chrome.storage.local.set({ lastWs: shown[0] ?? target });
    res.removed = oldIds.length;
    res.kept = keptIn(adopt);
    res.closed = all.list.reduce((n, x) => n + x.open, 0) - res.kept;
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
      await keepLater(m.target.ws.id, r.later);
      res.added += r.ids.length + r.later.length;
      res.failed += r.failed.length;
    }
  }
  const p = await addPinned(plan.pinnedAdd);
  res.pinned = p.added;
  res.failed += p.failed;
  res.pinnedSkipped = data.pinned.length - plan.pinnedAdd.length;
  res.settings = await applySettings(data.settings);
  await updateAllIcons();
  await snapshot();
  return res;
}
