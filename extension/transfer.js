// Seite für Export und Import. Sie läuft in einem eigenen Popup-Fenster, das zu keinem
// Workspace gehört, damit ein Wechsel oder Ersetzen sie nicht selbst wegräumt.
const $ = (id) => document.getElementById(id);
const MAX_SIZE = 50 * 1024 * 1024;

let text = null; // Inhalt der gewählten Datei
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
  for (const b of document.querySelectorAll('button, input')) b.disabled = true;
  $('status').textContent = statusText;
  try {
    await fn();
  } finally {
    busy = false;
    for (const b of document.querySelectorAll('button, input')) b.disabled = false;
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

// ---------------------------------------------------------------- Import

function resetImport() {
  text = null;
  preview = null;
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
const closing = () => preview.current.reduce((n, w) => n + w.open, 0);

function render() {
  const p = preview;
  const total = p.workspaces.reduce((n, w) => n + w.tabs, 0);
  const groups = p.workspaces.reduce((n, w) => n + w.groups, 0);
  const parts = [plural(p.workspaces.length, 'workspaces'), tabs(total)];
  if (groups) parts.push(plural(groups, 'tabGroups'));
  if (p.pinned) parts.push(plural(p.pinned, 'pinnedTabs'));
  const date = p.exported && new Date(p.exported);
  $('summary').textContent = date && !isNaN(date)
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
      if (r.removed) parts.push(tr('resRemoved', plural(r.removed, 'oldWorkspaces'), tabs(r.closed)));
      const msg = r.failed ? tr('importDoneFailed', parts.join(', '), tabs(r.failed)) : tr('importDone', parts.join(', '));
      resetImport();
      $('file').value = '';
      $('import-result').textContent = msg;
    } catch (err) {
      resetConfirm();
      showError(tr('importFailed'), err);
    }
  });
});
