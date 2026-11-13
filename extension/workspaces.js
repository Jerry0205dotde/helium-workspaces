// Hintergrundlogik: Workspaces anlegen, ändern, sortieren und löschen

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
  // Nur ein schon geschlossenes Fenster gilt als Erfolg. Bliebe die Ablage offen, holte
  // der nächste Abgleich sie als Workspace „Wiederhergestellt“ zurück.
  if (w) {
    await whenIdle(() => chrome.windows.remove(w.id)).catch((err) => {
      if (!GONE.test(err?.message || '')) throw err;
    });
  }

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
