// Austauschformat für Export und Import. Enthält nur, was auch auf einem anderen Gerät
// oder in einem frischen Profil Sinn ergibt: die Workspaces in ihrer Reihenfolge mit Name,
// Farbe, Emoji, Tabs und Tab-Gruppen, die angehefteten Tabs und die Einstellungen
// „Ablagen stummschalten“, „Ablagen entladen nach“ (Minuten) und „Automatisch sichern“
// (Tage). Fenster-, Tab- und Gruppen-IDs und der geräteeigene KWin-Schlüssel gehören
// nicht dazu.
//
// {
//   "format": "helium-workspaces",
//   "version": 1,
//   "exported": "2026-11-11T12:00:00.000Z",
//   "settings": { "muteStash": true, "unloadAfter": 30, "autoBackup": 1 },
//   "pinned": [{ "url": "…", "title": "…" }],
//   "workspaces": [{
//     "id": "k3j9x0aa", "name": "Uni", "color": "#3b82f6", "emoji": "🎓",
//     "groups": [{ "id": "1", "title": "Mathe", "color": "blue", "collapsed": false }],
//     "tabs": [{ "url": "…", "title": "…", "group": "1" }]
//   }]
// }
//
// Die Workspace-ID dient nur dazu, beim erneuten Import denselben Workspace
// wiederzuerkennen. Die Gruppen-IDs gelten nur innerhalb ihres Workspace.
// "settings" ist optional (ältere Dateien haben es nicht), ebenso jede Einstellung darin.
// Ein ungültiger Wert lehnt die Datei nicht ab, er wird nur nicht übernommen.

const EXCHANGE_FORMAT = 'helium-workspaces';
const EXCHANGE_VERSION = 1;
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const EXCHANGE_LIMITS = { workspaces: 500, tabs: 20000, url: 2 * 1024 * 1024, text: 10000, bytes: 50 * 1024 * 1024 };

const formatExchange = (data) => JSON.stringify(data, null, 2) + '\n';

// UTF-8 braucht je UTF-16-Einheit mindestens 1 und höchstens 3 Bytes (Ersatzpaare: 2 → 4).
// Erst im Grenzbereich wird tatsächlich kodiert.
function exceedsBytes(text, max = EXCHANGE_LIMITS.bytes) {
  if (text.length > max) return true;
  if (text.length * 3 <= max) return false;
  return new TextEncoder().encode(text).length > max;
}

