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
//
// Die Logik steht in den Dateien unten, hier nur Ereignisse, Nachrichten und Start.
// importScripts führt sie als klassische Skripte aus: Sie teilen sich einen globalen
// Gültigkeitsbereich, und bevor das erste Ereignis kommt, sind alle geladen.

importScripts(
  'i18n.js',
  'label.js',
  'exchange.js',
  'core.js',
  'unload.js',
  'restore.js',
  'switch.js',
  'workspaces.js',
  'backup.js',
  'reconcile.js',
  'export-import.js',
  'autobackup.js',
  'icons.js',
  'sound.js',
  'menus.js',
);

// ---------------------------------------------------------------- Ereignisse

chrome.windows.onCreated.addListener(() => scheduleReconcile(), { windowTypes: ['normal'] });
chrome.windows.onRemoved.addListener((id) => serial(() => onWindowRemoved(id)), { windowTypes: ['normal'] });

// Beim Beenden kommen noch Fokuswechsel (etwa vom Download-Hinweis der automatischen
// Sicherung), deren Speichern dann scheitert. Das ist harmlos.
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const s = await sess();
    const ws = s.windowWs[winId];
    if (!ws) return;
    await chrome.storage.local.set({ lastWs: ws });
    await chrome.storage.session.set({ lastMain: winId });
  } catch (e) {
    console.warn('[workspaces] Fokuswechsel nicht gespeichert', e);
  }
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
  scheduleSnapshot();
  const s = await sess();
  if (s.windowWs[newWindowId]) await setTabIcon(tabId, s.windowWs[newWindowId]);
  else await scheduleMute();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (switching) return;
  scheduleSnapshot();
  const s = await sess();
  if (s.windowWs[tab.windowId]) await setTabIcon(tab.id, s.windowWs[tab.windowId]);
  else await scheduleMute();
  // Wiederhergestellte Tabs ohne neues Fenster: dropStartCopies prüfen
  if ((await chrome.storage.session.get('startCopies')).startCopies) scheduleReconcile();
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) {
    if (!isClosing(info.windowId)) closing.set(info.windowId, Date.now());
    return;
  }
  scheduleReconcile(); // falls eine Ablage-Seite geschlossen wurde
  scheduleSnapshot();
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url || info.pinned !== undefined || info.groupId !== undefined) scheduleSnapshot();
  if (info.status === 'complete' && (await unloadLaterTake(tabId))) serial(() => unloadRestored(tabId));
  // Chromium setzt Symbol, Titel und Plakette eines Tabs beim Laden einer Seite zurück
  if (info.status === 'complete') {
    const ws = (await sess()).windowWs[tab.windowId];
    if (ws) await setTabIcon(tabId, ws);
  }
});
chrome.tabs.onMoved.addListener(() => scheduleSnapshot());
chrome.tabs.onReplaced.addListener((added, removed) => {
  serial(() => replaceTabId(removed, added));
  scheduleSnapshot(); // stashWins kennt sonst die alte ID
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'unload') serial(unloadStashes);
  if (a.name === 'autoBackup') userAction(() => autoBackupIfDue());
});
chrome.tabGroups.onUpdated.addListener(() => scheduleSnapshot());

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  let windowId = tab?.windowId;
  if (!windowId) windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  if (cmd === 'next-workspace') userAction(() => switchRelative(windowId, 1));
  if (cmd === 'prev-workspace') userAction(() => switchRelative(windowId, -1));
  if (cmd === 'last-workspace') userAction(() => switchToLast(windowId));
  const nr = /^switch-([1-9])$/.exec(cmd);
  if (nr) userAction(() => switchToIndex(windowId, nr[1] - 1));
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
    const audible = audibleOf(ws.id, s, stash, mains).length;
    return { ...ws, count, failed, audible, elsewhere: showing.some((w) => w.id !== windowId) };
  });
  const { backupError } = await chrome.storage.session.get('backupError');
  const { muteStash, deleted } = await chrome.storage.local.get(['muteStash', 'deleted']);
  return {
    workspaces: list,
    // Zuletzt gelöscht, für „Rückgängig“
    deleted: deleted?.length ? deleted.map((d) => d.ws.name) : null,
    current: s.windowWs[windowId] || null,
    colors: COLORS,
    backupError: backupError || null,
    storage: await sessionUsage(),
    muteStash: !!muteStash,
    unloadAfter: await getUnloadAfter(),
    unloadChoices: UNLOAD_CHOICES,
    autoBackupError: (await autoBackupState()).error,
  };
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
      case 'undoDelete':
        return userAction(undoDelete);
      case 'forgetDeleted':
        return serial(() => chrome.storage.local.remove('deleted'));
      case 'moveTab':
        return userAction(() => moveTabToWs(msg.tabId, msg.wsId));
      case 'retry':
        return userAction(() => retryFailed(msg.windowId, msg.wsId));
      case 'dismiss':
        return userAction(() => dismissFailed(msg.wsId));
      case 'mute':
        return userAction(() => muteWs(msg.wsId));
      case 'muteStash':
        return userAction(() => chrome.storage.local.set({ muteStash: !!msg.on }));
      case 'unloadAfter':
        return serial(() => setUnloadAfter(msg.minutes));
      case 'autoBackupState':
        return autoBackupState();
      case 'autoBackup': {
        // Die Exportseite nennt gleich die erste Datei
        const r = await userAction(() => setAutoBackup(msg.days));
        await r?.done;
        return autoBackupState();
      }
      case 'export':
        return userAction(exportAll);
      case 'importPreview':
        return userAction(() => previewImport(msg.text));
      case 'import':
        return userAction(async () => {
          try {
            return await importExchange(msg.text, msg.mode, msg.confirmed);
          } finally {
            // Beim Ersetzen holt das Wechseln der Hauptfenster eines davon nach vorn.
            // Die Importseite bekommt den Fokus zurück, sonst bleibt ihre Meldung verdeckt.
            if (sender.tab) await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {});
          }
        });
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
    // Fenster- und Tab-IDs gelten nur innerhalb einer Browsersitzung. Gelöschte
    // Workspaces lassen sich nur bis zum nächsten Browserstart zurückholen.
    await chrome.storage.local.remove(['stashWins', 'stashMuted', 'deleted']);
    const { backupWindows } = await chrome.storage.local.get('backupWindows');
    if (backupWindows) await chrome.storage.local.set({ backupWindows: backupWindows.map(({ id, ...e }) => e) });
    await buildMenus();
  }),
);
// Bei jedem Start, damit auch eine ältere Installation ohne Neuladen ihren Schlüssel bekommt
serial(ensureToken);
serial(scheduleUnload);
serial(scheduleAutoBackup);
scheduleReconcile();
