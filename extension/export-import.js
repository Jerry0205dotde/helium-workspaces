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

// Ordnet jeder Gruppe der Datei die Gruppe im Fenster zu, die die meisten ihrer Adressen
// enthält, bei Gleichstand die mit gleichem Titel und gleicher Farbe, dann gleichem Einklappen
// (groups: ID → Gruppe), jede höchstens einmal. Ergebnis: Gruppenschlüssel der Datei → Gruppen-ID.
function matchGroups(entries, tabs, groups) {
  const want = new Map();
  const have = new Map();
  for (const e of entries) if (e.g) want.set(e.g, [...(want.get(e.g) || []), e]);
  for (const t of tabs) if (t.groupId >= 0) have.set(t.groupId, [...(have.get(t.groupId) || []), { url: urlOf(t) }]);
  const pairs = [];
  const same = (e, g) => {
    const p = groupProps(e);
    return g ? (g.title === p.title && g.color === p.color ? 2 : 0) + (g.collapsed === p.collapsed ? 1 : 0) : 0;
  };
  for (const [g, list] of want) {
    for (const [id, live] of have) pairs.push({ g, id, hits: list.length - missingIn(list, live).length, same: same(list[0], groups.get(id)) });
  }
  pairs.sort((a, b) => b.hits - a.hits || b.same - a.same);
  const out = new Map();
  const taken = new Set();
  for (const p of pairs) {
    if (!p.hits || out.has(p.g) || taken.has(p.id)) continue;
    out.set(p.g, p.id);
    taken.add(p.id);
  }
  return out;
}

// Ordnet die Einträge der Datei den offenen Tabs zu, jeden Tab höchstens einmal: zuerst nach
// URL in der zugeordneten Gruppe (matchGroups, ohne Gruppe ebenso), damit gleiche Adressen in
// verschiedenen Gruppen ihren Tab behalten, dann nur nach URL. Ergebnis: je Eintrag der Tab oder null.
function matchTabs(entries, tabs, groups) {
  const to = matchGroups(entries, tabs, groups);
  const passes = [
    [(e) => JSON.stringify([e.url, e.g ? to.get(e.g) ?? null : -1]), (t) => JSON.stringify([urlOf(t), t.groupId])],
    [(e) => e.url, urlOf],
  ];
  const match = entries.map(() => null);
  const used = new Set();
  for (const [keyOf, tabKey] of passes) {
    const free = new Map();
    for (const t of tabs) {
      if (used.has(t)) continue;
      const k = tabKey(t);
      if (!free.has(k)) free.set(k, []);
      free.get(k).push(t);
    }
    entries.forEach((e, i) => {
      const t = !match[i] && free.get(keyOf(e))?.shift();
      if (t) {
        match[i] = t;
        used.add(t);
      }
    });
  }
  return match;
}

// Liegen die Tabs (tabs[k] zu entries[k]) schon in der Reihenfolge und den Gruppen der
// Datei? Titel, Farbe und Einklappen dürfen abweichen. all: alle Tabs des Fensters.
function sameLayout(entries, tabs, all) {
  const key = new Map(); // Gruppe der Datei → Gruppe im Fenster
  const seen = new Set();
  for (const [k, t] of tabs.entries()) {
    const e = entries[k];
    if ((k && t.index < tabs[k - 1].index) || !e.g !== t.groupId < 0) return false;
    if (!e.g) continue;
    if (!key.has(e.g)) {
      if (seen.has(t.groupId)) return false;
      key.set(e.g, t.groupId);
      seen.add(t.groupId);
    }
    if (key.get(e.g) !== t.groupId) return false;
  }
  return all.every((t) => !seen.has(t.groupId) || tabs.includes(t));
}

// Bringt die offenen Tabs eines übernommenen Fensters in Reihenfolge und Gruppen der Datei,
// ohne einen Tab neu anzulegen (#230, #231). Stimmen sie schon, bekommen nur die Gruppen
// Titel, Farbe und Einklappen aus der Datei. Sonst werden die Gruppen aufgehoben (Chromium
// behält sie dann nicht als gespeicherte Gruppen, #218), die Tabs der Reihe nach hinter die
// angehefteten gestellt und je Gruppe der Datei neu zusammengefasst. Es gilt der aktuelle
// Stand des Fensters, scheitert die Abfrage, der aus scan (win). Gibt die Einträge zurück,
// für die kein Tab offen ist.
async function arrangeAdopted(entries, win) {
  const windowId = win.id;
  const all = movableTabsOf({ tabs: (await chrome.tabs.query({ windowId }).catch(() => null)) || win.tabs });
  const groups = new Map((await chrome.tabGroups.query({ windowId }).catch(() => [])).map((g) => [g.id, g]));
  const match = matchTabs(entries, all, groups);
  const pairs = entries.map((e, i) => ({ e, t: match[i] })).filter((p) => p.t);
  const warn = (err) => console.warn('[workspaces] übernommenes Fenster nicht angeordnet', err);
  if (sameLayout(pairs.map((p) => p.e), pairs.map((p) => p.t), all)) {
    const done = new Set();
    for (const { e, t } of pairs) {
      if (!e.g || done.has(t.groupId)) continue;
      done.add(t.groupId);
      const want = groupProps(e);
      const g = groups.get(t.groupId);
      if (!g || Object.keys(want).some((k) => g[k] !== want[k])) await whenIdle(() => chrome.tabGroups.update(t.groupId, want)).catch(warn);
    }
  } else {
    // Scheitert das Umsortieren, entstehen die Gruppen der Datei trotzdem
    try {
      const grouped = all.filter((t) => t.groupId >= 0).map((t) => t.id);
      if (grouped.length) await whenIdle(() => chrome.tabs.ungroup(grouped));
      if (pairs.length) await whenIdle(() => chrome.tabs.move(pairs.map((p) => p.t.id), { index: all[0]?.index ?? 0 }));
    } catch (err) {
      warn(err);
    }
    const byKey = new Map();
    for (const p of pairs) if (p.e.g) byKey.set(p.e.g, [...(byKey.get(p.e.g) || []), p]);
    for (const members of byKey.values()) await groupEntry(members.map((m) => m.t.id), windowId, members[0].e).catch(warn);
  }
  return entries.filter((e, i) => !match[i]);
}

// Macht die übernommenen Fenster zu Fenstern der neuen Workspaces (ids wie data.workspaces).
// Ein minimiertes Fenster wird wieder zur Ablage, etwa eine alte Ablage nach dem Umstieg;
// ein sichtbares zeigt den Workspace. Die offenen Tabs bekommen Reihenfolge und Gruppen der
// Datei (arrangeAdopted). Fehlende Tabs kommen hinten dazu, gruppierte in ihre Gruppe, die
// über LOAD_AT_ONCE hinaus zurückgestellten nach und nach (#184).
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
    const add = await moving(() => arrangeAdopted(imp.tabs, win));
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
