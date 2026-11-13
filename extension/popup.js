const listEl = document.getElementById('list');
const addBtn = document.getElementById('add');
const controlsEl = document.getElementById('controls');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const backupErrorEl = document.getElementById('backup-error');
const muteStashEl = document.getElementById('mute-stash');
const undoEl = document.getElementById('undo');

let windowId;
let activeTabId;
let marked = 1; // Anzahl der markierten Tabs, ↪ verschiebt sie alle
let state;
let editing = null; // id des Workspace, der gerade bearbeitet wird
let busy = false; // läuft gerade eine Aktion?

localize();
listEl.ariaLabel = tr('extName');

const COLOR_NAMES = {
  '#3b82f6': tr('colorBlue'),
  '#ef4444': tr('colorRed'),
  '#22c55e': tr('colorGreen'),
  '#f59e0b': tr('colorOrange'),
  '#a855f7': tr('colorPurple'),
  '#ec4899': tr('colorPink'),
  '#14b8a6': tr('colorTeal'),
  '#64748b': tr('colorGray'),
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
    const retry = el('button', 'btn', tr('reload'));
    retry.addEventListener('click', start);
    errorEl.append(retry);
  }
  errorEl.hidden = false;
}

// Führt eine Aktion aus: sperrt die Bedienung, zeigt Fehler an und lädt danach
// den tatsächlichen Zustand neu. Mit close schließt sich das Popup nur bei Erfolg.
// focus: Fokus-Schlüssel, die danach der Reihe nach versucht werden. Die Sperre
// nimmt allen Knöpfen den Fokus, deshalb wird er erst nach dem Entsperren gesetzt.
// Ergibt true, wenn die Aktion gelungen ist. Ein verlassenes Feld, das noch aufs
// Speichern wartet, wird zuerst gespeichert; misslingt das, unterbleibt die Aktion.
async function run(busyText, failText, fn, { close = false, focus } = {}) {
  if (pending && !(await flush())) return false;
  if (busy) return false;
  setBusy(busyText);
  errorEl.hidden = true;
  errorEl.replaceChildren();
  try {
    await fn();
    if (close) return window.close();
    await load();
    return true;
  } catch (e) {
    const fresh = windowId !== undefined && (await load().then(() => true, () => false));
    showError(failText, e, !fresh);
    return false;
  } finally {
    setBusy(null);
    restoreFocus(focus);
  }
}

// Hinweis, solange die Sicherung nicht gespeichert werden kann
function renderBackupError() {
  const e = state.backupError;
  backupErrorEl.hidden = !e;
  if (!e) return backupErrorEl.replaceChildren();
  const since = new Date(e.since).toLocaleString(tr('lang'), { dateStyle: 'short', timeStyle: 'short' });
  backupErrorEl.replaceChildren(
    el('p', 'msg', tr('backupFailingSince', since)),
    el('p', null, tr('backupFailingHint')),
    el('p', 'detail', errorText(e.message)),
  );
}

// Wie lange ein Workspace nicht gezeigt sein muss, bis seine Tabs entladen werden
const unloadEl = document.getElementById('unload');
const unloadLabel = (m) => (!m ? tr('unloadNever') : m < 60 ? tr('unloadMinutes', m) : m === 60 ? tr('unloadHour') : tr('unloadHours', m / 60));

function renderUnload() {
  unloadEl.replaceChildren(...state.unloadChoices.map((m) => {
    const o = el('option', null, unloadLabel(m));
    o.value = String(m);
    return o;
  }));
  unloadEl.value = String(state.unloadAfter);
}

unloadEl.addEventListener('change', () => {
  const minutes = Number(unloadEl.value);
  run(tr('saving'), tr('settingFailed'), () => send({ type: 'unloadAfter', minutes }), { focus: ['unload'] });
});

