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
  for (const [id, w] of stash) {
    const st = w.tabs.find(isStashTab);
    // Nach einer gescheiterten Sicherung beim Schließen sichtbar gemacht (onWindowRemoved)
    if (urlOf(st).includes(`?${SHOWN}#`)) await chrome.tabs.update(st.id, { url: `${STASH_PAGE}#${id}` });
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
      await keepLater(target, r.later, 'shown');
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
  // Nur beim ersten Abgleich mit Fenstern, nachdem storage.session leer war. Den Haken
  // setzt restoreStart erst, wenn der Aufbau abgeschlossen ist (#185).
  const { startChecked } = await chrome.storage.session.get('startChecked');
  if (!startChecked && mains.length) {
    if (!stash.size && mains.every((w) => guessed.has(w.id)) && (await restoreStart(mains, s.windowWs[mains[0].id]))) {
      ({ stash, mains } = await scan());
      changed = true;
    } else await chrome.storage.session.set({ startChecked: true });
  }
  // Hat Chromium die Sitzung nachträglich wiederhergestellt, enthält die Sicherung womöglich
  // schon die doppelten Tabs. repairFromBackup würde die geschlossenen Kopien dann als
  // verloren ergänzen; der Snapshot am Ende bringt sie auf den Stand.
  if (await dropStartCopies(s, stash)) changed = true;
  else if (starting && (await moving(() => repairFromBackup(cfg, s, stash, mains)))) changed = true;
  s.tabOrigin = {};
  await saveSess(s);

  // Symbole der Tabs setzen onCreated und onAttached; neu sind sie nur bei Änderungen
  if (changed) await updateAllIcons();
  await checkSession();
  if (changed) await snapshot();
  await feedLater();
  await syncMute();
}

// Legt die gesicherten Tabs von wsId und die angehefteten Tabs im ersten Fenster an,
// soweit sie nicht schon offen sind (z. B. von Chromium wiederhergestellte angeheftete
// Tabs). Ein beim Start übergebener Link bleibt aktiv; eine einzelne neue Tab-Seite wird
// ersetzt. Der Plan steht bis zum Abschluss in storage.session ('pendingStart'): Bis dahin
// sichert snapshot() nichts, und endet der Service Worker mittendrin, setzt resumeStart den
// Aufbau fort, statt dass der nächste Snapshot die Sicherung durch den Teilstand ersetzt (#185).
async function restoreStart(wins, wsId) {
  const win = wins[0];
  const { backup, backupPinned } = await getBackup();
  const open = (pinned) => wins.flatMap((w) => w.tabs.filter((t) => !!t.pinned === pinned).map((t) => ({ url: urlOf(t) })));
  const saved = savedOf(backup[wsId]);
  const pinned = missingIn(backupPinned.filter((e) => e.url), open(true));
  const tabs = missingIn(saved.filter((e) => e.url), open(false));
  if (!pinned.length && !tabs.length) return false;
  const own = movableTabsOf(win);
  const blank = own.length === 1 && isNewTab(own[0]) && !saved.some((e) => e.url === urlOf(own[0])) ? own[0].id : null;
  const plan = {
    ws: wsId,
    windowId: win.id,
    known: win.tabs.map((t) => t.id),
    blank,
    pinned,
    tabs,
    // Für dropStartCopies: was vor dem Ende offen war (gezeigt oder in der Ablage)
    wasOpen: [...(backup[wsId]?.shown || []), ...(backup[wsId]?.stash || [])].map((e) => e.url),
    // Was danach in failed steht, hat ein abgebrochener Aufbau schon aufbewahrt
    failedBefore: backup[wsId]?.failed?.length || 0,
  };
  await chrome.storage.session.set({ pendingStart: plan });
  try {
    await buildStart(plan);
  } catch (err) {
    scheduleReconcile(); // setzt den Aufbau fort, bis dahin keine Snapshots
    throw err;
  }
  console.info('[workspaces] Workspace nach dem Start aus der Sicherung aufgebaut');
  return true;
}

