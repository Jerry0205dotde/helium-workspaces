// Hintergrundlogik: Tabs aus der Sicherung neu anlegen, fehlgeschlagene aufbewahren und
// erneut versuchen, nach dem Browserstart verlorene Tabs ergänzen

// Eintrag für failed: Gruppenmitglieder merken sich die URLs ihrer Geschwister in list
// (siehe recreate), damit ein erneuter Versuch sie wieder der Gruppe zuordnet.
function failedEntry(e, list) {
  if (!e.g) return e;
  const gs = list.filter((o) => o !== e && o.g === e.g).map((o) => o.url);
  return { ...e, gs: [...new Set([...(e.gs || []), ...gs])] };
}

// Die beiden Wege, gesicherte Tabs anzulegen (recreate und repairFromBackup), teilen sich
// diese Helfer, damit Verbesserungen beide erreichen.

// Legt den Tab zu Eintrag e an (props: windowId, index, pinned). Scheitert das, kommt e
// nach failed, nicht angeheftet samt den URLs seiner Geschwister aus list, und es gibt null.
async function openEntry(e, props, list, failed) {
  try {
    return await openTab({ ...props, url: e.url });
  } catch (err) {
    console.warn('[workspaces] Tab nicht wiederherstellbar:', e.url, err);
    failed.push(props.pinned ? e : failedEntry(e, list));
    return null;
  }
}