// „Rückgängig“ für die zuletzt gelöschten Workspaces
function renderUndo() {
  const names = state.deleted;
  undoEl.hidden = !names;
  if (!names) return undoEl.replaceChildren();
  const text = names.length === 1 ? tr('deletedOne', names[0]) : tr('deletedMany', plural(names.length, 'workspaces'));
  const undo = btn('btn', tr('undo'), 'undo');
  undo.title = tr('undoTitle');
  undo.addEventListener('click', () => {
    const focus = ['undo'];
    run(tr('undoing'), tr('undoFailed'), async () => {
      const id = await send({ type: 'undoDelete' });
      if (id) focus.unshift(`ws:${id}`);
    }, { focus });
  });
  const hide = btn('btn', '✕', 'forget');
  hide.title = hide.ariaLabel = tr('forgetDeleted');
  hide.addEventListener('click', () =>
    run(tr('discarding'), tr('forgetFailed'), () => send({ type: 'forgetDeleted' })));
  const label = el('span', 'undo-text', text);
  label.title = names.join(', ');
  undoEl.replaceChildren(label, undo, hide);
}

function render(focus) {
  renderBackupError();
  renderUndo();
  muteStashEl.checked = state.muteStash;
  renderUnload();
  listEl.replaceChildren();
  state.workspaces.forEach((ws, i) => {
    const li = el('li');
    li.dataset.id = ws.id;
    if (ws.id === state.current) li.classList.add('current');
    if (ws.id === editing) li.classList.add('editing');

    const row = el('div', 'row');
    const main = btn('main', undefined, `ws:${ws.id}`);
    if (i < 9) {
      main.title = tr('keyN', i + 1);
      main.setAttribute('aria-keyshortcuts', String(i + 1));
    }
    if (ws.id === state.current) main.setAttribute('aria-current', 'true');
    const meta = ws.elsewhere ? tr('otherWindow') : plural(ws.count, 'tabs');
    const icon = badge(ws);
    icon.ariaHidden = 'true'; // der Name steht daneben
    main.append(icon, el('span', 'name', ws.name), el('span', 'meta', meta));
    main.addEventListener('click', () => switchTo(ws.id));
    row.append(main);

    if (ws.audible) {
      const snd = btn('icon-btn sound', '🔊', `snd:${ws.id}`);
      snd.title = tr('muteTitle');
      snd.ariaLabel = tr('muteLabel', ws.name);
      snd.addEventListener('click', () =>
        run(tr('muting'), tr('muteFailed'), () =>
          send({ type: 'mute', wsId: ws.id }), { focus: [`ws:${ws.id}`] }));
      row.append(snd);
    }

    const mv = btn('icon-btn', '↪', `mv:${ws.id}`);
    const many = marked > 1;
    mv.title = many ? tr('moveTabsTitle', marked) : tr('moveTabTitle');
    mv.ariaLabel = many ? tr('moveTabsLabel', marked, ws.name) : tr('moveTabLabel', ws.name);
    if (ws.id === state.current || !activeTabId) {
      mv.classList.add('placeholder');
      mv.disabled = true;
    }
    mv.addEventListener('click', () => {
      run(many ? tr('movingTabs') : tr('movingTab'), many ? tr('moveTabsFailed') : tr('moveTabFailed'), () =>
        send({ type: 'moveTab', tabId: activeTabId, wsId: ws.id }), { close: true });
    });
    row.append(mv);
    const ed = btn('icon-btn', '✎', `ed:${ws.id}`);
    ed.title = tr('edit');
    ed.ariaLabel = tr('editLabel', ws.name);
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

// Felder speichern beim Verlassen. Verlässt man eines mit einem Klick, wartet das
// Speichern, bis der Klick ausgelöst ist: Sperre und Neuzeichnen würden ihn sonst
// verschlucken. Die Aktion des Klicks speichert das Feld dann zuerst (siehe run),
// sonst geschieht es gleich nach dem Klick.
let pressed = false;
let pending = null; // wartendes Speichern eines verlassenen Feldes
document.addEventListener('pointerdown', () => (pressed = true), true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    pressed = false;
    setTimeout(flush); // erst nach dem click, den der Klick noch auslöst
  }, true);
}

function saveOnLeave(save) {
  if (pressed) pending = save;
  else save();
}

// Führt das wartende Speichern aus; ergibt true, wenn nichts wartet oder es gelang
async function flush() {
  const save = pending;
  pending = null;
  return !save || save();
}

// Erster Klick fragt nach, der zweite führt aus. Ein Doppelklick bestätigt nicht.
// Zeichnet ein wartendes Speichern die Liste neu, fragt die neue Schaltfläche nach.
function confirmFirst(b, question, act) {
  b.addEventListener('click', async (e) => {
    if (e.detail > 1) return;
    if (b.classList.contains('confirm')) return act();
    if (pending && !(await flush())) return;
    const t = b.isConnected ? b : document.querySelector(`[data-focus="${CSS.escape(b.dataset.focus)}"]`);
    if (!t || t.disabled) return;
    t.classList.add('confirm');
    t.textContent = question;
  });
}

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
  box.append(el('span', 'failed-text', plural(n, 'tabsNotRestored')));
  const retry = btn('btn', tr('retry'), `retry:${ws.id}`);
  retry.title = ws.id === state.current ? '' : tr('retryTitle');
  const dismiss = btn('btn danger', tr('discard'), `dismiss:${ws.id}`);
  dismiss.title = tr('discardTitle');
  retry.addEventListener('click', () =>
    run(tr('restoring'), tr('restoreFailed'), () =>
      send({ type: 'retry', windowId, wsId: ws.id }), { focus: [`retry:${ws.id}`, `ws:${ws.id}`] }));
  confirmFirst(dismiss, tr('confirm'), () =>
    run(tr('discarding'), tr('discardFailed'), () =>
      send({ type: 'dismiss', wsId: ws.id }), { focus: [`dismiss:${ws.id}`, `ws:${ws.id}`] }));
  box.append(retry, dismiss);
  return box;
}

