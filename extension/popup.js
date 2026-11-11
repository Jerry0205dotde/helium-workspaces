const listEl = document.getElementById('list');
const addBtn = document.getElementById('add');
const controlsEl = document.getElementById('controls');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

let windowId;
let activeTabId;
let state;
let editing = null; // id des Workspace, der gerade bearbeitet wird
let busy = false; // läuft gerade eine Aktion?

const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || 'Fehler');
    return r.result;
  });

function badge(ws) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.style.background = ws.color;
  b.textContent = ws.emoji || (ws.name.trim()[0] || '?').toUpperCase();
  return b;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function load() {
  state = await send({ type: 'state', windowId });
  render();
}

function setBusy(text) {
  busy = !!text;
  controlsEl.disabled = busy;
  controlsEl.setAttribute('aria-busy', String(busy));
  document.body.classList.toggle('busy', busy);
  statusEl.textContent = text || '';
}

function showError(text, err, stale) {
  const detail = String(err?.message || err || '').replace(/^Error:\s*/, '');
  const msg = el('p', 'msg', text);
  errorEl.replaceChildren(msg);
  if (detail) errorEl.append(el('p', 'detail', detail));
  if (stale) {
    const retry = el('button', 'btn', 'Neu laden');
    retry.addEventListener('click', start);
    errorEl.append(retry);
  }
  errorEl.hidden = false;
}

// Führt eine Aktion aus: sperrt die Bedienung, zeigt Fehler an und lädt danach
// den tatsächlichen Zustand neu. Mit close schließt sich das Popup nur bei Erfolg.
async function run(busyText, failText, fn, { close = false } = {}) {
  if (busy) return;
  setBusy(busyText);
  errorEl.hidden = true;
  errorEl.replaceChildren();
  try {
    await fn();
    if (close) return window.close();
    await load();
  } catch (e) {
    const fresh = windowId !== undefined && (await load().then(() => true, () => false));
    showError(failText, e, !fresh);
  } finally {
    setBusy(null);
  }
}

function render() {
  listEl.replaceChildren();
  state.workspaces.forEach((ws, i) => {
    const li = el('li');
    li.dataset.id = ws.id;
    if (ws.id === state.current) li.classList.add('current');
    if (ws.id === editing) li.classList.add('editing');

    const row = el('div', 'row');
    row.title = i < 9 ? `Taste ${i + 1}` : '';
    row.append(badge(ws), el('span', 'name', ws.name));
    const meta = ws.elsewhere ? 'anderes Fenster' : `${ws.count} ${ws.count === 1 ? 'Tab' : 'Tabs'}`;
    row.append(el('span', 'meta', meta));

    const mv = el('button', 'icon-btn', '↪');
    mv.title = 'Aktuellen Tab hierhin verschieben';
    if (ws.id === state.current || !activeTabId) mv.classList.add('placeholder');
    mv.addEventListener('click', (e) => {
      e.stopPropagation();
      run('Tab wird verschoben …', 'Tab konnte nicht verschoben werden.', () =>
        send({ type: 'moveTab', tabId: activeTabId, wsId: ws.id }), { close: true });
    });
    row.append(mv);
    const ed = el('button', 'icon-btn', '✎');
    ed.title = 'Bearbeiten';
    ed.addEventListener('click', (e) => {
      e.stopPropagation();
      editing = editing === ws.id ? null : ws.id;
      render();
    });
    row.append(ed);

    row.addEventListener('click', () => switchTo(ws.id));
    li.append(row);
    if (ws.failed) li.append(failedNote(ws));
    if (ws.id === editing) li.append(editor(ws, i));

    // Ziehen zum Umsortieren
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', ws.id);
      li.classList.add('dragging');
    });
    row.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      const after = e.offsetY > li.offsetHeight / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-after', 'drop-before'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/plain');
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-after', 'drop-before');
      if (!from || from === ws.id) return;
      const ids = state.workspaces.map((w) => w.id).filter((id) => id !== from);
      ids.splice(ids.indexOf(ws.id) + (after ? 1 : 0), 0, from);
      reorder(ids);
    });

    listEl.append(li);
  });
}