// Fasst Tabs in der gesicherten Gruppe von e zusammen: in der offenen Gruppe groupId oder,
// ohne sie, in einer neuen mit Titel, Farbe und Einklappen aus e. Gibt die Gruppen-ID zurück.
async function groupEntry(tabIds, windowId, e, groupId = null) {
  if (groupId !== null) return whenIdle(() => chrome.tabs.group({ groupId, tabIds }));
  const gid = await whenIdle(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
  await whenIdle(() => chrome.tabGroups.update(gid, groupProps(e)));
  return gid;
}

// Legt gesicherte Tabs neu an (nur nötig, wenn ihr Fenster nicht mehr existiert).
// Gibt die neuen Tab-IDs und die Einträge zurück, die nicht angelegt werden konnten.
// Lässt sich eine Gruppe nicht anlegen, werden ihre Tabs wieder geschlossen und
// zählen samt Gruppenangaben als fehlgeschlagen, damit ein erneuter Versuch sie
// wieder als Gruppe anlegt. Fehlgeschlagene Gruppenmitglieder merken sich die URLs
// ihrer Geschwister (gs), denn Gruppen-IDs ändern sich bei jeder Wiederherstellung
// und jedem Browserstart. Mit join treten sie beim erneuten Versuch der Gruppe bei,
// in der ein Geschwister-Tab liegt (das Fenster zeigt dann nur diesen Workspace).
// have sind Tabs, die ein abgebrochener Aufruf für die ersten Einträge schon angelegt
// hat: Sie werden nicht noch einmal angelegt, aber mit dem Rest gruppiert. gone sind die
// Indizes der Einträge in list, die dabei gescheitert sind: Sie bekommen keinen Tab aus
// have und kommen nach failed. Scheitert ein Eintrag, erfährt onFail Index und Eintrag (#148),
// legt recreate einen Tab an, erfährt onOpen Index und Tab (#186).
// Nicht angeheftete Tabs werden nach dem ersten Laden entladen, solange sie nicht aktiv sind.
// Laden schon LOAD_AT_ONCE von ihnen, legt recreate keine weiteren an (mindestens aber
// einen): Die übrigen Einträge kommen nach later, samt den URLs ihrer Geschwister wie bei
// failed. Der Aufrufer bewahrt sie mit keepLater auf, feedLater legt sie nach und nach an.
async function recreate(list, windowId, pinned = false, join = false, have = [], gone = [], onFail = null, onOpen = null) {
  const ids = [];
  const failed = [];
  const later = [];
  const groups = new Map();
  const used = new Set(); // in diesem Aufruf belegte Gruppen gehören zu einer anderen Sicherung
  let n = 0;
  for (const [i, e] of list.entries()) {
    if (!e.url) continue;
    if (gone.includes(i)) {
      failed.push(pinned ? e : failedEntry(e, list));
      continue;
    }
    let t = have[n];
    if (!t && !pinned && (later.length || (ids.length && (await restoredLoading()).n >= LOAD_AT_ONCE))) {
      later.push(failedEntry(e, list));
      continue;
    }
    n++;
    if (!t) {
      t = await openEntry(e, { windowId, pinned }, list, failed);
      if (!t) {
        await onFail?.(i, e);
        continue;
      }
      await onOpen?.(i, t);
    }
    ids.push(t.id);
    if (!pinned) await unloadLaterAdd(t.id);
    if (e.g && !pinned) {
      if (!groups.has(e.g)) groups.set(e.g, []);
      groups.get(e.g).push({ id: t.id, e, i });
    }
  }
  for (const members of groups.values()) {
    const { e } = members[0];
    const props = groupProps(e);
    const tabIds = members.map((m) => m.id);
    try {
      let same = null;
      const gs = new Set(members.flatMap((m) => m.e.gs || []));
      if (join && gs.size) {
        for (const t of await chrome.tabs.query({ windowId })) {
          if (t.groupId < 0 || used.has(t.groupId) || !gs.has(urlOf(t))) continue;
          const g = await chrome.tabGroups.get(t.groupId);
          if (g.title === props.title && g.color === props.color) {
            same = g;
            break;
          }
        }
      }
      used.add(await groupEntry(tabIds, windowId, e, same?.id ?? null));
    } catch (err) {
      console.warn('[workspaces] Gruppe nicht wiederherstellbar', err);
      for (const m of members) {
        try {
          await chrome.tabs.remove(m.id);
          ids.splice(ids.indexOf(m.id), 1);
          failed.push(failedEntry(m.e, list));
          await onFail?.(m.i, m.e);
        } catch {
          // Tab bleibt ohne Gruppe erhalten
        }
      }
    }
  }
  return { ids, failed, later };
}

// Fehlgeschlagene angeheftete Tabs kennzeichnet p
const asPinned = (failed) => failed.map((e) => ({ ...e, p: true }));

// Bewahrt fehlgeschlagene Einträge getrennt von shown/stash auf, damit snapshot()
// sie nicht durch die lebenden Tabs ersetzt. Aus shown/stash (bzw. den angehefteten
// Tabs) werden sie entfernt, damit jeder Eintrag nur an einer Stelle steht.
async function keepFailed(wsId, failed) {
  if (!failed.length) return;
  const { backup, backupPinned } = await getBackup();
  const b = (backup[wsId] ??= { stash: [], shown: [] });
  for (const e of failed) {
    for (const arr of e.p ? [backupPinned] : [(b.shown ??= []), (b.stash ??= [])]) {
      const i = arr.findIndex((a) => a.url === e.url);
      if (i >= 0) {
        arr.splice(i, 1);
        break;
      }
    }
  }
  b.failed = [...(b.failed || []), ...failed];
  await chrome.storage.local.set({ backup, backupPinned });
}

// Bewahrt die von recreate zurückgestellten Einträge (later) in der Sicherung von wsId auf.
// Dort stehen sie hinter den anderen (savedOf) und überstehen wie failed jeden Snapshot,
// bis feedLater ihre Tabs anlegt. from sagt, woher die Liste für recreate kam:
// 'saved' – aus savedOf (die bisher zurückgestellten waren darin und werden ersetzt),
// 'shown' – aus den gezeigten (die neuen kommen vor die bisherigen), sonst von außerhalb
// der Sicherung (die neuen kommen dahinter). Aus der Sicherung stammende Einträge werden
// dort von hinten gestrichen, damit jeder Eintrag nur an einer Stelle steht.
async function keepLater(wsId, later, from = null) {
  if (!later.length && from !== 'saved') return;
  const { backup } = await getBackup();
  const b = (backup[wsId] ??= { stash: [], shown: [] });
  const old = b.later || [];
  // Von hinten durchsuchen: zurückgestellt wird immer das Ende der Liste
  const pool = from === 'saved' ? [old, (b.stash ??= []), (b.shown ??= [])] : from === 'shown' ? [(b.shown ??= [])] : [];
  for (const e of [...later].reverse()) {
    for (const arr of pool) {
      const i = arr.findLastIndex((a) => a.url === e.url);
      if (i >= 0) {
        arr.splice(i, 1);
        break;
      }
    }
  }
  b.later = from === 'saved' ? later : from === 'shown' ? [...later, ...old] : [...old, ...later];
  if (!b.later.length) delete b.later;
  await chrome.storage.local.set({ backup });
  // Falls kein Tab fertig lädt und feedLater deshalb nicht anstößt
  if (b.later) {
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => serial(feedLater), LOAD_TIMEOUT);
  }
}