// Kürzt Text auf EXCHANGE_LIMITS.text, ohne ein UTF-16-Ersatzpaar zu zerteilen.
function clipText(s, max = EXCHANGE_LIMITS.text) {
  if (s.length <= max) return s;
  const end = s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

// Prüft, ob ein Export innerhalb aller Importgrenzen bleibt: Anzahl der Workspaces, gesamte
// Tabs samt angehefteten und Größe der JSON-Datei. Ergibt die Begründung oder null.
function exchangeLimitError(data, text) {
  if (data.workspaces.length > EXCHANGE_LIMITS.workspaces) {
    return tr('limitWorkspaces', EXCHANGE_LIMITS.workspaces, data.workspaces.length);
  }
  const tabs = data.pinned.length + data.workspaces.reduce((n, w) => n + w.tabs.length, 0);
  if (tabs > EXCHANGE_LIMITS.tabs) {
    return tr('limitTabs', EXCHANGE_LIMITS.tabs, tabs);
  }
  if (text === undefined) {
    // Jedes Zeichen aus Adresse und Titel steht mindestens als ein Byte im JSON. Überschreitet
    // schon diese Summe die Grenze, braucht JSON.stringify den langen Text gar nicht anzulegen.
    let raw = 0;
    for (const p of data.pinned) raw += p.url.length + p.title.length;
    for (const w of data.workspaces) {
      for (const t of w.tabs) raw += t.url.length + t.title.length;
      for (const g of w.groups) raw += g.title.length;
    }
    if (raw > EXCHANGE_LIMITS.bytes) return tr('limitSize', EXCHANGE_LIMITS.bytes / (1024 * 1024));
    text = formatExchange(data);
  }
  if (exceedsBytes(text)) {
    return tr('limitSize', EXCHANGE_LIMITS.bytes / (1024 * 1024));
  }
  return null;
}

// Seiten dieser Erweiterung (Ablage, Popup, diese Seite) gehören nicht in den Austausch.
// Verglichen wird der Host der geparsten Adresse, damit Schreibweisen wie ./stash.html
// oder Großbuchstaben nicht an der Prüfung vorbeikommen.
function isOwnPage(url, extOrigin) {
  try {
    const u = new URL(url);
    return u.protocol === 'chrome-extension:' && u.host.toLowerCase() === new URL(extOrigin).host.toLowerCase();
  } catch {
    return false;
  }
}

// list: [{ ws, entries }] mit Einträgen im Sicherungsformat (url, title, g, gt, gc, gx).
// Der Gruppenschlüssel g muss innerhalb eines Workspace eine Gruppe eindeutig benennen.
function buildExchange(list, pinned, extOrigin, settings) {
  const keep = (e) => e.url && !isOwnPage(e.url, extOrigin);
  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_VERSION,
    exported: new Date().toISOString(),
    settings,
    pinned: pinned.filter(keep).map((e) => ({ url: e.url, title: clipText(e.title || '') })),
    workspaces: list.map(({ ws, entries }) => {
      const groups = [];
      const ids = new Map();
      const tabs = entries
        .filter(keep)
        .map((e) => {
          const t = { url: e.url, title: clipText(e.title || '') };
          if (e.g) {
            if (!ids.has(e.g)) {
              const id = String(groups.length + 1);
              ids.set(e.g, id);
              const color = GROUP_COLORS.includes(e.gc) ? e.gc : 'grey';
              groups.push({ id, title: clipText(e.gt || ''), color, collapsed: !!e.gx });
            }
            t.group = ids.get(e.g);
          }
          return t;
        });
      return { id: ws.id, name: wsName(ws.name), color: ws.color, emoji: clipText(firstChar(ws.emoji || '')), groups, tabs };
    }),
  };
}

// Die gültigen Einstellungen aus der Datei, ungültige und fehlende bleiben weg. Die
// erlaubten Werte stehen in unload.js und autobackup.js.
function parseSettings(s) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return {};
  const r = {};
  if (typeof s.muteStash === 'boolean') r.muteStash = s.muteStash;
  if (UNLOAD_CHOICES.includes(s.unloadAfter)) r.unloadAfter = s.unloadAfter;
  if (AUTO_CHOICES.includes(s.autoBackup)) r.autoBackup = s.autoBackup;
  return r;
}

