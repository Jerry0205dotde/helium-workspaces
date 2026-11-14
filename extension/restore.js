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
// have und kommen nach failed. Scheitert ein Eintrag, erfährt onFail seinen Index (#148).
// Nicht angeheftete Tabs werden nach dem ersten Laden entladen, solange sie nicht aktiv sind.
async function recreate(list, windowId, pinned = false, join = false, have = [], gone = [], onFail = null) {
  const ids = [];
  const failed = [];
  const groups = new Map();
  const used = new Set(); // in diesem Aufruf belegte Gruppen gehören zu einer anderen Sicherung
  let n = 0;
  for (const [i, e] of list.entries()) {
    if (!e.url) continue;
    if (gone.includes(i)) {
      failed.push(pinned ? e : failedEntry(e, list));
      continue;
    }
    const t = have[n++] || (await openEntry(e, { windowId, pinned }, list, failed));
    if (!t) {
      await onFail?.(i);
      continue;
    }
    ids.push(t.id);
    if (!pinned) await unloadLaterAdd(t.id);
    if (e.g && !pinned) {
      if (!groups.has(e.g)) groups.set(e.g, []);
      groups.get(e.g).push({ id: t.id, e });
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
        } catch {
          // Tab bleibt ohne Gruppe erhalten
        }
      }
    }
  }
  return { ids, failed };
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

// Legt die fehlgeschlagenen Tabs eines Workspace erneut an, im Fenster windowId.
// Zeigt das Fenster einen anderen Workspace, wird vorher dorthin gewechselt.
async function retryFailed(windowId, wsId) {
  await resumeSwitch();
  if ((await sess()).windowWs[windowId] !== wsId) await switchTo(windowId, wsId);
  if ((await sess()).windowWs[windowId] !== wsId) return;
  const list = (await getBackup()).backup[wsId]?.failed || [];
  if (!list.length) return;
  const still = await moving(async () => {
    const p = await recreate(list.filter((e) => e.p), windowId, true);
    const r = await recreate(list.filter((e) => !e.p), windowId, false, true);
    return [...p.failed, ...r.failed];
  });
  const { backup } = await getBackup();
  backup[wsId].failed = still;
  await chrome.storage.local.set({ backup });
  await updateAllIcons();
  await snapshot();
}

async function dismissFailed(wsId) {
  const { backup } = await getBackup();
  if (!backup[wsId]?.failed) return;
  delete backup[wsId].failed;
  await chrome.storage.local.set({ backup });
  await updateAllIcons();
}

// Ordnet die gesicherten URLs den lebenden zu (längste gemeinsame Teilfolge).
// Ergebnis: für jeden gesicherten Eintrag der Index des lebenden Tabs oder -1.
function align(saved, live) {
  const n = saved.length;
  const m = live.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = saved[i] === live[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const match = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (saved[i] === live[j]) match[i++] = j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
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
    const saved = savedOf(b).filter((e) => e.url);
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