// Legt zurückgestellte Tabs (keepLater) an, solange weniger als LOAD_AT_ONCE aus der
// Sicherung angelegte Tabs laden: hinten im Fenster, das ihren Workspace zeigt, sonst in
// seiner Ablage. Läuft, wenn ein solcher Tab fertig geladen hat, nach jedem Abgleich (also
// auch nach einem Neustart des Service Workers) und spätestens, wenn ein Tab zu lange lädt.
// Hat der Workspace kein Fenster mehr, bleiben die Einträge in der Sicherung und kommen
// beim nächsten Aufbau aus ihr mit.
let feedTimer = null;
async function feedLater() {
  clearTimeout(feedTimer);
  if ((await getPending()) || (await getPendingStash())) return;
  if ((await chrome.storage.session.get('pendingStart')).pendingStart) return; // restoreStart setzt fort
  let changed = await resumeFeed();
  const { backup } = await getBackup();
  const todo = Object.keys(backup).filter((ws) => backup[ws].later?.length);
  const s = await sess();
  const { stash, mains } = await scan();
  let more = false;
  for (const ws of todo) {
    const { sw, showing } = windowsOf(ws, s, stash, mains);
    const win = showing[0] || sw;
    if (!win) continue;
    if ((await restoredLoading()).n >= LOAD_AT_ONCE) {
      more = true;
      break;
    }
    if (await feedInto(ws, win.id)) more = true;
    changed = true;
  }
  if (more) {
    const { wait } = await restoredLoading();
    feedTimer = setTimeout(() => serial(feedLater), wait === Infinity ? 0 : wait);
  }
  if (!changed) return;
  await updateAllIcons();
  await snapshot();
  await syncMute(); // moving() übergeht die Stummschaltung neuer Tabs in einer Ablage
}

// Legt zurückgestellte Tabs von ws im Fenster windowId an. Währenddessen steht in
// storage.session, welche Tabs schon vorher darin lagen ('pendingFeed'), damit resumeFeed
// nach einem Ende des Service Workers die schon angelegten erkennt; bis dahin sichert
// snapshot() nichts. have: die schon angelegten. true, wenn noch Einträge übrig sind.
async function feedInto(ws, windowId, have = [], gone = []) {
  if (!have.length && !gone.length) {
    const known = (await chrome.tabs.query({ windowId })).map((t) => t.id);
    await chrome.storage.session.set({ pendingFeed: { ws, windowId, known } });
  }
  // Gescheiterte Einträge merken, damit resumeFeed die Tabs danach richtig zuordnet (#148)
  const noteFed = async (i, e) => {
    const { pendingFeed: f } = await chrome.storage.session.get('pendingFeed');
    if (f) await chrome.storage.session.set({ pendingFeed: { ...f, failed: [...(f.failed || []), { i, url: e.url }] } });
  };
  const list = (await getBackup()).backup[ws]?.later || [];
  const r = await moving(() => recreate(list, windowId, false, true, have, gone, noteFed));
  const { backup } = await getBackup();
  const b = backup[ws];
  if (b) {
    if (r.later.length) b.later = r.later;
    else delete b.later;
    if (r.failed.length) b.failed = [...(b.failed || []), ...r.failed];
    await chrome.storage.local.set({ backup });
  }
  await chrome.storage.session.remove('pendingFeed');
  await noteStartFed(ws, r.ids);
  return r.later.length > 0;
}

