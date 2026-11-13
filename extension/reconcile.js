// Hintergrundlogik: Abgleich von Fenstern und Workspaces, etwa nach einem Neustart

// Ordnet neue Hauptfenster einem Workspace zu. entries sind die beim letzten Mal
// gesicherten Fenster (ID, Workspace und URLs) und in dieser Sitzung geschlossene Fenster
// (closed: true); jeder Eintrag wird höchstens einmal vergeben.
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
  // 3. Beim Browserstart oder mit Strg+Shift+T wiederhergestellte Fenster: über die URLs.
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
      let hits = 0;
      for (const u of urls) {
        if (left.get(u) > 0) {
          left.set(u, left.get(u) - 1);
          score += 1 / df.get(u);
          hits++;
        }
      }
      // Ein geschlossenes Fenster gilt erst, wenn die meisten Tabs beider Seiten passen,
      // damit z. B. ein in einem neuen Fenster geöffneter Link nicht in dessen Workspace landet.
      if (e.closed && hits * 2 <= Math.max(urls.length, e.urls.length)) continue;
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

  // Beim Start ohne Sitzungswiederherstellung legt Chromium die angehefteten Tabs aller
  // Fenster zusammen in ein neues Fenster, auch die Ablage-Seiten. Ein Fenster mit mehreren
  // Ablage-Seiten oder mit angehefteten Tabs ist deshalb keine Ablage, die übrigen Tabs der
  // Ablagen fehlen darin. Ohne die Ablage-Seiten ist es das Startfenster; die Workspaces
  // kommen aus der Sicherung. War ein Tab in mehreren Hauptfenstern angeheftet, steht er
  // darin mehrfach: Er bleibt so oft, wie ihn die Sicherung kennt, mindestens einmal.
  if (starting) {
    let merged = false;
    for (const w of [...stash.values(), ...dups]) {
      const marks = w.tabs.filter(isStashTab);
      const pins = w.tabs.filter((t) => t.pinned && !isStashTab(t));
      if (marks.length < 2 && !pins.length) continue;
      const keep = new Map();
      for (const e of (await getBackup()).backupPinned) keep.set(e.url, (keep.get(e.url) || 0) + 1);
      const seen = new Map();
      const extra = pins.filter((t) => {
        const n = (seen.get(urlOf(t)) || 0) + 1;
        seen.set(urlOf(t), n);
        return n > Math.max(keep.get(urlOf(t)) || 0, 1);
      });
      await moving(async () => {
        if (marks.length === w.tabs.length) await chrome.tabs.create({ windowId: w.id });
        await chrome.tabs.remove([...marks, ...extra].map((t) => t.id));
      });
      merged = true;
    }
    if (merged) {
      ({ stash, mains, dups } = await scan());
      changed = true;
    }
  }

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
      cfg.workspaces.push({ id: wsId, name: tr('recoveredWorkspace'), color: '#64748b', emoji: '' });
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
  for (const id of Object.keys(s.prevWs)) {
    if (!mains.some((w) => String(w.id) === id)) delete s.prevWs[id];
  }
  if (!starting) entries = [];
  const fresh = mains.filter((w) => !s.windowWs[w.id]);
  const guessed = new Set();
  let { closed = [] } = await chrome.storage.session.get('closed');
  if (fresh.length) {
    const pool = [...entries, ...closed];
    for (const [id, ws] of assignWindows(fresh, s, cfg, pool, guessed)) s.windowWs[id] = ws;
    entries = pool.filter((e) => !e.closed);
    closed = pool.filter((e) => e.closed);
    changed = true;
  }
  // Ein neues Fenster (Strg+N) hat den Fokus bekommen, bevor es zugeordnet war
  const focused = fresh.find((w) => w.focused);
  await chrome.storage.session.set({ entries, entriesUntil, closed, ...(focused ? { lastMain: focused.id } : {}) });

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
  // Hat Chromium die Sitzung nachträglich wiederhergestellt, enthält die Sicherung womöglich
  // schon die doppelten Tabs. repairFromBackup würde die geschlossenen Kopien dann als
  // verloren ergänzen; der Snapshot am Ende bringt sie auf den Stand.
  if (await dropStartCopies(s, stash)) changed = true;
  else if (starting && (await moving(() => repairFromBackup(cfg, s, stash, mains)))) changed = true;
  s.tabOrigin = {};
  await saveSess(s);

  await updateAllIcons();
  if (changed) await snapshot();
  await syncMute();
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
    // Für dropStartCopies: die angelegten Kopien und alle Tabs, die es jetzt schon gibt
    const copies = [...p.ids, ...ids];
    const all = await chrome.tabs.query({});
    await chrome.storage.session.set({
      startCopies: all.filter((t) => copies.includes(t.id)).map((t) => ({ id: t.id, url: urlOf(t) })),
      startSeen: all.map((t) => t.id),
    });
  });
  console.info('[workspaces] Workspace nach dem Start aus der Sicherung aufgebaut');
  return true;
}

