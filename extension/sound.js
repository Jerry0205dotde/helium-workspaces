// Hintergrundlogik: Ton der Ablagen

// Mit der Option „Ablagen stummschalten“ (muteStash) sind die Tabs in Ablagen stumm.
// Welche Tabs die Erweiterung dafür stummgeschaltet hat, steht in 'stashMuted', in
// storage.local, damit es das Neuladen der Erweiterung übersteht (onStartup verwirft es,
// Tab-IDs gelten nur innerhalb einer Browsersitzung). Nur diese schaltet sie wieder ein, sobald sie in einem Hauptfenster
// liegen oder die Option aus ist, und nur, solange sie noch von ihr stumm sind: Von Hand
// stummgeschaltete Tabs bleiben stumm. Läuft nach jeder Aktion und jedem Abgleich und
// kurz nachdem ein Tab außerhalb der Hauptfenster entsteht oder dorthin kommt.
const mutedByUs = (t) => !!t.mutedInfo?.muted && t.mutedInfo.reason === 'extension' && t.mutedInfo.extensionId === chrome.runtime.id;

async function syncMute() {
  try {
    const { muteStash, stashMuted = [] } = await chrome.storage.local.get(['muteStash', 'stashMuted']);
    const { stash, mains } = await scan();
    const ours = new Set(stashMuted);
    const keep = new Set();
    for (const t of muteStash ? [...stash.values()].flatMap(stashTabsOf) : []) {
      if (ours.has(t.id) && mutedByUs(t)) keep.add(t.id);
      else if (!t.mutedInfo?.muted && (await chrome.tabs.update(t.id, { muted: true }).catch(() => null))) keep.add(t.id);
    }
    for (const t of [...stash.values(), ...mains].flatMap((w) => w.tabs)) {
      if (ours.has(t.id) && !keep.has(t.id) && mutedByUs(t)) await chrome.tabs.update(t.id, { muted: false }).catch(() => {});
    }
    if (keep.size || stashMuted.length) await chrome.storage.local.set({ stashMuted: [...keep] });
  } catch (e) {
    console.warn('[workspaces] Stummschalten der Ablagen', e);
  }
}

// Öffnet ein Tab in einer Ablage einen neuen (etwa über target=_blank) oder zieht man
// einen Tab hinein, wäre der sonst bis zur nächsten Aktion hörbar
async function scheduleMute() {
  if ((await chrome.storage.local.get('muteStash')).muteStash) debounce('mute', 300, syncMute);
}

// Tabs eines Workspace, die gerade Ton abspielen (angeheftete gehören zu keinem). Chromium
// meldet audible auch für stumme Tabs, die sonst zu hören wären.
function playingOf(wsId, s, stash, mains, withStash = true) {
  const { sw, showing } = windowsOf(wsId, s, stash, mains);
  return [...showing.flatMap(movableTabsOf), ...(sw && withStash ? stashTabsOf(sw) : [])].filter((t) => t.audible);
}

const audibleOf = (wsId, s, stash, mains) => playingOf(wsId, s, stash, mains).filter((t) => !t.mutedInfo?.muted);

// Stumme Tabs, die sonst zu hören wären. Ohne die Ablage, solange die Option „Ablagen
// stummschalten“ an ist: syncMute schaltet Tabs dort gleich wieder stumm.
const silencedOf = (wsId, s, stash, mains, muteStash) =>
  playingOf(wsId, s, stash, mains, !muteStash).filter((t) => t.mutedInfo?.muted);

// Klick auf das Lautsprecher-Zeichen im Popup: bleibt stumm, bis man den Ton über 🔇 im
// Popup oder am Tab wieder einschaltet, auch nach dem Zurückholen aus der Ablage
async function muteWs(wsId) {
  const s = await sess();
  const { stash, mains } = await scan();
  for (const t of audibleOf(wsId, s, stash, mains)) await chrome.tabs.update(t.id, { muted: true });
}

// Klick auf 🔇 im Popup: gibt den stummen Tabs ihren Ton zurück
async function unmuteWs(wsId) {
  const s = await sess();
  const { stash, mains } = await scan();
  const { muteStash } = await chrome.storage.local.get('muteStash');
  for (const t of silencedOf(wsId, s, stash, mains, !!muteStash)) await chrome.tabs.update(t.id, { muted: false });
}