// Setzt ein unterbrochenes Nachlegen fort, bevor etwas anderes die Fenster ändert (über
// resumeSwitch vor jeder Aktion und jedem Abgleich): Tabs, die seither im Fenster
// dazugekommen sind und der Reihe nach zu den zurückgestellten Einträgen passen, sind schon
// angelegt. Gescheiterte Einträge (failed) bekommen keinen davon.
async function resumeFeed() {
  const { pendingFeed: f } = await chrome.storage.session.get('pendingFeed');
  if (!f) return false;
  const list = (await getBackup()).backup[f.ws]?.later || [];
  const { stash, mains } = await scan();
  const { sw, showing } = windowsOf(f.ws, await sess(), stash, mains);
  const win = [...showing, sw].find((w) => w?.id === f.windowId);
  if (!list.length || !win) {
    await chrome.storage.session.remove('pendingFeed');
    return false;
  }
  const gone = (f.failed || []).filter((x) => list[x.i]?.url === x.url).map((x) => x.i);
  const have = [];
  let i = 0;
  for (const t of win.tabs) {
    if (f.known.includes(t.id) || t.pinned || isStashTab(t)) continue;
    while (gone.includes(i)) i++;
    if (urlOf(t) !== list[i]?.url) break;
    have.push(t);
    i++;
  }
  console.info('[workspaces] setze unterbrochenes Nachlegen fort:', f.ws, have.length);
  await feedInto(f.ws, f.windowId, have, gone);
  return true;
}

// Nach restoreStart merkt sich dropStartCopies die nachgelegten Tabs (startFed): Stellt
// Chromium die Sitzung doch noch wieder her, sind die darunter, die es auch kannte, Kopien
async function noteStartFed(ws, ids) {
  const { startCopies, startWs, startFed = [] } = await chrome.storage.session.get(['startCopies', 'startWs', 'startFed']);
  if (!startCopies || startWs !== ws || !ids.length) return;
  const added = (await chrome.tabs.query({})).filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, url: urlOf(t) }));
  await chrome.storage.session.set({ startFed: [...startFed, ...added] });
}

// Legt die fehlgeschlagenen Tabs eines Workspace erneut an, im Fenster windowId.
// Zeigt das Fenster einen anderen Workspace, wird vorher dorthin gewechselt.
async function retryFailed(windowId, wsId) {
  await resumeSwitch();
  if ((await sess()).windowWs[windowId] !== wsId) await switchTo(windowId, wsId);
  if ((await sess()).windowWs[windowId] !== wsId) return;
  if (!(await getBackup()).backup[wsId]?.failed?.length) return;
  await chrome.storage.session.set({ pendingRetry: { ws: wsId, windowId, open: [], failed: [] } });
  await retryInto(wsId, windowId);
  await updateAllIcons();
  await snapshot();
}

// Legt die Einträge in failed von ws im Fenster windowId an. Währenddessen steht in
// storage.session je Eintrag, welcher Tab für ihn angelegt wurde oder dass er gescheitert ist
// ('pendingRetry'), damit resumeRetry nach einem Ende des Service Workers die schon
// angelegten zuordnet, statt sie noch einmal anzulegen (#186). Nach URL ginge das nicht,
// gleiche Adressen sind erlaubt. have: Index in failed → schon angelegter Tab, gone: Indizes
// der schon gescheiterten.
async function retryInto(ws, windowId, have = new Map(), gone = new Set()) {
  const list = (await getBackup()).backup[ws]?.failed || [];
  const note = async (key, x) => {
    const { pendingRetry: r } = await chrome.storage.session.get('pendingRetry');
    if (r) await chrome.storage.session.set({ pendingRetry: { ...r, [key]: [...r[key], x] } });
  };
  // Angeheftete und übrige Einträge getrennt; idx führt ihre Indizes auf die in list zurück
  const part = (pinned) => {
    const idx = [...list.keys()].filter((i) => !list[i].p === !pinned);
    const h = [];
    for (const i of idx) {
      if (!list[i].url || gone.has(i)) continue;
      if (!have.has(i)) break;
      h.push(have.get(i));
    }
    const g = [...idx.keys()].filter((k) => gone.has(idx[k]));
    const onFail = (k, e) => note('failed', { i: idx[k], url: e.url });
    const onOpen = (k, t) => note('open', { i: idx[k], url: list[idx[k]].url, id: t.id });
    return recreate(idx.map((i) => list[i]), windowId, pinned, !pinned, h, g, onFail, onOpen);
  };
  const { still, later } = await moving(async () => {
    const p = await part(true);
    const r = await part(false);
    return { still: [...p.failed, ...r.failed], later: r.later };
  });
  const { backup } = await getBackup();
  if (backup[ws]) backup[ws].failed = still;
  await chrome.storage.local.set({ backup });
  await chrome.storage.session.remove('pendingRetry');
  await keepLater(ws, later);
}

