// Hintergrundlogik: Workspaces anlegen, ändern, sortieren und löschen

async function createWs(name) {
  const cfg = await getConfig();
  const used = new Set(cfg.workspaces.map((w) => w.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[cfg.workspaces.length % COLORS.length];
  const ws = { id: newId(), name: name || tr('workspaceN', cfg.workspaces.length + 1), color, emoji: '' };
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
    const failed = backup[id]?.failed;
    backup[id] = { stash: stashTabsOf(w).map((t) => serTab(t, groups)), shown: [], ...(failed?.length ? { failed } : {}) };
    await chrome.storage.local.set({ backup });
    // Nur ein schon geschlossenes Fenster gilt als Erfolg. Bliebe die Ablage offen, holte
    // der nächste Abgleich sie als Workspace „Wiederhergestellt“ zurück.
    await whenIdle(() => chrome.windows.remove(w.id)).catch((err) => {
      if (!GONE.test(err?.message || '')) throw err;
    });
  }

  batch.push({ ws: cfg.workspaces[idx], index: idx, backup: backup[id] || { stash: [], shown: [] } });
  await chrome.storage.local.set({ deleted: batch });
  cfg.workspaces.splice(idx, 1);
  await saveWorkspaces(cfg.workspaces);
  delete backup[id];
  await chrome.storage.local.set({ backup });
  if (cfg.lastWs === id) await chrome.storage.local.set({ lastWs: fallback });
}

// Holt die zuletzt gelöschten Workspaces an ihren alten Platz zurück. Ihre Tabs stehen in
// der Sicherung und öffnen sich beim Wechseln dorthin. Ergibt die ID des ersten.
async function undoDelete() {
  const { deleted } = await chrome.storage.local.get('deleted');
  if (!deleted?.length) return null;
  const cfg = await getConfig();
  const { backup } = await getBackup();
  let first = null;
  // Rückwärts: Jeder Eintrag kennt seinen Platz in der Liste, wie sie vor ihm aussah.
  // Gibt es den Workspace noch (Löschen abgebrochen), bleibt er, wie er ist.
  for (const d of [...deleted].reverse()) {
    if (cfg.workspaces.some((w) => w.id === d.ws.id)) continue;
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
  // Fehlgeschlagene Einträge waren nie in einem Fenster und bleiben für einen erneuten Versuch
  const failed = backup[wsId]?.failed;
  backup[wsId] = { stash: [], shown: [], ...(failed?.length ? { failed } : {}) };
  await chrome.storage.local.set({ backup });
}
