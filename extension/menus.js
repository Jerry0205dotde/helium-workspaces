// Hintergrundlogik: Kontextmenü „Tab in Workspace verschieben“, wenn der Tab in einer
// Gruppe ist, „Gruppe in Workspace verschieben“ und auf Links „Link in Workspace öffnen“

const MENUS = { link: tr('menuLink'), move: tr('menuMove'), group: tr('menuGroup') };

// Rechtsklick auf einen Tab in der Tab-Leiste, erst ab Chrome 150; ältere Versionen lehnen den
// unbekannten Kontext ab (#309). Eigene Einträge, weil der rechtsgeklickte Tab nicht der aktive
// sein muss, nach dem updateMenus Titel und Gruppe richtet: Der Titel nennt keine Anzahl, und
// „Gruppe in Workspace verschieben“ steht immer da und tut außerhalb einer Gruppe nichts.
// Für den Kopf einer Gruppe gibt es keinen Kontext
const TAB_CONTEXT = chrome.contextMenus.ContextType?.TAB;
if (TAB_CONTEXT) Object.assign(MENUS, { tabMove: tr('menuTabMove'), tabGroup: tr('menuGroup') });

// Auf Links, Bildern, Videos und markiertem Text ebenso wie auf einer freien Stelle der
// Seite und am Symbol der Erweiterung; verschoben wird immer der Tab, nicht der Link.
// Den Link selbst öffnet nur „Link in Workspace öffnen“, das es nur auf Links gibt.
const CONTEXTS = ['page', 'frame', 'selection', 'link', 'editable', 'image', 'video', 'audio', 'action'];
const contextsOf = (kind) => (kind === 'link' ? ['link'] : kind.startsWith('tab') ? [TAB_CONTEXT] : CONTEXTS);

async function buildMenus() {
  const cfg = await getConfig();
  // Nur die eigenen Wurzeleinträge samt Untereinträgen: removeAll() entfernt auch die
  // Einträge der anderen Instanz, Profil oder Inkognito (#287)
  await Promise.all(Object.keys(MENUS).map((kind) => chrome.contextMenus.remove(kind).catch(() => {})));
  for (const [kind, title] of Object.entries(MENUS)) {
    chrome.contextMenus.create({ id: kind, title, contexts: contextsOf(kind), visible: kind !== 'group' });
    for (const ws of cfg.workspaces) {
      chrome.contextMenus.create({
        id: `${kind}:${ws.id}`,
        parentId: kind,
        title: `${ws.emoji ? ws.emoji + ' ' : ''}${ws.name}`,
        contexts: contextsOf(kind),
      });
    }
  }
  shownMenus = { title: MENUS.move, visible: false };
  await updateMenus();
}

// Zuletzt gesetzter Stand der Menüs; nach einem Neustart des Service Workers unbekannt
let shownMenus = {};

// Passt die Menüs an den aktiven Tab an: Anzahl der markierten Tabs, Gruppe ja oder nein.
// Geändert wird nur, was sich vom zuletzt gesetzten Stand unterscheidet.
async function updateMenus() {
  try {
    const tabs = await chrome.tabs.query({ lastFocusedWindow: true, highlighted: true });
    const active = tabs.find((t) => t.active);
    const n = active ? tabs.length : 1;
    const title = n > 1 ? tr('menuMoveMarked', n) : MENUS.move;
    const visible = !!active && active.groupId >= 0;
    if (shownMenus.title !== title) {
      await chrome.contextMenus.update('move', { title });
      shownMenus.title = title;
    }
    if (shownMenus.visible !== visible) {
      await chrome.contextMenus.update('group', { visible });
      shownMenus.visible = visible;
    }
  } catch {
    // Das Menü wird gerade neu gebaut, buildMenus ruft das danach selbst auf
  }
}

// Gebündelt und nach der laufenden Aktion: Verschiebt die Erweiterung selbst Tabs, käme
// sonst je Tab eine Abfrage (#299)
const scheduleMenus = () => debounce('menus', 100, updateMenus);

chrome.tabs.onHighlighted.addListener(() => scheduleMenus());
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) scheduleMenus();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.groupId !== undefined) scheduleMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  const kind = id.slice(0, id.indexOf(':'));
  const wsId = id.slice(kind.length + 1);
  if (!wsId || !Object.hasOwn(MENUS, kind)) return;
  if (kind === 'link') {
    // Nichts aus privaten Fenstern in die normalen Workspaces (und ihre Sicherung) übernehmen
    // und keine Seiten der Erweiterung, etwa eine zweite Ablage-Seite
    const url = info.linkUrl;
    if (!url || !!tab?.incognito !== INCOGNITO || isOwnPage(url, chrome.runtime.getURL(''))) return;
    userAction(() => openLinkInWs(url, wsId, tab?.windowId));
    return;
  }
  const group = kind === 'group' || kind === 'tabGroup';
  if (kind === 'tabGroup' && !(tab?.groupId >= 0)) return;
  if (tab) userAction(() => moveTabToWs(tab.id, wsId, group));
});
