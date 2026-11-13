// Gemeinsame Helfer der Seiten (Popup, Export und Import). Braucht i18n.js und label.js.

// Nachricht an die Hintergrundlogik; deren Fehler kommt als Error zurück
const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || tr('error'));
    return r.result;
  });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Farbiges Zeichen eines Workspace
function badge(ws) {
  const b = el('span', 'badge', wsLabel(ws));
  b.style.background = ws.color;
  return b;
}

// Fehlermeldung ohne das vorangestellte „Error:“
const errorText = (err) => String(err?.message || err || '').replace(/^Error:\s*/, '');