// Prüft eine Export-Datei vollständig und wirft bei jedem Fehler, bevor irgendetwas
// geändert wird. Ergebnis: { exported, settings, pinned: [{url, title}], workspaces: [{ id | null,
// name, color, emoji, groups, tabs }] }, Tabs im Sicherungsformat. Ihr Gruppenschlüssel g
// ist "<Workspace-Nr.>:<Gruppen-ID>" und muss beim Übernehmen noch eindeutig gemacht werden.
function parseExchange(text, extOrigin) {
  if (typeof text !== 'string') throw new Error(tr('exNotJson'));
  if (exceedsBytes(text)) throw new Error(tr('fileTooLarge'));
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(tr('exNotJson'));
  }
  const fail = (where, msg) => {
    throw new Error(where ? `${where}: ${msg}` : msg);
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, where, field, max = EXCHANGE_LIMITS.text) => {
    if (typeof v !== 'string') fail(where, tr('exNotText', field));
    if (v.length > max) fail(where, tr('exTooLong', field));
    return v;
  };
  const optStr = (v, where, field) => (v === undefined ? '' : str(v, where, field));
  const arr = (v, where, field, optional) => {
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) fail(where, tr('exNotList', field));
    return v;
  };
  const url = (v, where) => {
    str(v, where, 'url', EXCHANGE_LIMITS.url);
    let u;
    try {
      u = new URL(v);
    } catch {
      fail(where, tr('exBadUrl', v.slice(0, 80)));
    }
    if (u.protocol === 'javascript:') fail(where, tr('exJavascript'));
    if (isOwnPage(v, extOrigin)) fail(where, tr('exOwnPage'));
    return v;
  };

  if (!isObj(data) || data.format !== EXCHANGE_FORMAT) {
    fail('', tr('exNotExport'));
  }
  if (!Number.isInteger(data.version) || data.version < 1) {
    fail('', tr('exBadVersion'));
  }
  if (data.version > EXCHANGE_VERSION) {
    fail('', tr('exNewerVersion', data.version, EXCHANGE_VERSION));
  }
  const exported = typeof data.exported === 'string' ? data.exported : '';

  const pinned = arr(data.pinned, '', 'pinned', true).map((t, i) => {
    const where = tr('exWherePinned', i + 1);
    if (!isObj(t)) fail(where, tr('exNotObject'));
    return { url: url(t.url, where), title: optStr(t.title, where, 'title') };
  });

  const list = arr(data.workspaces, '', 'workspaces');
  if (!list.length) fail('', tr('exNoWorkspaces'));
  if (list.length > EXCHANGE_LIMITS.workspaces) fail('', tr('exTooManyWorkspaces'));
  const wsIds = new Set();
  let total = pinned.length;
  const workspaces = list.map((w, wi) => {
    let where = tr('exWhereWs', wi + 1);
    if (!isObj(w)) fail(where, tr('exNotObject'));
    const name = wsName(str(w.name, where, 'name'));
    where = tr('exWhereWsNamed', wi + 1, name);
    const color = str(w.color, where, 'color');
    if (!HEX_COLOR.test(color)) fail(where, tr('exBadColor', color));
    const emoji = firstChar(optStr(w.emoji, where, 'emoji'));
    let id = null;
    if (w.id !== undefined) {
      id = str(w.id, where, 'id', 64);
      if (!/^[a-z0-9]+$/i.test(id)) fail(where, tr('exBadId'));
      if (wsIds.has(id)) fail(where, tr('exDupId', id));
      wsIds.add(id);
    }

    const groups = new Map();
    arr(w.groups, where, 'groups', true).forEach((g, gi) => {
      const gw = tr('exWhereGroup', where, gi + 1);
      if (!isObj(g)) fail(gw, tr('exNotObject'));
      const gid = str(g.id, gw, 'id', 64);
      if (!gid) fail(gw, tr('exEmptyId'));
      if (groups.has(gid)) fail(gw, tr('exDupGroupId', gid));
      if (!GROUP_COLORS.includes(g.color)) fail(gw, tr('exBadGroupColor', g.color, GROUP_COLORS.join(', ')));
      if (g.collapsed !== undefined && typeof g.collapsed !== 'boolean') fail(gw, tr('exBadCollapsed'));
      groups.set(gid, { gt: optStr(g.title, gw, 'title'), gc: g.color, gx: !!g.collapsed });
    });

    const tabs = arr(w.tabs, where, 'tabs').map((t, ti) => {
      const tw = tr('exWhereTab', where, ti + 1);
      if (!isObj(t)) fail(tw, tr('exNotObject'));
      const e = { url: url(t.url, tw), title: optStr(t.title, tw, 'title') };
      if (t.group !== undefined && t.group !== null) {
        const g = groups.get(t.group);
        if (!g) fail(tw, tr('exUnknownGroup', t.group));
        Object.assign(e, { g: `${wi}:${t.group}` }, g);
      }
      return e;
    });
    total += tabs.length;
    if (total > EXCHANGE_LIMITS.tabs) fail('', tr('exTooManyTabs'));
    return { id, name, color, emoji, groups: new Set(tabs.map((e) => e.g).filter(Boolean)).size, tabs };
  });
  return { exported, settings: parseSettings(data.settings), pinned, workspaces };
}
