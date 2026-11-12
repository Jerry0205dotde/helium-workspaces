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

const COLOR_NAMES = {
  '#3b82f6': 'Blau',
  '#ef4444': 'Rot',
  '#22c55e': 'Grün',
  '#f59e0b': 'Orange',
  '#a855f7': 'Lila',
  '#ec4899': 'Pink',
  '#14b8a6': 'Türkis',
  '#64748b': 'Grau',
};

// Schaltfläche mit Schlüssel, damit der Fokus das Neuzeichnen übersteht
function btn(cls, text, focusKey) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.dataset.focus = focusKey;
  return b;
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
  const detail = errorText(err);
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
// focus: Fokus-Schlüssel, die danach der Reihe nach versucht werden. Die Sperre
// nimmt allen Knöpfen den Fokus, deshalb wird er erst nach dem Entsperren gesetzt.
async function run(busyText, failText, fn, { close = false, focus } = {}) {
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
    restoreFocus(focus);
  }
}

function render(focus) {
  listEl.replaceChildren();
  state.workspaces.forEach((ws, i) => {
    const li = el('li');
    li.dataset.id = ws.id;
    if (ws.id === state.current) li.classList.add('current');
    if (ws.id === editing) li.classList.add('editing');

    const row = el('div', 'row');
    const main = btn('main', undefined, `ws:${ws.id}`);
    if (i < 9) {
      main.title = `Taste ${i + 1}`;
      main.setAttribute('aria-keyshortcuts', String(i + 1));
    }
    if (ws.id === state.current) main.setAttribute('aria-current', 'true');
    const meta = ws.elsewhere ? 'anderes Fenster' : `${ws.count} ${ws.count === 1 ? 'Tab' : 'Tabs'}`;
    const icon = badge(ws);
    icon.ariaHidden = 'true'; // der Name steht daneben
    main.append(icon, el('span', 'name', ws.name), el('span', 'meta', meta));
    main.addEventListener('click', () => switchTo(ws.id));
    row.append(main);

    const mv = btn('icon-btn', '↪', `mv:${ws.id}`);
    mv.title = 'Aktuellen Tab hierhin verschieben';
    mv.ariaLabel = `Aktuellen Tab nach „${ws.name}“ verschieben`;
    if (ws.id === state.current || !activeTabId) {
      mv.classList.add('placeholder');
      mv.disabled = true;
    }
    mv.addEventListener('click', () => {
      run('Tab wird verschoben …', 'Tab konnte nicht verschoben werden.', () =>
        send({ type: 'moveTab', tabId: activeTabId, wsId: ws.id }), { close: true });
    });
    row.append(mv);
    const ed = btn('icon-btn', '✎', `ed:${ws.id}`);
    ed.title = 'Bearbeiten';
    ed.ariaLabel = `„${ws.name}“ bearbeiten`;
    ed.ariaExpanded = String(ws.id === editing);
    ed.setAttribute('aria-controls', `editor-${ws.id}`);
    ed.addEventListener('click', () => {
      const open = editing !== ws.id;
      editing = open ? ws.id : null;
      render([open ? `name:${ws.id}` : `ed:${ws.id}`]);
    });
    row.append(ed);

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
  if (!busy) restoreFocus(focus);
}

// Fokus-Ziel als Schlüssel (data-focus), damit es Neuzeichnen und Sperre übersteht.
// focusout kennt beim Weiter-Tabben schon das neue Ziel, auch wenn es wegen der
// Sperre den Fokus gar nicht mehr bekommt.
let focusKey = null;
document.addEventListener('focusin', (e) => (focusKey = e.target.dataset?.focus ?? null));
document.addEventListener('focusout', (e) => {
  if (e.relatedTarget) focusKey = e.relatedTarget.dataset?.focus ?? null;
});

// Setzt den Fokus, wenn er durch Neuzeichnen oder Sperre verloren ging.
function restoreFocus(keys = [focusKey]) {
  if (document.activeElement && document.activeElement !== document.body) return;
  if (!keys.some(Boolean)) return;
  for (const k of keys) {
    const t = k && document.querySelector(`[data-focus="${CSS.escape(k)}"]`);
    if (t && !t.matches(':disabled')) return t.focus();
  }
  // Ziel ist weg (z. B. gelöscht): auf den aktuellen Workspace ausweichen
  const t = listEl.querySelector(`[data-focus="ws:${CSS.escape(state?.current || '')}"]`)
    || listEl.querySelector('.main');
  t?.focus();
}

// Hinweis auf Tabs, die beim Wiederherstellen nicht angelegt werden konnten
function failedNote(ws) {
  const box = el('div', 'failed');
  const n = ws.failed;
  box.append(el('span', 'failed-text', `${n} ${n === 1 ? 'Tab' : 'Tabs'} nicht wiederhergestellt`));
  const retry = btn('btn', 'Erneut versuchen', `retry:${ws.id}`);
  retry.title = ws.id === state.current ? '' : 'Wechselt in diesen Workspace';
  const dismiss = btn('btn danger', 'Verwerfen', `dismiss:${ws.id}`);
  dismiss.title = 'Fehlende Tabs aus der Sicherung entfernen';
  retry.addEventListener('click', () =>
    run('Tabs werden wiederhergestellt …', 'Tabs konnten nicht wiederhergestellt werden.', () =>
      send({ type: 'retry', windowId, wsId: ws.id }), { focus: [`retry:${ws.id}`, `ws:${ws.id}`] }));
  dismiss.addEventListener('click', (e) => {
    if (e.detail > 1) return;
    if (!dismiss.classList.contains('confirm')) {
      dismiss.classList.add('confirm');
      dismiss.textContent = 'Wirklich?';
      return;
    }
    run('Wird verworfen …', 'Tabs konnten nicht verworfen werden.', () =>
      send({ type: 'dismiss', wsId: ws.id }), { focus: [`dismiss:${ws.id}`, `ws:${ws.id}`] });
  });
  box.append(retry, dismiss);
  return box;
}

function editor(ws, index) {
  const box = el('div', 'editor');
  box.id = `editor-${ws.id}`;
  box.role = 'group';
  box.ariaLabel = `„${ws.name}“ bearbeiten`;

  const line = el('div', 'line');
  const emojiIn = el('input', 'emoji-in');
  emojiIn.dataset.focus = `emoji:${ws.id}`;
  emojiIn.placeholder = '☺';
  emojiIn.title = 'Emoji (leer = Anfangsbuchstabe)';
  emojiIn.ariaLabel = 'Emoji, leer für Anfangsbuchstaben';
  emojiIn.value = ws.emoji;
  const nameIn = el('input', 'name-in');
  nameIn.dataset.focus = `name:${ws.id}`;
  nameIn.value = ws.name;
  nameIn.maxLength = NAME_MAX;
  nameIn.placeholder = 'Name';
  nameIn.ariaLabel = 'Name';
  line.append(emojiIn, nameIn);

  const save = (patch, done, focus) =>
    run('Wird gespeichert …', 'Änderung konnte nicht gespeichert werden.', async () => {
      await send({ type: 'update', wsId: ws.id, patch });
      done?.();
    }, { focus });
  nameIn.addEventListener('change', () => save({ name: nameIn.value }));
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save({ name: nameIn.value }, () => (editing = null), [`ed:${ws.id}`]);
  });
  emojiIn.addEventListener('change', () => save({ emoji: firstChar(emojiIn.value) }));

  const sw = el('div', 'swatches');
  sw.role = 'group';
  sw.ariaLabel = 'Farbe';
  for (const c of state.colors) {
    const b = btn('swatch' + (c === ws.color ? ' sel' : ''), undefined, `color:${ws.id}:${c}`);
    b.style.background = c;
    b.title = b.ariaLabel = COLOR_NAMES[c] || c;
    b.ariaPressed = String(c === ws.color);
    b.addEventListener('click', () => save({ color: c }));
    sw.append(b);
  }

  const actions = el('div', 'actions');
  const moveBox = el('div', 'line');
  const up = btn('btn', '↑', `up:${ws.id}`);
  const down = btn('btn', '↓', `down:${ws.id}`);
  up.title = up.ariaLabel = 'Nach oben';
  down.title = down.ariaLabel = 'Nach unten';
  up.disabled = index === 0;
  down.disabled = index === state.workspaces.length - 1;
  const move = (d) => {
    const ids = state.workspaces.map((w) => w.id);
    [ids[index], ids[index + d]] = [ids[index + d], ids[index]];
    // Am Listenende wird die gedrückte Taste deaktiviert, dann zur anderen wechseln
    reorder(ids, d < 0 ? [`up:${ws.id}`, `down:${ws.id}`] : [`down:${ws.id}`, `up:${ws.id}`]);
  };
  up.addEventListener('click', () => move(-1));
  down.addEventListener('click', () => move(1));
  moveBox.append(up, down);

  const del = btn('btn danger', 'Löschen', `del:${ws.id}`);
  del.disabled = state.workspaces.length < 2;
  if (del.disabled) del.title = 'Der letzte Workspace kann nicht gelöscht werden';
  del.addEventListener('click', (e) => {
    // Der zweite Klick eines Doppelklicks bestätigt nicht.
    if (e.detail > 1) return;
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = ws.count ? `${ws.count} ${ws.count === 1 ? 'Tab' : 'Tabs'} schließen?` : 'Wirklich löschen?';
      return;
    }
    run('Workspace wird gelöscht …', 'Workspace konnte nicht gelöscht werden.', async () => {
      await send({ type: 'delete', wsId: ws.id });
      editing = null;
    });
  });
  actions.append(moveBox, del);

  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Sonst schließt Escape das ganze Popup
    e.preventDefault();
    editing = null;
    render([`ed:${ws.id}`]);
  });

  box.append(line, sw, actions);
  return box;
}