function editor(ws, index) {
  const box = el('div', 'editor');
  box.id = `editor-${ws.id}`;
  box.role = 'group';
  box.ariaLabel = tr('editLabel', ws.name);

  const line = el('div', 'line');
  const emojiIn = el('input', 'emoji-in');
  emojiIn.dataset.focus = `emoji:${ws.id}`;
  emojiIn.placeholder = '☺';
  emojiIn.title = tr('emojiTitle');
  emojiIn.ariaLabel = tr('emojiLabel');
  emojiIn.value = ws.emoji;
  const nameIn = el('input', 'name-in');
  nameIn.dataset.focus = `name:${ws.id}`;
  nameIn.value = ws.name;
  nameIn.maxLength = NAME_MAX;
  nameIn.placeholder = nameIn.ariaLabel = tr('name');
  line.append(emojiIn, nameIn);

  const save = (patch, done, focus) =>
    run(tr('saving'), tr('saveFailed'), async () => {
      await send({ type: 'update', wsId: ws.id, patch });
      done?.();
    }, { focus });
  nameIn.addEventListener('change', () => saveOnLeave(() => save({ name: nameIn.value })));
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save({ name: nameIn.value }, () => (editing = null), [`ed:${ws.id}`]);
  });
  emojiIn.addEventListener('change', () => saveOnLeave(() => save({ emoji: firstChar(emojiIn.value) })));

  const sw = el('div', 'swatches');
  sw.role = 'group';
  sw.ariaLabel = tr('color');
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
  up.title = up.ariaLabel = tr('moveUp');
  down.title = down.ariaLabel = tr('moveDown');
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

  const del = btn('btn danger', tr('delete'), `del:${ws.id}`);
  del.disabled = state.workspaces.length < 2;
  if (del.disabled) del.title = tr('deleteLastTitle');
  const question = ws.count ? plural(ws.count, 'closeTabs') : tr('confirmDelete');
  confirmFirst(del, question, () =>
    run(tr('deleting'), tr('deleteFailed'), async () => {
      await send({ type: 'delete', wsId: ws.id });
      editing = null;
    }, { focus: ['undo'] }));
  actions.append(moveBox, del);

  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Sonst schließt Escape das ganze Popup
    e.preventDefault();
    editing = null;
    // Das Neuzeichnen entfernt ein geändertes Feld, dessen change dann speichert.
    // Der Fokus soll auch danach auf ✎ landen.
    focusKey = `ed:${ws.id}`;
    render([`ed:${ws.id}`]);
  });

  box.append(line, sw, actions);
  return box;
}

