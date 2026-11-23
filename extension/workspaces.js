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
// nächsten Löschen, bis „Rückgängig“ oder bis zum Browserstart. Beim Ersetzen per Import
// sammelt batch alle gelöschten Workspaces, damit sich der ganze Vorgang zurücknehmen lässt.
async function deleteWs(id, batch = []) {
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
  const { backup } = await getBackup();
  // Die Sicherung kann der Ablage bis zu zwei Sekunden hinterherhinken: ihren Stand vor dem
  // Schließen sichern. Nicht wiederhergestellte Einträge bleiben dabei erhalten.
  if (w) {
    const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
    const { failed, later } = backup[id] || {};
    const stash = stashTabsOf(w).map((t) => serTab(t, groups));
    backup[id] = { stash, shown: [], ...(failed?.length ? { failed } : {}), ...(later?.length ? { later: relink(later, stash) } : {}) };
    await chrome.storage.local.set({ backup });
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
    } finally {
      await chrome.storage.local.remove('pendingDelete');
    }
  }

  batch.push({ ws: cfg.workspaces[idx], index: idx, backup: backup[id] || { stash: [], shown: [] } });
  await chrome.storage.local.set({ deleted: batch });
  cfg.workspaces.splice(idx, 1);
  await saveWorkspaces(cfg.workspaces);
  delete backup[id];
  await chrome.storage.local.set({ backup });
  if (cfg.lastWs === id) await chrome.storage.local.set({ lastWs: fallback });
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
  await chrome.storage.local.set({ backup });
  await saveWorkspaces(cfg.workspaces);
  await chrome.storage.local.remove('deleted');
  return first;
}

async function clearBackup(wsId) {
  const { backup } = await getBackup();
  // Fehlgeschlagene Einträge waren nie in einem Fenster und bleiben für einen erneuten
  // Versuch. Zurückgestellte gehen mit den Tabs, hinter denen sie angelegt worden wären.
  const failed = backup[wsId]?.failed;
  backup[wsId] = { stash: [], shown: [], ...(failed?.length ? { failed } : {}) };
  await chrome.storage.local.set({ backup });
}
