// Hintergrundlogik: Export und Import (Dateiformat in exchange.js)

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
  // Angeheftete Tabs aller Hauptfenster; was ein früheres Fenster schon hat, zählt einmal.
  // So rechnet der Import: addPinned ergänzt nur im ersten Fenster.
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
  const pinnedFailed = list.flatMap((x) => x.pinnedFailed).filter((e) => e.url);
  const pinned = [...pinnedOpen, ...pinnedFailed];
  // Der Export zählt wie die Sicherung, damit ein Rundlauf den Bestand bewahrt
  const exported = [...(mains.length ? pinnedOf(mains, groups) : backupPinned).filter((e) => e.url), ...pinnedFailed];
  return { cfg, mains, list, pinned, pinnedOpen, exported };
}

async function exportAll() {
  await resumeSwitch();
  const { list, exported } = await collectAll();
  return buildExchange(list, exported, chrome.runtime.getURL(''));
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
  if (mode !== 'merge' && mode !== 'replace') throw new Error(tr('importModeUnknown'));
  if (mode === 'replace' && !confirmed) throw new Error(tr('importReplaceUnconfirmed'));
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
