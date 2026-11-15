// Seite für Export und Import. Sie läuft in einem eigenen Popup-Fenster, das zu keinem
// Workspace gehört, damit ein Wechsel oder Ersetzen sie nicht selbst wegräumt.
const $ = (id) => document.getElementById(id);
const MAX_SIZE = 50 * 1024 * 1024;

let text = null; // Inhalt der gewählten Datei oder des früheren Stands
let earlierAt = null; // Zeitpunkt des gewählten früheren Stands, sonst eine Datei
let preview = null;
let busy = false;

const tabs = (n) => plural(n, 'tabs');

localize();

function showError(text, err) {
  const box = $('error');
  box.replaceChildren(el('p', 'msg', text));
  const detail = errorText(err);
  if (detail) box.append(el('p', 'detail', detail));
  box.hidden = false;
}

async function run(statusText, fn) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll('button, input, select')) b.disabled = true;
  $('status').textContent = statusText;
  try {
    await fn();
  } finally {
    busy = false;
    for (const b of document.querySelectorAll('button, input, select')) b.disabled = false;
    $('status').textContent = '';
  }
}

// ---------------------------------------------------------------- Export

$('export').addEventListener('click', () =>
  run(tr('exporting'), async () => {
    $('export-result').textContent = '';
    try {
      const data = await send({ type: 'export' });
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `helium-workspaces-${data.exported.slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      const n = data.workspaces.reduce((s, w) => s + w.tabs.length, 0);
      const wss = plural(data.workspaces.length, 'workspaces');
      $('export-result').textContent = data.pinned.length
        ? tr('exportDonePinned', wss, tabs(n), plural(data.pinned.length, 'pinnedTabsDative'))
        : tr('exportDone', wss, tabs(n));
    } catch (e) {
      $('export-result').textContent = tr('exportFailed', errorText(e));
    }
  }),
);

// ---------------------------------------------------------------- Automatische Sicherung

const when = (t) => new Date(t).toLocaleString(tr('lang'), { dateStyle: 'short', timeStyle: 'short' });
const autoLabel = (d) => (!d ? tr('autoNever') : d === 1 ? tr('autoDaily') : tr('autoWeekly'));

function renderAuto(a) {
  $('auto-text').textContent = tr('autoText', a.dir, a.keep);
  $('auto').replaceChildren(...a.choices.map((d) => {
    const o = el('option', null, autoLabel(d));
    o.value = String(d);
    return o;
  }));
  $('auto').value = String(a.days);
  const last = a.last;
  $('auto-info').textContent = !last ? ''
    : last.state === 'complete' ? tr('autoLast', when(last.at), last.file)
    : last.state === 'in_progress' ? tr('autoPending', when(last.at))
    : tr('autoLastAt', when(last.at));
  const box = $('auto-error');
  box.hidden = !a.error;
  box.replaceChildren(...(a.error ? [el('p', 'msg', tr('autoFailed', when(a.error.at))), el('p', 'detail', errorText(a.error.message))] : []));
}

$('auto').addEventListener('change', () => {
  const days = Number($('auto').value);
  run(tr('saving'), async () => {
    try {
      renderAuto(await send({ type: 'autoBackup', days }));
    } catch (e) {
      await send({ type: 'autoBackupState' }).then(renderAuto, () => {});
      $('auto-info').textContent = `${tr('settingFailed')} ${errorText(e)}`;
    }
  });
});

send({ type: 'autoBackupState' }).then(renderAuto, (e) => ($('auto-info').textContent = errorText(e)));

// ---------------------------------------------------------------- Import

function resetImport() {
  text = null;
  earlierAt = null;
  preview = null;
  for (const li of document.querySelectorAll('#earlier-list li')) li.classList.remove('chosen');
  $('preview').hidden = true;
  $('error').hidden = true;
  $('error').replaceChildren();
  resetConfirm();
}

function resetConfirm() {
  const b = $('import');
  b.className = 'btn primary';
  b.textContent = tr('importButton');
  delete b.dataset.confirm;
}

const mode = () => document.querySelector('input[name=mode]:checked').value;
// Offene Tabs, die Ersetzen schließt; die in übernommenen Fenstern bleiben (keep)
const closing = () => preview.current.reduce((n, w) => n + w.open, 0) - (preview.keep || 0);

function settingText({ key, value }) {
  if (key === 'muteStash') return tr('settingValue', tr('muteStash'), value ? tr('settingOn') : tr('settingOff'));
  if (key === 'unloadAfter') return tr('settingValue', tr('unloadAfter'), unloadLabel(value));
  return tr('settingValue', tr('autoHeading'), autoLabel(value));
}

function render() {
  const p = preview;
  const total = p.workspaces.reduce((n, w) => n + w.tabs, 0);
  const groups = p.workspaces.reduce((n, w) => n + w.groups, 0);
  const parts = [plural(p.workspaces.length, 'workspaces'), tabs(total)];
  if (groups) parts.push(plural(groups, 'tabGroups'));
  if (p.pinned) parts.push(plural(p.pinned, 'pinnedTabs'));
  const date = p.exported && new Date(p.exported);
  $('summary').textContent = earlierAt
    ? tr('earlierSummary', when(earlierAt), parts.join(', '))
    : date && !isNaN(date)
    ? tr('fileValidDate', parts.join(', '), date.toLocaleString(tr('lang')))
    : tr('fileValid', parts.join(', '));

  $('file-list').replaceChildren(
    ...p.workspaces.map((w) => {
      const li = el('li');
      let meta = tabs(w.tabs);
      if (w.groups) meta += `, ${plural(w.groups, 'groups')}`;
      li.append(badge(w), el('span', 'name', w.name), el('span', 'meta', meta));
      return li;
    }),
  );

  const pinnedLine = () => {
    if (!p.pinned) return [];
    const skip = p.pinned - p.pinnedAdd;
    return [el('li', '', skip ? tr('pinnedPlanSkip', p.pinnedAdd, skip) : tr('pinnedPlan', p.pinnedAdd))];
  };

  // Die Einstellungen gelten bei beiden Arten. Genannt werden die, die sich ändern.
  const changed = p.settings.filter((s) => s.changed).map(settingText);
  $('settings').hidden = !p.settings.length;
  $('settings').textContent = changed.length ? tr('settingsPlan', changed.join(', ')) : tr('settingsSame');

  $('merge-list').replaceChildren(
    ...p.workspaces.map((w) => {
      if (!w.target) return el('li', '', tr('mergeNew', w.name, tabs(w.tabs)));
      const name = w.target.name;
      const why = w.target.by === 'id' ? tr('mergeById') : tr('mergeByName');
      const skip = w.tabs - w.add;
      if (!w.add) return el('li', '', tr('mergeNothing', name, why, tabs(w.tabs)));
      return el('li', '', skip ? tr('mergeAddSkip', name, why, w.add, skip) : tr('mergeAdd', name, why, w.add));
    }),
    ...pinnedLine(),
  );

  const failed = p.current.reduce((n, w) => n + w.failed, 0);
  const names = p.current.map((w) => tr('quoted', w.name)).join(', ');
  const rep = [
    el('li', 'warn', tr('replaceDelete', plural(p.current.length, 'workspaces'), names, tabs(closing()))),
  ];
  if (failed) rep.push(el('li', 'warn', tr('replaceDiscard', plural(failed, 'notRestoredTabs'))));
  rep.push(el('li', '', tr('replaceCreate', plural(p.workspaces.length, 'workspaces'))));
  if (p.keep) rep.push(el('li', '', tr('replaceKeep', tabs(p.keep))));
  rep.push(el('li', '', tr('replacePinned')));
  rep.push(el('li', '', tr('replaceUndo')));
  $('replace-list').replaceChildren(...rep);

  $('preview').hidden = false;
}

$('file').addEventListener('change', () =>
  run(tr('checkingFile'), async () => {
    resetImport();
    $('import-result').textContent = '';
    const file = $('file').files[0];
    if (!file) return;
    try {
      if (file.size > MAX_SIZE) throw new Error(tr('fileTooLarge'));
      text = await file.text();
      preview = await send({ type: 'importPreview', text });
      render();
    } catch (e) {
      text = null;
      showError(tr('fileRejected'), e);
    }
  }),
);

// Frühere Stände (#189): Einer wird wie eine Datei geprüft und eingespielt, vorgewählt
// ist Ersetzen.
function renderEarlier(list) {
  $('earlier').hidden = !list.length;
  $('earlier-list').replaceChildren(
    ...list.map((e) => {
      const li = el('li');
      li.dataset.at = String(e.at);
      const parts = [plural(e.workspaces, 'workspaces'), tabs(e.tabs)];
      if (e.pinned) parts.push(plural(e.pinned, 'pinnedTabs'));
      const b = el('button', 'btn', tr('earlierButton'));
      b.addEventListener('click', () => chooseEarlier(e.at));
      li.append(el('span', 'name', when(e.at)), el('span', 'meta', parts.join(', ')), b);
      return li;
    }),
  );
}

function chooseEarlier(at) {
  run(tr('checkingEarlier'), async () => {
    resetImport();
    $('file').value = '';
    $('import-result').textContent = '';
    try {
      text = await send({ type: 'earlierText', at });
      preview = await send({ type: 'importPreview', text });
      earlierAt = at;
      $('earlier-list').querySelector(`li[data-at="${at}"]`)?.classList.add('chosen');
      document.querySelector('input[name=mode][value=replace]').checked = true;
      render();
    } catch (e) {
      text = null;
      showError(tr('earlierRejected'), e);
    }
  });
}

send({ type: 'earlier' }).then(renderEarlier, () => {});

for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', resetConfirm);

$('import').addEventListener('click', (e) => {
  if (!text || e.detail > 1) return;
  const m = mode();
  const b = $('import');
  // Ersetzen schließt Tabs: erst nach einem zweiten Klick. Die Nachfrage nennt den Stand
  // von jetzt, seit der Vorschau können Tabs oder Workspaces dazugekommen sein.
  if (m === 'replace' && !b.dataset.confirm) {
    run(tr('checkingCurrent'), async () => {
      $('error').hidden = true;
      try {
        preview = await send({ type: 'importPreview', text });
      } catch (err) {
        showError(tr('fileRejected'), err);
        return;
      }
      render();
      b.dataset.confirm = '1';
      b.className = 'btn danger';
      b.textContent = closing() ? tr('confirmReplaceTabs', tabs(closing())) : tr('confirmReplace');
    }).then(() => b.focus());
    return;
  }
  run(tr('importing'), async () => {
    $('error').hidden = true;
    try {
      const r = await send({ type: 'import', text, mode: m, confirmed: m === 'replace' });
      const parts = [];
      if (r.created) parts.push(tr('resCreated', plural(r.created, 'workspaces')));
      if (r.merged) parts.push(tr('resMerged', plural(r.merged, 'workspaces')));
      parts.push(tr('resAdded', tabs(r.added)));
      if (r.skipped) parts.push(tr('resSkipped', r.skipped));
      if (r.pinned) parts.push(tr('resPinned', plural(r.pinned, 'pinnedTabs')));
      if (r.settings) parts.push(tr('resSettings', plural(r.settings, 'settings')));
      if (r.removed) parts.push(tr('resRemoved', plural(r.removed, 'oldWorkspaces'), tabs(r.closed)));
      if (r.kept) parts.push(tr('resKept', tabs(r.kept)));
      const msg = r.failed ? tr('importDoneFailed', parts.join(', '), tabs(r.failed)) : tr('importDone', parts.join(', '));
      resetImport();
      $('file').value = '';
      $('import-result').textContent = msg;
      // Die Datei kann „Automatisch sichern“ geändert haben, die Auswahl oben zeigt sonst den alten Wert
      if (r.settings) await send({ type: 'autoBackupState' }).then(renderAuto, () => {});
    } catch (err) {
      resetConfirm();
      showError(tr('importFailed'), err);
    }
  });
});