// Setzt einen unterbrochenen erneuten Versuch fort (über resumeSwitch vor jeder Aktion und
// jedem Abgleich). Schon angelegte Tabs, die noch im Fenster liegen, gelten als angelegt;
// fehlt einer (geschlossen), bleibt sein Eintrag in failed.
async function resumeRetry() {
  const { pendingRetry: r } = await chrome.storage.session.get('pendingRetry');
  if (!r) return false;
  const list = (await getBackup()).backup[r.ws]?.failed || [];
  if (!list.length || (await sess()).windowWs[r.windowId] !== r.ws) {
    await chrome.storage.session.remove('pendingRetry');
    return false;
  }
  const fits = (x) => list[x.i]?.url === x.url;
  const gone = new Set(r.failed.filter(fits).map((x) => x.i));
  const have = new Map();
  for (const x of r.open.filter(fits)) {
    const t = await chrome.tabs.get(x.id).catch(() => null);
    if (t?.windowId === r.windowId) have.set(x.i, t);
    else gone.add(x.i);
  }
  console.info('[workspaces] setze unterbrochenen erneuten Versuch fort:', r.ws, have.size);
  await retryInto(r.ws, r.windowId, have, gone);
  return true;
}

async function dismissFailed(wsId) {
  const { backup } = await getBackup();
  if (!backup[wsId]?.failed) return;
  delete backup[wsId].failed;
  await chrome.storage.local.set({ backup });
  await updateAllIcons();
}

// Größe der Tabelle, bis zu der align genau rechnet (4 Mio. Zellen, 8 MB). Darüber, etwa
// bei Tausenden Tabs eines Imports, reicht eine gierige Zuordnung (#194).
const ALIGN_CELLS = 1 << 22;

// Ordnet die gesicherten URLs den lebenden zu (längste gemeinsame Teilfolge).
// Ergebnis: für jeden gesicherten Eintrag der Index des lebenden Tabs oder -1.
function align(saved, live) {
  const match = new Array(saved.length).fill(-1);
  // Gleiche Anfangs- und Endstücke direkt zuordnen, meist bleibt kaum etwas übrig
  let lo = 0;
  let n = saved.length;
  let m = live.length;
  while (lo < n && lo < m && saved[lo] === live[lo]) match[lo] = lo++;
  while (n > lo && m > lo && saved[n - 1] === live[m - 1]) match[--n] = --m;
  const rows = n - lo;
  const cols = m - lo;
  if (!rows || !cols) return match;
  if ((rows + 1) * (cols + 1) > ALIGN_CELLS) return alignGreedy(saved, live, lo, n, m, match);
  // dp[i * w + j]: Länge der gemeinsamen Teilfolge ab saved[lo + i] und live[lo + j].
  // Die Werte bleiben unter 2048 (Wurzel aus ALIGN_CELLS), Uint16 genügt.
  const w = cols + 1;
  const dp = new Uint16Array((rows + 1) * w);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const k = i * w + j;
      dp[k] = saved[lo + i] === live[lo + j] ? dp[k + w + 1] + 1 : Math.max(dp[k + w], dp[k + 1]);
    }
  }
  for (let i = 0, j = 0; i < rows && j < cols; ) {
    const k = i * w + j;
    if (saved[lo + i] === live[lo + j]) match[lo + i++] = lo + j++;
    else if (dp[k + w] >= dp[k + 1]) i++;
    else j++;
  }
  return match;
}