// Merkt im Plan von restoreStart, dass Eintrag i (e) nicht angelegt werden konnte (wie noteFailed)
const noteStartFailed = (key) => async (i, e) => {
  const { pendingStart: p } = await chrome.storage.session.get('pendingStart');
  if (p) await chrome.storage.session.set({ pendingStart: { ...p, [key]: [...(p[key] || []), { i, url: e.url }] } });
};

// Führt den Plan von restoreStart aus. havePinned/haveTabs: die von einem abgebrochenen
// Aufbau schon angelegten Tabs, gonePinned/goneTabs: die Indizes der dabei gescheiterten.
async function buildStart(plan, havePinned = [], haveTabs = [], gonePinned = [], goneTabs = []) {
  const { ws: wsId, windowId } = plan;
  await moving(async () => {
    const p = await recreate(plan.pinned, windowId, true, false, havePinned, gonePinned, noteStartFailed('failedPinned'));
    const r = await recreate(plan.tabs, windowId, false, false, haveTabs, goneTabs, noteStartFailed('failed'));
    // Hat ein abgebrochener Aufbau keepFailed schon ausgeführt, nur neu gescheiterte
    // aufbewahren. keepLater mit 'saved' darf sich wiederholen: Es findet die Einträge zuerst in later.
    const kept = (await getBackup()).backup[wsId]?.failed?.slice(plan.failedBefore) || [];
    await keepFailed(wsId, missingIn([...asPinned(p.failed), ...r.failed], kept));
    await keepLater(wsId, r.later, 'saved');
    // Der Rest ist ohne Folgen für die Sicherung
    await chrome.storage.session.remove('pendingStart');
    await chrome.storage.session.set({ startChecked: true });
    const ids = r.ids;
    if (plan.blank && ids.length) {
      await chrome.tabs.update(ids[0], { active: true });
      await chrome.tabs.remove(plan.blank).catch(() => {});
    }
    // Für dropStartCopies: die angelegten Kopien und alle Tabs, die es jetzt schon gibt.
    // Kopien sind nur Tabs aus Einträgen, die vor dem Ende offen waren; die aus vorher schon
    // zurückgestellten (keepLater) kennt Chromium nicht und kommen wie die später
    // nachgelegten nach startFed.
    const all = await chrome.tabs.query({});
    const entry = (t) => ({ id: t.id, url: urlOf(t) });
    const known = new Map();
    for (const u of plan.wasOpen) known.set(u, (known.get(u) || 0) + 1);
    const wasOpen = (t) => known.get(urlOf(t)) > 0 && known.set(urlOf(t), known.get(urlOf(t)) - 1);
    const made = all.filter((t) => ids.includes(t.id));
    const copies = [...all.filter((t) => p.ids.includes(t.id)), ...made.filter(wasOpen)];
    await chrome.storage.session.set({
      startCopies: copies.map(entry),
      startFed: made.filter((t) => !copies.includes(t)).map(entry),
      startSeen: all.map((t) => t.id),
      startCopiesUntil: Date.now() + 60000,
      startWs: wsId,
    });
  });
}

// Setzt einen unterbrochenen restoreStart fort (über resumeSwitch vor jeder Aktion und
// jedem Abgleich): Tabs, die seither im Fenster dazugekommen sind und der Reihe nach zu den
// geplanten Einträgen passen, sind schon angelegt. Gescheiterte Einträge bekommen keinen.
async function resumeStart() {
  const { pendingStart: plan } = await chrome.storage.session.get('pendingStart');
  if (!plan) return false;
  const win = (await scan()).mains.find((w) => w.id === plan.windowId);
  if (!win) {
    await chrome.storage.session.remove('pendingStart');
    return false;
  }
  // Der abgebrochene Abgleich hat die Zuordnung des Fensters womöglich nicht mehr gespeichert
  const s = await sess();
  if (!s.windowWs[win.id]) {
    s.windowWs[win.id] = plan.ws;
    await saveSess(s);
  }
  const added = win.tabs.filter((t) => !plan.known.includes(t.id) && !isStashTab(t));
  const match = (list, tabs, gone) => {
    const have = [];
    let i = 0;
    for (const t of tabs) {
      while (gone.includes(i)) i++;
      if (urlOf(t) !== list[i]?.url) break;
      have.push(t);
      i++;
    }
    return have;
  };
  const gonePinned = (plan.failedPinned || []).map((x) => x.i);
  const goneTabs = (plan.failed || []).map((x) => x.i);
  const havePinned = match(plan.pinned, added.filter((t) => t.pinned), gonePinned);
  const haveTabs = match(plan.tabs, added.filter((t) => !t.pinned), goneTabs);
  console.info('[workspaces] setze unterbrochenen Aufbau nach dem Start fort:', plan.ws, havePinned.length, haveTabs.length);
  await buildStart(plan, havePinned, haveTabs, gonePinned, goneTabs);
  return true;
}