function reorder(ids, focus) {
  run('Reihenfolge wird gespeichert …', 'Reihenfolge konnte nicht geändert werden.', () =>
    send({ type: 'reorder', ids }), { focus });
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
  const focus = ['add']; // vorne das Namensfeld des neuen Workspace, sobald bekannt
  run('Workspace wird angelegt …', 'Workspace konnte nicht angelegt werden.', async () => {
    const ws = await send({ type: 'create' });
    editing = ws.id;
    focus.unshift(`name:${ws.id}`);
  }, { focus });
});

// Export und Import laufen in einem eigenen Popup-Fenster, das zu keinem Workspace gehört
document.getElementById('transfer').addEventListener('click', () =>
  run('Wird geöffnet …', 'Export und Import konnten nicht geöffnet werden.', async () => {
    const url = chrome.runtime.getURL('transfer.html');
    const [tab] = await chrome.tabs.query({ url });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    else await chrome.windows.create({ url, type: 'popup', width: 600, height: 720 });
  }, { close: true }));

// Schlüssel zum Kopieren, install.sh trägt ihn für das KWin-Skript ein
const keyValue = document.getElementById('key-value');
const keyCopy = document.getElementById('key-copy');
send({ type: 'token' }).then(
  (token) => {
    keyValue.textContent = token;
    keyCopy.disabled = false;
  },
  (e) => (keyValue.textContent = `Nicht verfügbar: ${errorText(e)}`),
);
keyCopy.addEventListener('click', () =>
  navigator.clipboard.writeText(keyValue.textContent).then(
    () => (keyCopy.textContent = 'Kopiert'),
    () => (keyCopy.textContent = 'Fehlgeschlagen'),
  ));

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