// Gierige Zuordnung für saved[lo..n) und live[lo..m), linear in Zeit und Speicher: einmal
// von vorn und einmal von hinten, die längere gilt. Was hier nicht zugeordnet wird,
// ergänzt repairFromBackup trotzdem nur, wenn die URL insgesamt seltener offen ist als
// gesichert.
function alignGreedy(saved, live, lo, n, m, match) {
  const s = saved.slice(lo, n);
  const l = live.slice(lo, m);
  const fwd = greedyMatch(s, l);
  const bwd = greedyMatch(s.reverse(), l.reverse())
    .reverse()
    .map((j) => (j < 0 ? -1 : l.length - 1 - j));
  const count = (x) => x.filter((j) => j >= 0).length;
  const best = count(bwd) > count(fwd) ? bwd : fwd;
  best.forEach((j, i) => (match[lo + i] = j < 0 ? -1 : lo + j));
  return match;
}

// Bei einer Abweichung wird übersprungen, was weniger kostet: die lebenden Tabs bis zum
// nächsten Vorkommen der gesicherten URL oder die gesicherten Einträge bis zum nächsten
// Vorkommen der lebenden URL.
function greedyMatch(saved, live) {
  // Für jede URL ihre Positionen und ein Zeiger auf die erste noch nicht überholte
  const positions = (list) => {
    const at = new Map();
    list.forEach((u, x) => {
      const p = at.get(u);
      if (p) p.list.push(x);
      else at.set(u, { list: [x], next: 0 });
    });
    return (url, from) => {
      const p = at.get(url);
      if (!p) return Infinity;
      while (p.next < p.list.length && p.list[p.next] < from) p.next++;
      return p.next < p.list.length ? p.list[p.next] : Infinity;
    };
  };
  const inLive = positions(live);
  const inSaved = positions(saved);
  const match = new Array(saved.length).fill(-1);
  for (let i = 0, j = 0; i < saved.length && j < live.length; ) {
    if (saved[i] === live[j]) {
      match[i++] = j++;
      continue;
    }
    const dj = inLive(saved[i], j) - j;
    const di = inSaved(live[j], i) - i;
    if (dj === Infinity) i++;
    else if (di === Infinity || dj <= di) j++;
    else i++;
  }
  return match;
}