// Nach einem Absturz startet Chromium mit neuer Tab-Seite und bietet „Wiederherstellen“
// an. restoreStart hat den Workspace dann schon aus der Sicherung aufgebaut; ein Klick
// darauf holt dieselben Tabs noch einmal (die des ersten Fensters hängt Chromium an das
// vorhandene Fenster an). Sind alle noch unveränderten Kopien danach im selben Workspace
// ein weiteres Mal offen, werden die Kopien geschlossen; Chromiums Tabs behalten ihren
// Verlauf. Landen sie in einem anderen Workspace (vorher gewechselt), bleiben die Kopien.
// Das gilt nur in der ersten Minute nach dem Start: Später öffnet eher man selbst eine
// der Seiten noch einmal, und die Kopie samt Eingaben darin bleibt. Auch in der ersten
// Minute zählen nur Tabs, die wie Chromiums Wiederherstellung gemeinsam erscheinen: in
// einem Schwung (START_BURST) mindestens so viele wie die Kopien, mindestens zwei. Öffnet
// man eine der Seiten selbst neu, bleiben beide.
// Wurde der Workspace schubweise aufgebaut (startWs), kennt Chromium womöglich nur einen
// Teil der Tabs: Was es über die Kopien hinaus zurückbringt, schließt die seither
// nachgelegten Tabs (startFed) und wird nicht mehr nachgelegt; der Rest kommt weiter.
const START_BURST = 5000;
async function dropStartCopies(s, stash) {
  const keys = ['startCopies', 'startSeen', 'startCopiesUntil', 'startNew', 'startWs', 'startFed'];
  const { startCopies, startSeen, startCopiesUntil, startNew = {}, startWs, startFed = [] } = await chrome.storage.session.get(keys);
  if (!startCopies || !(Date.now() <= startCopiesUntil)) {
    ownTabs.clear();
    if (startCopies) await chrome.storage.session.remove(keys);
    return false;
  }
  const tabs = await chrome.tabs.query({});
  const wsOf = (t) => s.windowWs[t.windowId] || [...stash].find(([, w]) => w.id === t.windowId)?.[0];
  const key = (t) => `${wsOf(t)} ${urlOf(t)}`;
  const live = startCopies.filter((c) => tabs.some((t) => t.id === c.id && urlOf(t) === c.url));
  // Selbst angelegte Tabs gelten wie die beim Aufbau vorhandenen als gesehen
  const own = [...ownTabs];
  ownTabs.clear();
  const seen = new Set([...startSeen, ...own]);
  // Wann jeder neue Tab zuerst auftauchte; der letzte Schwung zählt als Wiederherstellung
  const now = Date.now();
  const added = tabs.filter((t) => !seen.has(t.id));
  const when = Object.fromEntries(added.map((t) => [t.id, startNew[t.id] ?? now]));
  await chrome.storage.session.set({ startNew: when, ...(own.length ? { startSeen: [...seen] } : {}) });
  const last = Math.max(0, ...Object.values(when));
  const burst = added.filter((t) => when[t.id] >= last - START_BURST);
  const have = burst.map((t) => ({ url: key(t) }));
  const want = live.map((c) => ({ url: key(tabs.find((t) => t.id === c.id)) }));
  // noch nicht (alle) wiederhergestellt, oder nur einzeln selbst geöffnet
  if (live.length && (missingIn(want, have).length || burst.length < Math.max(live.length, 2))) return false;
  await chrome.storage.session.remove(keys);
  if (!live.length) return false;
  // Von Chromium zurückgebracht, aber keine der Kopien (je Workspace und Adresse gezählt)
  const extra = new Map();
  for (const e of missingIn(have, want)) extra.set(e.url, (extra.get(e.url) || 0) + 1);
  const take = (k) => extra.get(k) > 0 && extra.set(k, extra.get(k) - 1);
  const fed = startFed.filter((c) => {
    const t = tabs.find((x) => x.id === c.id && urlOf(x) === c.url);
    return t && take(key(t));
  });
  await moving(() => chrome.tabs.remove([...live, ...fed].map((c) => c.id)));
  // Die übrigen nachgelegten Tabs kannte Chromium nicht: Sie gehören hinter seine Tabs, und
  // lagen sie mit Kopien in einer Gruppe, in die Gruppe mit gleichem Titel und gleicher Farbe,
  // in der Chromium die meisten dieser Kopien wiederhergestellt hat. Ist das nicht eindeutig,
  // bleibt ihre Gruppe für sich.
  const kept = (await chrome.tabs.query({})).filter((t) => startFed.some((c) => c.id === t.id && !fed.includes(c)));
  if (kept.length) {
    await moving(async () => {
      await moveOrdered(kept, kept[0].windowId);
      const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
      for (const gid of new Set(kept.map((t) => t.groupId).filter((g) => g >= 0))) {
        const g = groups.get(gid);
        const like = (t) => groups.get(t.groupId)?.title === g?.title && groups.get(t.groupId)?.color === g?.color;
        const votes = new Map();
        const pool = burst.filter((t) => t.groupId >= 0 && like(t));
        for (const c of live.map((x) => tabs.find((t) => t.id === x.id)).filter((t) => t.groupId === gid)) {
          const i = pool.findIndex((t) => key(t) === key(c));
          if (i < 0) continue;
          const [t] = pool.splice(i, 1);
          votes.set(t.groupId, (votes.get(t.groupId) || 0) + 1);
        }
        const [best, next] = [...votes].sort((a, b) => b[1] - a[1]);
        if (best && (!next || next[1] < best[1])) await groupEntry(kept.filter((t) => t.groupId === gid).map((t) => t.id), g.windowId, null, best[0]);
      }
    });
  }
  const { backup } = await getBackup();
  const b = backup[startWs];
  if (b?.later) {
    b.later = b.later.filter((e) => !take(`${startWs} ${e.url}`));
    if (!b.later.length) delete b.later;
    await chrome.storage.local.set({ backup });
  }
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
  const prev = s.prevWs[winId];
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
    // Läuft der Browser weiter (Inkognito-, Popup- oder App-Fenster), gilt das nächste
    // Fenster als Start ohne Sitzungswiederherstellung: restoreStart baut es auf.
    await chrome.storage.session.remove('startChecked');
    if (changes > savedChanges && img) {
      try {
        await snapshot({ ...img, ws });
      } catch (e) {
        // Ohne Sicherung gingen die Tabs der Ablagen verloren. Sie bleiben deshalb offen
        // und verlieren den Schlüssel im Titel, damit das KWin-Skript sie wieder in die
        // Taskleiste bringt. Der nächste Abgleich versteckt sie wieder.
        console.warn('[workspaces] Sicherung beim Schließen, Ablagen bleiben offen', e);
        for (const [id, w] of stash) {
          const st = w.tabs.find(isStashTab);
          await chrome.tabs.update(st.id, { url: `${STASH_PAGE}?${SHOWN}#${id}` }).catch(() => {});
        }
        return;
      }
    }
    // Chromium stellt beim nächsten Start nur das zuletzt geschlossene Fenster samt Verlauf
    // wieder her, die anderen Workspaces kommen aus der Sicherung. Zuletzt deshalb die
    // Ablage des davor gezeigten Workspace schließen, sonst die mit den meisten Tabs.
    const rank = (w) => stashTabsOf(w).length * (stash.get(prev) === w ? 1e9 : 1);
    const order = [...stash.values()].sort((a, b) => rank(a) - rank(b));
    for (const w of order) await chrome.windows.remove(w.id).catch(() => {});
    return;
  }
  // Ein Fenster von mehreren wurde geschlossen: seine Tabs sind bewusst weg.
  if (!mains.some((w) => s.windowWs[w.id] === ws) && !stash.has(ws)) await clearBackup(ws);
  await snapshot();
}
