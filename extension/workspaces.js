// Hintergrundlogik: Workspaces anlegen, ändern, sortieren und löschen

async function createWs(name) {
  await resumeSwitch();
  const all = await collectAll();
  const { cfg } = all;
  const taken = new Set(cfg.workspaces.map((w) => w.id));
  let id = newId();
  while (taken.has(id)) id = newId();
  const used = new Set(cfg.workspaces.map((w) => w.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[cfg.workspaces.length % COLORS.length];
  const ws = { id, name: wsName(name || tr('workspaceN', cfg.workspaces.length + 1)), color, emoji: '' };
  const err = exchangeLimitError(
    buildExchange([...all.list, { ws, entries: [] }], all.pinned, chrome.runtime.getURL(''), await getSettings()),
  );
  if (err) throw new Error(err);
  cfg.workspaces.push(ws);
  await saveWorkspaces(cfg.workspaces);
  return ws;
}

async function updateWs(id, patch) {
  if (!patch || typeof patch !== 'object') return;
  const cfg = await getConfig();
  const ws = cfg.workspaces.find((w) => w.id === id);
  if (!ws) return;
  if (typeof patch.name === 'string') ws.name = patch.name;
  if (typeof patch.color === 'string' && HEX_COLOR.test(patch.color)) ws.color = patch.color;
  if (typeof patch.emoji === 'string') ws.emoji = patch.emoji;
  ws.name = wsName(ws.name);
  await saveWorkspaces(cfg.workspaces);
  iconCache.clear();
  await updateAllIcons();
}

async function reorderWs(ids) {
  if (!Array.isArray(ids)) return;
  const cfg = await getConfig();
  const byId = new Map(cfg.workspaces.map((w) => [w.id, w]));
  const next = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
  for (const w of cfg.workspaces) if (!next.includes(w)) next.push(w);
  await saveWorkspaces(next);
}

// Ein gelöschter Workspace bleibt samt seinen Tabs in 'deleted' (storage.local), bis zum
// nächsten Löschen, bis „Rückgängig“ oder bis zum Browserstart.
async function deleteWs(id) {
  await deleteWorkspaces([id]);
}

// Löscht mehrere Workspaces in einem Zug, beim Ersetzen per Import alle alten: 'deleted' sammelt
// sie, damit sich der ganze Vorgang zurücknehmen lässt. Sicherung, Liste und Menüs werden nur
// einmal geschrieben, nicht für jeden Workspace (#303). Einer bleibt immer übrig.
async function deleteWorkspaces(ids) {
  await resumeSwitch();
  const cfg = await getConfig();
  const gone = new Set();
  for (const id of ids) {
    if (cfg.workspaces.length - gone.size < 2) break;
    if (cfg.workspaces.some((w) => w.id === id)) gone.add(id);
  }
  if (!gone.size) return;
  // Der nächste davor, der bleibt, sonst der erste danach
  const fallbackOf = (id) => {
    const idx = cfg.workspaces.findIndex((w) => w.id === id);
    const keep = (w) => !gone.has(w.id);
    return (cfg.workspaces.slice(0, idx).findLast(keep) || cfg.workspaces.slice(idx).find(keep)).id;
  };

  // Fenster, die einen davon zeigen, vorher wegwechseln
  const s = await sess();
  for (const [winId, ws] of Object.entries(s.windowWs)) {
    if (gone.has(ws)) await switchTo(Number(winId), fallbackOf(ws));
  }
  const { stash } = await scan();
  const { backup } = await getBackup();
  // Die Sicherung kann den Ablagen bis zu zwei Sekunden hinterherhinken: ihren Stand vor dem
  // Schließen sichern. Nicht wiederhergestellte Einträge bleiben dabei erhalten.
  const wins = [...gone].map((id) => [id, stash.get(id)]).filter(([, w]) => w);
  if (wins.length) {
    const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    for (const [id, w] of wins) {
      const { failed, later } = backup[id] || {};
      const tabs = stashTabsOf(w).map((t) => serTab(t, groups));
      backup[id] = { stash: tabs, shown: [], ...(failed?.length ? { failed } : {}), ...(later?.length ? { later: relink(later, tabs) } : {}) };
    }
    await setLocal({ backup });
  }
  // Scheitert eine Ablage, bleiben ihr Workspace und die noch nicht geschlossenen bestehen
  const done = [...gone].filter((id) => !stash.has(id));
  let error;
  for (const [id, w] of wins) {
    // Bis die Ablage geschlossen ist, stehen ihre Gruppen in 'pendingDelete'. Bricht das
    // Löschen dazwischen ab, legt resumeDelete sie wieder an (#271).
    const regroup = await ungroupAll(w, (groups) => chrome.storage.local.set({ pendingDelete: { windowId: w.id, groups } }));
    try {
      // Nur ein schon geschlossenes Fenster gilt als Erfolg. Bliebe die Ablage offen, holte
      // der nächste Abgleich sie als Workspace „Wiederhergestellt“ zurück.
      await whenIdle(() => chrome.windows.remove(w.id)).catch(async (err) => {
        if (GONE.test(err?.message || '')) return;
        await regroup();
        throw err;
      });
      done.push(id);
    } catch (err) {
      error = err;
      break;
    } finally {
      await chrome.storage.local.remove('pendingDelete');
    }
  }

  if (done.length) {
    // In der ursprünglichen Reihenfolge, jeder mit seinem Platz in der Liste, wie sie vor ihm aussah
    const deleted = [];
    const workspaces = [...cfg.workspaces];
    for (const ws of cfg.workspaces.filter((w) => done.includes(w.id))) {
      const index = workspaces.indexOf(ws);
      deleted.push({ ws, index, backup: backup[ws.id] || { stash: [], shown: [] } });
      workspaces.splice(index, 1);
      delete backup[ws.id];
    }
    const lastWs = done.includes(cfg.lastWs) ? { lastWs: fallbackOf(cfg.lastWs) } : {};
    await setLocal({ deleted, workspaces, backup, ...lastWs });
    await buildMenus();
  }
  if (error) throw error;
}

// Wurde das Löschen nach dem Aufheben der Gruppen abgebrochen und steht die Ablage noch,
// bekommt sie ihre Gruppen zurück. Der Workspace bleibt dann, wie er war.
async function resumeDelete() {
  const { pendingDelete: p } = await chrome.storage.local.get('pendingDelete');
  if (!p) return false;
  const w = (await chrome.windows.getAll({ populate: true })).find((x) => x.id === p.windowId);
  if (w) {
    console.info('[workspaces] lege Gruppen nach abgebrochenem Löschen wieder an');
    const here = new Set(w.tabs.map((t) => t.id));
    await regroup(w.id, p.groups.map((g) => ({ ...g, tabIds: g.tabIds.filter((id) => here.has(id)) })));
  }
  await chrome.storage.local.remove('pendingDelete');
  // Solange der Vermerk stand, hat snapshot() nichts gesichert: Der Abgleich holt es nach
  return true;
}

// Holt die zuletzt gelöschten Workspaces an ihren alten Platz zurück. Ihre Tabs stehen in
// der Sicherung und öffnen sich beim Wechseln dorthin. Ergibt die ID des ersten.
async function undoDelete() {
  const { deleted } = await chrome.storage.local.get('deleted');
  if (!deleted?.length) return null;
  await resumeSwitch();
  const all = await collectAll();
  const { cfg } = all;
  const { backup } = await getBackup();
  const adding = [...deleted].reverse().filter((d) => !cfg.workspaces.some((w) => w.id === d.ws.id));
  if (adding.length) {
    const list = [...all.list];
    const pinnedFailed = [];
    for (const d of adding) {
      const b = d.backup || {};
      const failed = b.failed || [];
      const entries = [...tagGroups(savedOf(b), 'a'), ...tagGroups(failed.filter((e) => !e.p), 'f')];
      list.splice(Math.min(d.index, list.length), 0, { ws: d.ws, entries });
      pinnedFailed.push(...failed.filter((e) => e.p && e.url));
    }
    const err = exchangeLimitError(
      buildExchange(list, [...all.pinned, ...pinnedFailed], chrome.runtime.getURL(''), await getSettings()),
    );
    if (err) throw new Error(err);
  }
  let first = null;
  // Rückwärts: Jeder Eintrag kennt seinen Platz in der Liste, wie sie vor ihm aussah.
  // Gibt es den Workspace noch (Löschen abgebrochen), bleibt er, wie er ist.
  for (const d of adding) {
    cfg.workspaces.splice(Math.min(d.index, cfg.workspaces.length), 0, d.ws);
    backup[d.ws.id] = d.backup;
    first = d.ws.id;
  }
  await setLocal({ backup });
  await saveWorkspaces(cfg.workspaces);
  await chrome.storage.local.remove('deleted');
  return first;
}

async function clearBackup(wsId, keepLater = false) {
  const { backup } = await getBackup();
  // Fehlgeschlagene Einträge waren nie in einem Fenster und bleiben für einen erneuten
  // Versuch. Zurückgestellte gehen mit den Tabs, hinter denen sie angelegt worden wären.
  // Mit keepLater bleiben sie: Dort ist nicht zu erkennen, ob es die Tabs davor je gab.
  const { failed, later } = backup[wsId] || {};
  backup[wsId] = { stash: [], shown: [], ...(failed?.length ? { failed } : {}), ...(keepLater && later?.length ? { later } : {}) };
  await setLocal({ backup });
}
