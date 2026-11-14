// Hintergrundlogik: automatische Sicherung als Datei
//
// Workspaces und Sicherung liegen nur im Speicher der Erweiterung im Profil. Wird die
// Erweiterung entfernt oder geht das Profil kaputt, sind sie weg. Auf Wunsch legt die
// Erweiterung deshalb regelmäßig einen Export in einem Unterordner von Downloads ab und
// behält davon die letzten AUTO_KEEP.

// Option „Automatisch sichern“: alle so viele Tage, 0 = nie
const AUTO_CHOICES = [0, 1, 7];
const AUTO_KEEP = 10;
const AUTO_DIR = 'helium-workspaces';
const AUTO_PREFIX = 'helium-workspaces-auto-';
const HOUR = 3600000;

async function getAutoBackup() {
  const { autoBackup } = await chrome.storage.local.get('autoBackup');
  return AUTO_CHOICES.includes(autoBackup) ? autoBackup : 0;
}

// Ein Wecker prüft stündlich, ob eine Sicherung fällig ist. Ein Wecker im Abstand der
// Sicherung ginge verloren, wenn der Browser zu der Zeit nicht läuft.
async function scheduleAutoBackup() {
  if (!(await getAutoBackup())) return chrome.alarms.clear('autoBackup');
  if (!(await chrome.alarms.get('autoBackup'))) await chrome.alarms.create('autoBackup', { delayInMinutes: 5, periodInMinutes: 60 });
}

// Einschalten sichert gleich, damit eine Datei da ist und man sieht, wo sie liegt
async function setAutoBackup(days) {
  if (!AUTO_CHOICES.includes(days)) throw new Error(tr('autoBackupInvalid'));
  await chrome.storage.local.set({ autoBackup: days });
  await scheduleAutoBackup();
  return autoBackupIfDue(15000);
}

// Fällig, wenn seit dem letzten Versuch die eingestellten Tage vergangen sind. Eine halbe
// Stunde Spielraum, weil der Wecker nicht auf die Sekunde genau klingelt: So rutscht die
// tägliche Sicherung nicht jeden Tag eine Stunde später. Scheitert schon der Start, gilt der Versuch nicht und der
// Wecker probiert es nach einer Stunde wieder. Ein gestarteter Download zählt, auch wenn er
// später abbricht: Fragt Helium nach dem Speicherort und wird das abgebrochen, käme die
// Frage sonst jede Stunde.
// Gibt { done } zurück, ein Promise auf das Ende des Downloads. In einem Objekt, damit
// serial() nicht darauf wartet: Der Dialog zum Speicherort kann offen bleiben.
async function autoBackupIfDue(wait = 10 * 60000) {
  const days = await getAutoBackup();
  if (!days || (await getPending())) return null;
  const { autoBackupAt = 0 } = await chrome.storage.local.get('autoBackupAt');
  if (Date.now() - autoBackupAt < days * 24 * HOUR - HOUR / 2) return null;
  try {
    await pruneAutoBackups();
    const id = await startAutoBackup();
    await chrome.storage.local.set({ autoBackupAt: Date.now(), autoBackupId: id });
    await chrome.storage.local.remove('autoBackupError');
    const done = downloadDone(id, wait).then(pruneAutoBackups);
    return { done: done.catch((e) => console.warn('[workspaces] Alte Sicherungen', e)) };
  } catch (e) {
    console.warn('[workspaces] Automatische Sicherung', e);
    await chrome.storage.local.set({ autoBackupError: { at: Date.now(), message: String(e?.message || e) } });
    return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Startet den Download des Exports und gibt seine ID zurück. Ein Service Worker hat kein
// URL.createObjectURL, deshalb eine data:-URL.
async function startAutoBackup() {
  const data = await exportAll();
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return chrome.downloads.download({
    url: `data:application/json;base64,${btoa(bin)}`,
    filename: `${AUTO_DIR}/${AUTO_PREFIX}${stamp}.json`,
    conflictAction: 'uniquify',
    saveAs: false,
  });
}

// Wartet, bis der Download fertig oder abgebrochen ist, höchstens ms
function downloadDone(id, ms) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(changed);
      resolve();
    };
    const check = async () => {
      const [item] = await chrome.downloads.search({ id }).catch(() => []);
      if (item?.state !== 'in_progress') finish();
    };
    const changed = (delta) => {
      if (delta.id === id && delta.state) check();
    };
    const timer = setTimeout(finish, ms);
    chrome.downloads.onChanged.addListener(changed);
    check();
  });
}

// Stand für die Exportseite und das Popup. Ob die letzte Sicherung gelang, steht im
// Download-Verlauf; hat jemand ihn geleert, bleibt nur der Zeitpunkt.
async function autoBackupState() {
  const { autoBackupAt, autoBackupId, autoBackupError } = await chrome.storage.local.get(['autoBackupAt', 'autoBackupId', 'autoBackupError']);
  const days = await getAutoBackup();
  let last = null;
  let error = autoBackupError || null;
  if (autoBackupAt) {
    const [item] = autoBackupId === undefined ? [] : await chrome.downloads.search({ id: autoBackupId }).catch(() => []);
    last = { at: autoBackupAt, file: item?.filename || '', state: item?.state || 'unknown' };
    if (item?.state === 'interrupted' && !error) error = { at: autoBackupAt, message: tr('autoBackupInterrupted', item.error || '') };
  }
  return { days, choices: AUTO_CHOICES, keep: AUTO_KEEP, dir: AUTO_DIR, last, error: days ? error : null };
}

// Löscht die älteren automatischen Sicherungen dieser Erweiterung, die letzten AUTO_KEEP
// bleiben. Eigene Exporte und Dateien, die der Verlauf nicht mehr kennt, bleiben unberührt.
async function pruneAutoBackups() {
  const items = await chrome.downloads.search({
    filenameRegex: `[\\\\/]${AUTO_DIR}[\\\\/]${AUTO_PREFIX}[^\\\\/]*\\.json$`,
    state: 'complete',
    orderBy: ['-startTime'],
  });
  const own = items.filter((i) => i.byExtensionId === chrome.runtime.id && i.exists !== false);
  for (const i of own.slice(AUTO_KEEP)) {
    try {
      await chrome.downloads.removeFile(i.id);
      await chrome.downloads.erase({ id: i.id });
    } catch (e) {
      console.warn('[workspaces] Alte Sicherung nicht gelöscht:', i.filename, e);
    }
  }
}
