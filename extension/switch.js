// Hintergrundlogik: Workspace wechseln, Tab in einen anderen Workspace verschieben

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
      const { stashedAt = {} } = await chrome.storage.session.get('stashedAt');
      await chrome.storage.session.set({ stashedAt: { ...stashedAt, [p.from]: Date.now() } });
      if (st.created) await chrome.windows.update(p.windowId, { focused: true }).catch(() => {});
    } else if (!p.oldTabs.length) {
      await clearBackup(p.from);
    }

    s.windowWs[p.windowId] = p.to;
    s.prevWs[p.windowId] = p.from;
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

// Workspace an Stelle i der Liste (Tastenkürzel 1–9)
async function switchToIndex(windowId, i) {
  const ws = (await getConfig()).workspaces[i];
  if (ws) await switchTo(windowId, ws.id);
}

// Zurück zum Workspace, den das Fenster vor dem jetzigen zeigte (wie Alt+Tab)
async function switchToLast(windowId) {
  const prev = (await sess()).prevWs[windowId];
  if (prev) await switchTo(windowId, prev);
}

// ---------------------------------------------------------------- Tab verschieben

// Verschiebt den Tab und alle mit ihm markierten Tabs (Strg/Shift), mit group seine
// ganze Tab-Gruppe. Gruppen, die vollständig mitgehen, bleiben samt Titel und Farbe
// erhalten; einzelne mitgenommene Tabs einer Gruppe verlassen sie.
async function moveTabToWs(tabId, wsId, group = false) {
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
  const picked = (t) =>
    t.id === tabId || (group && tab.groupId >= 0 ? t.groupId === tab.groupId : tab.highlighted && t.highlighted);
  const ids = new Set(main.tabs.filter(picked).map((t) => t.id));

  await moving(async () => {
    // Fenster darf nicht leer werden
    const left = main.tabs.filter((t) => !ids.has(t.id));
    const movesUnpinned = main.tabs.some((t) => ids.has(t.id) && !t.pinned);
    if (!left.length || (movesUnpinned && !left.some((t) => !t.pinned))) {
      await chrome.tabs.create({ windowId: tab.windowId, active: true });
    }
    // Von rechts nach links lösen: Ein gelöster Tab rückt hinter die angehefteten, so
    // behalten mehrere ihre Reihenfolge
    for (const t of [...main.tabs].reverse()) if (ids.has(t.id) && t.pinned) await chrome.tabs.update(t.id, { pinned: false });

    // Nach dem Lösen haben sich die Positionen verschoben, deshalb frisch lesen
    const all = await chrome.tabs.query({ windowId: tab.windowId });
    // Ein einzeln verschobener Tab verlässt seine Gruppe, auch wenn er ihr letzter ist
    const whole = (gid) => gid >= 0 && (group || ids.size > 1) && all.every((t) => t.groupId !== gid || ids.has(t.id));
    const list = all.filter((t) => ids.has(t.id)).map((t) => ({ ...t, groupId: whole(t.groupId) ? t.groupId : -1 }));

    const shownIn = mains.find((w) => s.windowWs[w.id] === wsId);
    if (shownIn) {
      await moveOrdered(list, shownIn.id);
    } else {
      const st = await ensureStash(wsId, true);
      await moveOrdered(list, st.windowId);
      await chrome.tabs.update(st.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  });
  const s2 = await sess();
  for (const id of ids) delete s2.tabOrigin[id];
  await saveSess(s2);
  for (const id of ids) await setTabIcon(id, wsId);
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
  await syncMute();
}