// Hinweis auf Tabs, die beim Wiederherstellen nicht angelegt werden konnten
function failedNote(ws) {
  const box = el('div', 'failed');
  const n = ws.failed;
  box.append(el('span', 'failed-text', `${n} ${n === 1 ? 'Tab' : 'Tabs'} nicht wiederhergestellt`));
  const retry = el('button', 'btn', 'Erneut versuchen');
  retry.title = ws.id === state.current ? '' : 'Wechselt in diesen Workspace';
  const dismiss = el('button', 'btn danger', 'Verwerfen');
  dismiss.title = 'Fehlende Tabs aus der Sicherung entfernen';
  retry.addEventListener('click', () =>
    run('Tabs werden wiederhergestellt …', 'Tabs konnten nicht wiederhergestellt werden.', () =>
      send({ type: 'retry', windowId, wsId: ws.id })));
  dismiss.addEventListener('click', (e) => {
    if (e.detail > 1) return;
    if (!dismiss.classList.contains('confirm')) {
      dismiss.classList.add('confirm');
      dismiss.textContent = 'Wirklich?';
      return;
    }
    run('Wird verworfen …', 'Tabs konnten nicht verworfen werden.', () =>
      send({ type: 'dismiss', wsId: ws.id }));
  });
  box.append(retry, dismiss);
  return box;
}

function editor(ws, index) {
  const box = el('div', 'editor');

  const line = el('div', 'line');
  const emojiIn = el('input', 'emoji-in');
  emojiIn.placeholder = '☺';
  emojiIn.title = 'Emoji (leer = Anfangsbuchstabe)';
  emojiIn.value = ws.emoji;
  emojiIn.maxLength = 8;
  const nameIn = el('input', 'name-in');
  nameIn.value = ws.name;
  nameIn.placeholder = 'Name';
  line.append(emojiIn, nameIn);

  const save = (patch, done) =>
    run('Wird gespeichert …', 'Änderung konnte nicht gespeichert werden.', async () => {
      await send({ type: 'update', wsId: ws.id, patch });
      done?.();
    });
  nameIn.addEventListener('change', () => save({ name: nameIn.value }));
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save({ name: nameIn.value }, () => (editing = null));
  });
  emojiIn.addEventListener('change', () => {
    const chars = [...new Intl.Segmenter().segment(emojiIn.value.trim())].map((s) => s.segment);
    save({ emoji: chars[0] || '' });
  });

  const sw = el('div', 'swatches');
  for (const c of state.colors) {
    const b = el('button', 'swatch' + (c === ws.color ? ' sel' : ''));
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => save({ color: c }));
    sw.append(b);
  }

  const actions = el('div', 'actions');
  const moveBox = el('div', 'line');
  const up = el('button', 'btn', '↑');
  const down = el('button', 'btn', '↓');
  up.disabled = index === 0;
  down.disabled = index === state.workspaces.length - 1;
  const move = (d) => {
    const ids = state.workspaces.map((w) => w.id);
    [ids[index], ids[index + d]] = [ids[index + d], ids[index]];
    reorder(ids);
  };
  up.addEventListener('click', () => move(-1));
  down.addEventListener('click', () => move(1));
  moveBox.append(up, down);

  const del = el('button', 'btn danger', 'Löschen');
  del.disabled = state.workspaces.length < 2;
  del.addEventListener('click', (e) => {
    // Der zweite Klick eines Doppelklicks bestätigt nicht.
    if (e.detail > 1) return;
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = ws.count ? `${ws.count} Tabs schließen?` : 'Wirklich löschen?';
      return;
    }
    run('Workspace wird gelöscht …', 'Workspace konnte nicht gelöscht werden.', async () => {
      await send({ type: 'delete', wsId: ws.id });
      editing = null;
    });
  });
  actions.append(moveBox, del);

  box.append(line, sw, actions);
  setTimeout(() => nameIn.focus(), 0);
  return box;
}

function reorder(ids) {
  run('Reihenfolge wird gespeichert …', 'Reihenfolge konnte nicht geändert werden.', () =>
    send({ type: 'reorder', ids }));
}

function switchTo(id) {
  if (busy) return;
  if (id === state.current) return window.close();
  run('Workspace wird gewechselt …', 'Workspace konnte nicht gewechselt werden.', () =>
    send({ type: 'switch', windowId, wsId: id }), { close: true });
}

addBtn.addEventListener('click', (e) => {
  // Ein Doppelklick legt nur einen Workspace an.
  if (e.detail > 1) return;
  run('Workspace wird angelegt …', 'Workspace konnte nicht angelegt werden.', async () => {
    const ws = await send({ type: 'create' });
    editing = ws.id;
  });
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || !state) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && state.workspaces[n - 1]) switchTo(state.workspaces[n - 1].id);
});

function start() {
  return run('Wird geladen …', 'Workspaces konnten nicht geladen werden.', async () => {
    if (windowId === undefined) {
      const win = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
      windowId = win.id;
      activeTabId = tab?.id;
    }
  });
}

start();
