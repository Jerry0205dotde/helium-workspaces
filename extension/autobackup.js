// Hintergrundlogik: automatische Sicherung als Datei
//
// Workspaces und Sicherung liegen nur im Speicher der Erweiterung im Profil. Wird die
// Erweiterung entfernt oder geht das Profil kaputt, sind sie weg. Auf Wunsch schreibt die
// Erweiterung deshalb regelmäßig einen Export in einen eigenen Ordner außerhalb von Downloads
// und Browserprofil und behält davon die letzten AUTO_KEEP. Erweiterungen selbst können nur in
// Downloads schreiben, deshalb schreibt native-host.sh, den install.sh als
// Native-Messaging-Host anmeldet (#221). Jedes Profil bekommt einen eigenen Unterordner, benannt
// nach seinem Schlüssel aus ensureToken: Profile und Browser überschreiben sich so nicht
// gegenseitig (#215). Darin gibt es AUTO_KEEP feste Dateinamen, die reihum überschrieben werden.

// Option „Automatisch sichern“: alle so viele Tage, 0 = nie
const AUTO_CHOICES = [0, 1, 7];
const AUTO_KEEP = 10;
// Wo native-host.sh die Sicherungen ablegt, wenn XDG_DATA_HOME nicht gesetzt ist. Nach der
// ersten Sicherung zeigt die Exportseite den tatsächlichen Ordner.
const AUTO_DIR = '~/.local/share/helium-workspaces/backups/';
// So lange darf native-host.sh für eine Sicherung brauchen
const AUTO_TIMEOUT = 60000;
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
  return autoBackupIfDue();
}

// Fällig, wenn seit der letzten Sicherung die eingestellten Tage vergangen sind. Eine halbe
// Stunde Spielraum, weil der Wecker nicht auf die Sekunde genau klingelt: So rutscht die
// tägliche Sicherung nicht jeden Tag eine Stunde später. Scheitert sie, probiert es der
// Wecker nach einer Stunde wieder.
// Gibt { done } zurück, ein Promise auf das Ende des Schreibens. In einem Objekt, damit
// serial() nicht darauf wartet: Wechsel sollen nicht auf native-host.sh warten. Der Export
// selbst entsteht innerhalb von serial(), damit er einen stimmigen Stand zeigt.
// force sichert auch, wenn noch nichts fällig ist (siehe autoBackupNow).
let autoWriting = null;
async function autoBackupIfDue(force = false) {
  const days = await getAutoBackup();
  if (!days || autoWriting || (await getPending())) return null;
  const { autoBackupAt = 0, autoBackupCount = 0 } = await chrome.storage.local.get(['autoBackupAt', 'autoBackupCount']);
  if (!force && Date.now() - autoBackupAt < days * 24 * HOUR - HOUR / 2) return null;
  let msg;
  try {
    msg = await autoBackupMessage((autoBackupCount % AUTO_KEEP) + 1);
  } catch (e) {
    await autoBackupFailed(e);
    return null;
  }
  autoWriting = writeAutoBackup(msg, autoBackupCount).finally(() => (autoWriting = null));
  return { done: autoWriting };
}

// „Jetzt sichern“ neben der Fehlermeldung im Popup. Sonst käme nach einer gescheiterten
// Sicherung die nächste erst nach dem eingestellten Abstand, bei wöchentlicher also nach
// einer Woche.
const autoBackupNow = () => autoBackupIfDue(true);

// Die Nachricht an native-host.sh: Nummer der Datei, Unterordner des Profils und der Export
// in Base64, so braucht der Host keinen JSON-Parser. Das Datum steht in der Datei (exported).
async function autoBackupMessage(slot) {
  const data = await exportAll();
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { at: Date.parse(data.exported), msg: { backup: slot, profile: await ensureToken(), data: btoa(bin) } };
}

async function writeAutoBackup({ at, msg }, count) {
  let timer;
  try {
    const r = await Promise.race([
      chrome.runtime.sendNativeMessage(NATIVE_HOST, msg),
      new Promise((resolve, reject) => (timer = setTimeout(() => reject(new Error(tr('autoBackupTimeout'))), AUTO_TIMEOUT))),
    ]);
    if (!r?.ok) throw new Error(r?.error === 'write' ? tr('autoBackupWriteFailed', r.file || '') : tr('autoBackupHostFailed', r?.error || ''));
    await chrome.storage.local.set({ autoBackupAt: at, autoBackupFile: r.file, autoBackupCount: count + 1 });
    // autoBackupId: Download-ID aus Fassungen, die nach Downloads gesichert haben
    await chrome.storage.local.remove(['autoBackupError', 'autoBackupId']);
  } catch (e) {
    await autoBackupFailed(/native messaging host not found/i.test(e?.message) ? new Error(tr('autoBackupNoHost')) : e);
  } finally {
    clearTimeout(timer);
  }
}

async function autoBackupFailed(e) {
  console.warn('[workspaces] Automatische Sicherung', e);
  await chrome.storage.local.set({ autoBackupError: { at: Date.now(), message: String(e?.message || e) } });
}

// Stand für die Exportseite und das Popup. dir ist der Ordner der letzten Sicherung, vor der
// ersten der, in den sie ohne XDG_DATA_HOME käme.
async function autoBackupState() {
  const { autoBackupAt, autoBackupFile, autoBackupError, token } = await chrome.storage.local.get(['autoBackupAt', 'autoBackupFile', 'autoBackupError', 'token']);
  const days = await getAutoBackup();
  const dir = autoBackupFile ? autoBackupFile.replace(/[^/]*$/, '') : `${AUTO_DIR}${token || ''}${token ? '/' : ''}`;
  const last = autoBackupAt ? { at: autoBackupAt, file: autoBackupFile || '' } : null;
  return { days, choices: AUTO_CHOICES, keep: AUTO_KEEP, dir, last, error: days ? autoBackupError || null : null };
}