function reorder(ids, focus) {
  run(tr('reordering'), tr('reorderFailed'), () =>
    send({ type: 'reorder', ids }), { focus });
}

async function switchTo(id) {
  if (busy) return;
  if (id === state.current) {
    if (await flush()) window.close();
    return;
  }
  run(tr('switching'), tr('switchFailed'), () =>
    send({ type: 'switch', windowId, wsId: id }), { close: true });
}

addBtn.addEventListener('click', (e) => {
  // Ein Doppelklick legt nur einen Workspace an.
  if (e.detail > 1) return;
  const focus = ['add']; // vorne das Namensfeld des neuen Workspace, sobald bekannt
  run(tr('creating'), tr('createFailed'), async () => {
    const ws = await send({ type: 'create' });
    editing = ws.id;
    focus.unshift(`name:${ws.id}`);
  }, { focus });
});

// Export und Import laufen in einem eigenen Popup-Fenster, das zu keinem Workspace gehört
document.getElementById('transfer').addEventListener('click', () =>
  run(tr('opening'), tr('openTransferFailed'), async () => {
    const url = chrome.runtime.getURL('transfer.html');
    const [tab] = await chrome.tabs.query({ url });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    else await chrome.windows.create({ url, type: 'popup', width: 600, height: 720 });
  }, { close: true }));

// Den Wert vorher festhalten: Speichert run() zuerst ein verlassenes Feld, setzt dessen
// Neuzeichnen die Checkbox auf den alten Stand zurück
muteStashEl.addEventListener('change', () => {
  const on = muteStashEl.checked;
  run(tr('saving'), tr('settingFailed'), () =>
    send({ type: 'muteStash', on }), { focus: ['mute-stash'] });
});

// Zeigt, welcher Stand nach git pull und Neuladen wirklich läuft
document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

// Fertiger Befehl zum Kopieren, install.sh trägt den Schlüssel für das KWin-Skript ein
const keyValue = document.getElementById('key-value');
const keyCopy = document.getElementById('key-copy');
send({ type: 'token' }).then(
  (token) => {
    keyValue.textContent = `./install.sh ${token}`;
    keyCopy.disabled = false;
  },
  (e) => (keyValue.textContent = tr('keyUnavailable', errorText(e))),
);
keyCopy.addEventListener('click', () =>
  navigator.clipboard.writeText(keyValue.textContent).then(
    () => (keyCopy.textContent = tr('copied')),
    () => (keyCopy.textContent = tr('copyFailed')),
  ));

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !state) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return moveSelection(e);
  const n = Number(e.key);
  if (n >= 1 && n <= 9 && state.workspaces[n - 1]) switchTo(state.workspaces[n - 1].id);
});

// ↑ / ↓ wählt in der Liste den vorherigen oder nächsten Workspace aus, Enter wechselt
// dorthin. Ohne Auswahl geht es vom aktuellen Workspace aus; am Ende geht es oben
// weiter. Im Editor bleiben die Pfeiltasten unberührt.
function moveSelection(e) {
  if (busy || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const row = e.target.closest?.('.row');
  if (e.target !== document.body && !row) return;
  const mains = [...listEl.querySelectorAll('.main')];
  if (!mains.length) return;
  e.preventDefault();
  const from = row ? row.querySelector('.main') : listEl.querySelector('li.current .main');
  const i = mains.indexOf(from);
  const step = e.key === 'ArrowDown' ? 1 : -1;
  const next = i < 0 ? (step > 0 ? 0 : mains.length - 1) : (i + step + mains.length) % mains.length;
  mains[next].focus();
}

function start() {
  return run(tr('loading'), tr('loadFailed'), async () => {
    if (windowId === undefined) {
      const win = await chrome.windows.getCurrent();
      const tabs = await chrome.tabs.query({ highlighted: true, windowId: win.id });
      const tab = tabs.find((t) => t.active);
      windowId = win.id;
      activeTabId = tab?.id;
      if (tab) marked = tabs.length;
    }
  });
}

start();