// Nach dem Browserstart: Tabs ergänzen, die Chromium beim Wiederherstellen verloren hat.
// Chromium baut seine Session-Datei nach 250 Änderungen sofort neu auf. Fällt das in den
// Moment, in dem die Erweiterung einen Tab zwischen zwei Fenstern verschiebt (er ist dann
// kurz in keinem Fenster), fehlt dieser Tab in der Datei und kommt nach dem nächsten
// Start nicht wieder. Ergänzt wird nur, wo ein Workspace weniger Tabs hat als gesichert,
// und höchstens so viele, wie fehlen. Gleich viele abweichende Tabs an einer Stelle
// gelten als umgeleitete Seiten, nicht als verloren. Tabs, die sich nicht anlegen lassen,
// kommen wie bei recreate nach failed („Erneut versuchen“), statt mit dem nächsten
// Snapshot aus der Sicherung zu verschwinden.
async function repairFromBackup(cfg, s, stash, mains) {
  const { backup } = await getBackup();
  let changed = false;
  for (const ws of cfg.workspaces) {
    const b = backup[ws.id];
    const { sw, showing: wins } = windowsOf(ws.id, s, stash, mains);
    if (!b || (!wins.length && !sw)) continue;
    const live = [...wins.flatMap(movableTabsOf), ...(sw ? stashTabsOf(sw) : [])];
    const shown = (b.shown || []).filter((e) => e.url);
    // Ohne die zurückgestellten Einträge: Sie fehlen nicht, feedLater legt sie an
    const saved = [...shown, ...(b.stash || [])].filter((e) => e.url);
    let budget = saved.length - live.length;
    if (budget <= 0) continue;
    const match = align(
      saved.map((e) => e.url),
      live.map(urlOf),
    );
    // Wie oft fehlt jede URL? (unabhängig von der Reihenfolge der Fenster)
    const need = new Map();
    for (const e of saved) need.set(e.url, (need.get(e.url) || 0) + 1);
    for (const u of live.map(urlOf)) if (need.has(u)) need.set(u, need.get(u) - 1);
    // Seit der letzten Sicherung selbst geschlossene Tabs fehlen gewollt
    for (const c of closedTabs) {
      if (c.at <= savedChanges || ![...wins, sw].some((w) => w?.id === c.windowId)) continue;
      if (c.url === null) budget--;
      else if (need.get(c.url) > 0) {
        need.set(c.url, need.get(c.url) - 1);
        budget--;
      }
    }
    if (budget <= 0) continue;
    // Kandidaten zuerst aus Lücken, in denen die Sicherung mehr Einträge hat als die
    // Fenster; gleich viele abweichende Tabs sind eher umgeleitete Seiten.
    const gap = [];
    for (let i = 0; i < saved.length; ) {
      if (match[i] >= 0) {
        i++;
        continue;
      }
      let k = i;
      while (k < saved.length && match[k] < 0) k++;
      const prev = i > 0 ? match[i - 1] : -1;
      const next = k < saved.length ? match[k] : live.length;
      const deficit = k - i - (next - prev - 1);
      for (let x = Math.max(i, k - deficit); x < k; x++) gap.push(x);
      i = k;
    }
    const missing = new Set();
    for (const x of [...gap, ...saved.keys()]) {
      const u = saved[x].url;
      if (budget > 0 && match[x] < 0 && !missing.has(x) && need.get(u) > 0) {
        missing.add(x);
        need.set(u, need.get(u) - 1);
        budget--;
      }
    }
    if (!missing.size) continue;

    const created = new Map();
    const failed = [];
    let anchor = null;
    for (let x = 0; x < saved.length; x++) {
      if (x === shown.length) anchor = null; // Ablage-Abschnitt: nicht hinter Tabs des Hauptfensters
      if (match[x] >= 0) {
        anchor = live[match[x]].id;
        continue;
      }
      if (!missing.has(x)) continue;
      const a = anchor && (await chrome.tabs.get(anchor).catch(() => null));
      let windowId;
      let index;
      if (a) {
        windowId = a.windowId;
        index = a.index + 1;
      } else {
        windowId = (x < shown.length ? wins[0] || sw : sw || wins[0]).id;
        index = (await chrome.tabs.query({ windowId })).filter((t) => t.pinned).length;
      }
      const t = await openEntry(saved[x], { windowId, index }, saved, failed);
      if (!t) continue;
      created.set(x, t);
      anchor = t.id;
      changed = true;
      console.info('[workspaces] verlorenen Tab ergänzt:', saved[x].url);
    }
    await keepFailed(ws.id, failed);
    // Gruppen: der Gruppe eines Nachbarn mit derselben gesicherten Gruppe beitreten,
    // sonst die Gruppe neu anlegen.
    for (const [x, t] of created) {
      const e = saved[x];
      if (!e.g) continue;
      try {
        let gid = -1;
        for (let y = 0; y < saved.length && gid < 0; y++) {
          if (y === x || saved[y].g !== e.g) continue;
          const other = match[y] >= 0 ? live[match[y]] : created.get(y);
          const cur = other && (await chrome.tabs.get(other.id).catch(() => null));
          if (cur && cur.windowId === t.windowId && cur.groupId >= 0) gid = cur.groupId;
        }
        await groupEntry([t.id], t.windowId, e, gid >= 0 ? gid : null);
      } catch (err) {
        console.warn('[workspaces] Gruppe nicht ergänzbar', err);
      }
    }
  }
  return changed;
}