// Nach einem Absturz startet Chromium mit neuer Tab-Seite und bietet „Wiederherstellen“
// an. restoreStart hat den Workspace dann schon aus der Sicherung aufgebaut; ein Klick
// darauf holt dieselben Tabs noch einmal (die des ersten Fensters hängt Chromium an das
// vorhandene Fenster an). Sind alle noch unveränderten Kopien danach im selben Workspace
// ein weiteres Mal offen, werden die Kopien geschlossen; Chromiums Tabs behalten ihren
// Verlauf. Landen sie in einem anderen Workspace (vorher gewechselt), bleiben die Kopien.
async function dropStartCopies(s, stash) {
  const { startCopies, startSeen } = await chrome.storage.session.get(['startCopies', 'startSeen']);
  if (!startCopies) return false;
  const tabs = await chrome.tabs.query({});
  const wsOf = (t) => s.windowWs[t.windowId] || [...stash].find(([, w]) => w.id === t.windowId)?.[0];
  const key = (t) => `${wsOf(t)} ${urlOf(t)}`;
  const live = startCopies.filter((c) => tabs.some((t) => t.id === c.id && urlOf(t) === c.url));
  const seen = new Set(startSeen);
  const have = tabs.filter((t) => !seen.has(t.id)).map((t) => ({ url: key(t) }));
  const want = live.map((c) => ({ url: key(tabs.find((t) => t.id === c.id)) }));
  if (live.length && missingIn(want, have).length) return false; // noch nicht (alle) wiederhergestellt
  await chrome.storage.session.remove(['startCopies', 'startSeen']);
  if (!live.length) return false;
  await moving(() => chrome.tabs.remove(live.map((c) => c.id)));
  console.info('[workspaces] Kopien aus der Sicherung geschlossen, Chromium hat die Sitzung wiederhergestellt');
  return true;
}

async function onWindowRemoved(winId) {
  const img = image.get(winId);
  image.delete(winId);
  closing.delete(winId);
  const s = await sess();
  const ws = s.windowWs[winId];
  if ((await getPending())?.windowId === winId) scheduleReconcile();
  if (ws === undefined) {
    scheduleReconcile();
    return;
  }
  delete s.windowWs[winId];
  delete s.prevWs[winId];
  await saveSess(s);
  const { stash, mains } = await scan();
  // Workspace und URLs merken, damit das Fenster nach Strg+Shift+T wieder seinen Workspace
  // zeigt (assignWindows). Die URLs stammen aus dem letzten Snapshot; neue Tab-Seiten
  // zählen wie beim Abgleich nicht mit.
  const { backupWindows } = await chrome.storage.local.get('backupWindows');
  const urls = backupWindows?.find((e) => e.id === winId)?.urls.filter((u) => u && !isNewTab({ url: u }));
  if (mains.length && urls?.length) {
    const { closed = [] } = await chrome.storage.session.get('closed');
    await chrome.storage.session.set({ closed: [...closed, { ws, urls, closed: true }].slice(-10) });
  }

  if (!mains.length) {
    // Letztes sichtbares Fenster geschlossen → Ablagen auch schließen, damit der
    // Browser wirklich beendet wird. Die Tabs stehen in der Sicherung; eine noch
    // ausstehende Sicherung vorher mit dem Abbild des Fensters nachholen.
    if (changes > savedChanges && img) await snapshot({ ...img, ws }).catch((e) => console.warn('[workspaces] Sicherung beim Schließen', e));
    for (const w of stash.values()) await chrome.windows.remove(w.id).catch(() => {});
    return;
  }
  // Ein Fenster von mehreren wurde geschlossen: seine Tabs sind bewusst weg.
  if (!mains.some((w) => s.windowWs[w.id] === ws) && !stash.has(ws)) await clearBackup(ws);
  await snapshot();
}
