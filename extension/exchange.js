// Austauschformat für Export und Import. Enthält nur, was auch auf einem anderen Gerät
// oder in einem frischen Profil Sinn ergibt: die Workspaces in ihrer Reihenfolge mit Name,
// Farbe, Emoji, Tabs und Tab-Gruppen sowie die angehefteten Tabs. Fenster-, Tab- und
// Gruppen-IDs und der geräteeigene KWin-Schlüssel gehören nicht dazu.
//
// {
//   "format": "helium-workspaces",
//   "version": 1,
//   "exported": "2026-11-11T12:00:00.000Z",
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

const EXCHANGE_FORMAT = 'helium-workspaces';
const EXCHANGE_VERSION = 1;
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const EXCHANGE_LIMITS = { workspaces: 500, tabs: 20000, url: 2 * 1024 * 1024, text: 10000 };

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
function buildExchange(list, pinned, extOrigin) {
  const keep = (e) => e.url && !isOwnPage(e.url, extOrigin);
  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_VERSION,
    exported: new Date().toISOString(),
    pinned: pinned.filter(keep).map((e) => ({ url: e.url, title: e.title || '' })),
    workspaces: list.map(({ ws, entries }) => {
      const groups = [];
      const ids = new Map();
      const tabs = entries
        .filter(keep)
        .map((e) => {
          const t = { url: e.url, title: e.title || '' };
          if (e.g) {
            if (!ids.has(e.g)) {
              const id = String(groups.length + 1);
              ids.set(e.g, id);
              const color = GROUP_COLORS.includes(e.gc) ? e.gc : 'grey';
              groups.push({ id, title: e.gt || '', color, collapsed: !!e.gx });
            }
            t.group = ids.get(e.g);
          }
          return t;
        });
      return { id: ws.id, name: ws.name, color: ws.color, emoji: ws.emoji || '', groups, tabs };
    }),
  };
}

// Prüft eine Export-Datei vollständig und wirft bei jedem Fehler, bevor irgendetwas
// geändert wird. Ergebnis: { exported, pinned: [{url, title}], workspaces: [{ id | null,
// name, color, emoji, groups, tabs }] }, Tabs im Sicherungsformat. Ihr Gruppenschlüssel g
// ist "<Workspace-Nr.>:<Gruppen-ID>" und muss beim Übernehmen noch eindeutig gemacht werden.
function parseExchange(text, extOrigin) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Die Datei ist kein gültiges JSON.');
  }
  const fail = (where, msg) => {
    throw new Error(where ? `${where}: ${msg}` : msg);
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, where, field, max = EXCHANGE_LIMITS.text) => {
    if (typeof v !== 'string') fail(where, `„${field}“ fehlt oder ist kein Text.`);
    if (v.length > max) fail(where, `„${field}“ ist zu lang.`);
    return v;
  };
  const optStr = (v, where, field) => (v === undefined ? '' : str(v, where, field));
  const arr = (v, where, field, optional) => {
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) fail(where, `„${field}“ fehlt oder ist keine Liste.`);
    return v;
  };
  const url = (v, where) => {
    str(v, where, 'url', EXCHANGE_LIMITS.url);
    let u;
    try {
      u = new URL(v);
    } catch {
      fail(where, `„${v.slice(0, 80)}“ ist keine gültige Adresse.`);
    }
    if (u.protocol === 'javascript:') fail(where, 'javascript:-Adressen werden nicht importiert.');
    if (isOwnPage(v, extOrigin)) fail(where, 'Seiten der Erweiterung selbst gehören nicht in die Datei.');
    return v;
  };

  if (!isObj(data) || data.format !== EXCHANGE_FORMAT) {
    fail('', 'Das ist keine Export-Datei von Helium Workspaces.');
  }
  if (!Number.isInteger(data.version) || data.version < 1) {
    fail('', 'Die Versionsnummer des Formats fehlt oder ist ungültig.');
  }
  if (data.version > EXCHANGE_VERSION) {
    fail('', `Die Datei hat Format-Version ${data.version}, diese Erweiterung kennt nur Version ${EXCHANGE_VERSION}.`);
  }
  const exported = typeof data.exported === 'string' ? data.exported : '';

  const pinned = arr(data.pinned, '', 'pinned', true).map((t, i) => {
    const where = `Angehefteter Tab ${i + 1}`;
    if (!isObj(t)) fail(where, 'Eintrag ist kein Objekt.');
    return { url: url(t.url, where), title: optStr(t.title, where, 'title') };
  });

  const list = arr(data.workspaces, '', 'workspaces');
  if (!list.length) fail('', 'Die Datei enthält keine Workspaces.');
  if (list.length > EXCHANGE_LIMITS.workspaces) fail('', 'Die Datei enthält zu viele Workspaces.');
  const wsIds = new Set();
  let total = pinned.length;
  const workspaces = list.map((w, wi) => {
    let where = `Workspace ${wi + 1}`;
    if (!isObj(w)) fail(where, 'Eintrag ist kein Objekt.');
    const name = str(w.name, where, 'name', 200).trim() || 'Workspace';
    where = `Workspace ${wi + 1} („${name}“)`;
    const color = str(w.color, where, 'color');
    if (!/^#[0-9a-f]{6}$/i.test(color)) fail(where, `„${color}“ ist keine Farbe der Form #rrggbb.`);
    const emoji = firstChar(optStr(w.emoji, where, 'emoji'));
    let id = null;
    if (w.id !== undefined) {
      id = str(w.id, where, 'id', 64);
      if (!/^[a-z0-9]+$/i.test(id)) fail(where, '„id“ darf nur Buchstaben und Ziffern enthalten.');
      if (wsIds.has(id)) fail(where, `Die ID „${id}“ kommt mehrfach vor.`);
      wsIds.add(id);
    }

    const groups = new Map();
    arr(w.groups, where, 'groups', true).forEach((g, gi) => {
      const gw = `${where}, Gruppe ${gi + 1}`;
      if (!isObj(g)) fail(gw, 'Eintrag ist kein Objekt.');
      const gid = str(g.id, gw, 'id', 64);
      if (!gid) fail(gw, '„id“ ist leer.');
      if (groups.has(gid)) fail(gw, `Die Gruppen-ID „${gid}“ kommt mehrfach vor.`);
      if (!GROUP_COLORS.includes(g.color)) fail(gw, `„${g.color}“ ist keine Gruppenfarbe (${GROUP_COLORS.join(', ')}).`);
      if (g.collapsed !== undefined && typeof g.collapsed !== 'boolean') fail(gw, '„collapsed“ muss true oder false sein.');
      groups.set(gid, { gt: optStr(g.title, gw, 'title'), gc: g.color, gx: !!g.collapsed });
    });

    const tabs = arr(w.tabs, where, 'tabs').map((t, ti) => {
      const tw = `${where}, Tab ${ti + 1}`;
      if (!isObj(t)) fail(tw, 'Eintrag ist kein Objekt.');
      const e = { url: url(t.url, tw), title: optStr(t.title, tw, 'title') };
      if (t.group !== undefined && t.group !== null) {
        const g = groups.get(t.group);
        if (!g) fail(tw, `Gruppe „${t.group}“ ist nicht unter „groups“ aufgeführt.`);
        Object.assign(e, { g: `${wi}:${t.group}` }, g);
      }
      return e;
    });
    total += tabs.length;
    if (total > EXCHANGE_LIMITS.tabs) fail('', 'Die Datei enthält zu viele Tabs.');
    return { id, name, color, emoji, groups: new Set(tabs.map((e) => e.g).filter(Boolean)).size, tabs };
  });
  return { exported, pinned, workspaces };
}
