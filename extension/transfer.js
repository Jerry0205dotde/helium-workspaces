// Seite für Export und Import. Sie läuft in einem eigenen Popup-Fenster, das zu keinem
// Workspace gehört, damit ein Wechsel oder Ersetzen sie nicht selbst wegräumt.
const $ = (id) => document.getElementById(id);
const MAX_SIZE = 50 * 1024 * 1024;

let text = null; // Inhalt der gewählten Datei
let preview = null;
let busy = false;

const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || 'Fehler');
    return r.result;
  });

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const tabs = (n) => plural(n, 'Tab', 'Tabs');

function badge(ws) {
  const b = el('span', 'badge', wsLabel(ws));
  b.style.background = ws.color;
  return b;
}

function showError(text, err) {
  const box = $('error');
  box.replaceChildren(el('p', 'msg', text));
  const detail = String(err?.message || err || '').replace(/^Error:\s*/, '');
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
  run('Wird exportiert …', async () => {
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
      let msg = `${plural(data.workspaces.length, 'Workspace', 'Workspaces')} mit ${tabs(n)}`;
      if (data.pinned.length) msg += ` und ${plural(data.pinned.length, 'angeheftetem Tab', 'angehefteten Tabs')}`;
      $('export-result').textContent = `${msg} exportiert.`;
    } catch (e) {
      $('export-result').textContent = `Export fehlgeschlagen: ${String(e.message || e).replace(/^Error:\s*/, '')}`;
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
  b.textContent = 'Importieren';
  delete b.dataset.confirm;
}

const mode = () => document.querySelector('input[name=mode]:checked').value;
const closing = () => preview.current.reduce((n, w) => n + w.open, 0);

function render() {
  const p = preview;
  const total = p.workspaces.reduce((n, w) => n + w.tabs, 0);
  const groups = p.workspaces.reduce((n, w) => n + w.groups, 0);
  let s = `Die Datei ist gültig: ${plural(p.workspaces.length, 'Workspace', 'Workspaces')}, ${tabs(total)}`;
  if (groups) s += `, ${plural(groups, 'Tab-Gruppe', 'Tab-Gruppen')}`;
  if (p.pinned) s += `, ${plural(p.pinned, 'angehefteter Tab', 'angeheftete Tabs')}`;
  const date = p.exported && new Date(p.exported);
  if (date && !isNaN(date)) s += ` (exportiert am ${date.toLocaleString()})`;
  $('summary').textContent = `${s}.`;

  $('file-list').replaceChildren(
    ...p.workspaces.map((w) => {
      const li = el('li');
      let meta = tabs(w.tabs);
      if (w.groups) meta += `, ${plural(w.groups, 'Gruppe', 'Gruppen')}`;
      li.append(badge(w), el('span', 'name', w.name), el('span', 'meta', meta));
      return li;
    }),
  );

  const pinnedLine = () => {
    if (!p.pinned) return [];
    const skip = p.pinned - p.pinnedAdd;
    let t = `Angeheftete Tabs: ${p.pinnedAdd} neu`;
    if (skip) t += `, ${skip} schon vorhanden`;
    return [el('li', '', t)];
  };

  $('merge-list').replaceChildren(
    ...p.workspaces.map((w) => {
      if (!w.target) return el('li', '', `„${w.name}“ wird neu angelegt (${tabs(w.tabs)}).`);
      const why = w.target.by === 'id' ? 'derselbe Workspace' : 'gleicher Name';
      const skip = w.tabs - w.add;
      if (!w.add) return el('li', '', `„${w.target.name}“ (${why}): alle ${tabs(w.tabs)} schon vorhanden, nichts zu tun.`);
      let t = `„${w.target.name}“ (${why}) bekommt ${w.add} neue`;
      if (skip) t += `, ${skip} schon vorhanden`;
      return el('li', '', `${t}.`);
    }),
    ...pinnedLine(),
  );

  const failed = p.current.reduce((n, w) => n + w.failed, 0);
  const names = p.current.map((w) => `„${w.name}“`).join(', ');
  const rep = [
    el('li', 'warn', `Löscht ${plural(p.current.length, 'Workspace', 'Workspaces')} (${names}) und schließt ${tabs(closing())}.`),
  ];
  if (failed) rep.push(el('li', 'warn', `Verwirft ${plural(failed, 'nicht wiederhergestellten Tab', 'nicht wiederhergestellte Tabs')}.`));
  rep.push(el('li', '', `Legt ${plural(p.workspaces.length, 'Workspace', 'Workspaces')} aus der Datei neu an.`));
  rep.push(el('li', '', 'Angeheftete Tabs bleiben offen, fehlende aus der Datei kommen dazu.'));
  $('replace-list').replaceChildren(...rep);

  $('preview').hidden = false;
}

$('file').addEventListener('change', () =>
  run('Datei wird geprüft …', async () => {
    resetImport();
    $('import-result').textContent = '';
    const file = $('file').files[0];
    if (!file) return;
    try {
      if (file.size > MAX_SIZE) throw new Error('Die Datei ist zu groß.');
      text = await file.text();
      preview = await send({ type: 'importPreview', text });
      render();
    } catch (e) {
      text = null;
      showError('Diese Datei kann nicht importiert werden. Es wurde nichts geändert.', e);
    }
  }),
);

for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', resetConfirm);

$('import').addEventListener('click', (e) => {
  if (!text || e.detail > 1) return;
  const m = mode();
  const b = $('import');
  // Ersetzen schließt Tabs: erst nach einem zweiten Klick
  if (m === 'replace' && !b.dataset.confirm) {
    b.dataset.confirm = '1';
    b.className = 'btn danger';
    b.textContent = closing() ? `${tabs(closing())} schließen und ersetzen?` : 'Wirklich ersetzen?';
    return;
  }
  run('Wird importiert …', async () => {
    $('error').hidden = true;
    try {
      const r = await send({ type: 'import', text, mode: m, confirmed: m === 'replace' });
      const parts = [];
      if (r.created) parts.push(`${plural(r.created, 'Workspace', 'Workspaces')} angelegt`);
      if (r.merged) parts.push(`${plural(r.merged, 'Workspace', 'Workspaces')} ergänzt`);
      parts.push(`${tabs(r.added)} übernommen`);
      if (r.skipped) parts.push(`${r.skipped} doppelte übersprungen`);
      if (r.pinned) parts.push(`${plural(r.pinned, 'angehefteter Tab', 'angeheftete Tabs')} ergänzt`);
      if (r.removed) parts.push(`${plural(r.removed, 'alter Workspace', 'alte Workspaces')} mit ${tabs(r.closed)} entfernt`);
      let msg = `Import abgeschlossen: ${parts.join(', ')}.`;
      if (r.failed) msg += ` ${tabs(r.failed)} ließen sich nicht öffnen, sie stehen im Popup unter „nicht wiederhergestellt“.`;
      resetImport();
      $('file').value = '';
      $('import-result').textContent = msg;
    } catch (err) {
      resetConfirm();
      showError('Import fehlgeschlagen.', err);
    }
  });
});
