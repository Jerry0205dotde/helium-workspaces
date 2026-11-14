'use strict';
// Das KWin-Skript unverändert gegen eine kleine Nachbildung der KWin-Scripting-API

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'kwin', 'contents', 'code', 'main.js'), 'utf8');
const TOKEN = '3f9c0a1b2c3d4e5f60718293';

function signal() {
  const fns = [];
  return { connect: (f) => fns.push(f), emit: () => fns.forEach((f) => f()) };
}

function kwinWindow(resourceClass, caption, extra = {}) {
  return {
    resourceClass,
    caption,
    internalId: `{${resourceClass}-${caption}}`,
    normalWindow: true,
    skipTaskbar: false,
    skipSwitcher: false,
    skipPager: false,
    minimized: false,
    captionChanged: signal(),
    minimizedChanged: signal(),
    closed: signal(),
    ...extra,
  };
}

function run(windows, token = TOKEN, config = {}) {
  let added;
  const workspace = {
    windowList: () => windows,
    windowAdded: { connect: (f) => (added = f) },
  };
  const values = { token, ...config };
  vm.runInNewContext(SCRIPT, { workspace, readConfig: (key, def) => (key in values ? values[key] : def) });
  return { add: (w) => added(w) };
}

const stash = (cls) => kwinWindow(cls, `HWS-Ablage ${TOKEN} · Uni – ${cls}`);
const isHidden = (w) => w.skipTaskbar && w.skipSwitcher && w.skipPager && w.minimized;

test('Ablagen von Helium, Chrome und Chromium werden versteckt, unter X11 wie unter Wayland', () => {
  // X11-Fensterklassen wie gemessen und Wayland-App-IDs
  const classes = ['helium', 'Google-chrome', 'google-chrome', 'Chromium-browser', 'chromium-browser', 'Chromium', 'chromium'];
  const windows = classes.map(stash);
  const k = run(windows.slice(0, 3));
  for (const w of windows.slice(3)) k.add(w);
  for (const w of windows) assert.ok(isHidden(w), `${w.resourceClass}: Ablage nicht versteckt`);
});

test('Andere Programme, fremde Schlüssel und Dialoge bleiben sichtbar', () => {
  const windows = [
    stash('firefox'),
    stash('konsole'),
    kwinWindow('google-chrome', 'HWS-Ablage 000000000000000000000000 · Uni'),
    kwinWindow('chromium', 'HWS-Ablage  · Uni'),
    kwinWindow('google-chrome', `HWS-Ablage ${TOKEN} · Uni`, { normalWindow: false }),
    kwinWindow('google-chrome', 'Neuer Tab – Google Chrome'),
  ];
  run(windows);
  for (const w of windows) assert.ok(!w.skipTaskbar && !w.minimized, `${w.resourceClass} „${w.caption}“ versteckt`);
});

test('Ohne Schlüssel in kwinrc wird nichts versteckt', () => {
  const w = stash('google-chrome');
  run([w], '');
  assert.ok(!w.skipTaskbar && !w.minimized);
});

test('Ohne Schlüssel holt das Skript alle versteckten Ablagen zurück (install.sh --uninstall)', () => {
  const helium = stash('helium');
  const chrome = stash('google-chrome');
  run([helium, chrome]);
  assert.ok(isHidden(helium) && isHidden(chrome));
  // install.sh --uninstall löscht den Schlüssel und lädt das Skript neu, die Erweiterung markiert weiter
  const k = run([helium, chrome], '');
  for (const w of [helium, chrome]) assert.ok(!w.skipTaskbar && !w.skipSwitcher && !w.skipPager, `${w.resourceClass} bleibt versteckt`);
  // Auch eine Ablage, die erst danach markiert wird, bleibt sichtbar
  const later = stash('chromium');
  k.add(later);
  later.captionChanged.emit();
  assert.ok(!later.skipTaskbar && !later.minimized);
});

test('Verliert eine Chrome-Ablage die Markierung, kommt sie zurück in die Taskleiste', () => {
  const w = stash('google-chrome');
  run([w]);
  assert.ok(isHidden(w));
  w.caption = 'Neuer Tab – Google Chrome';
  w.captionChanged.emit();
  assert.ok(!w.skipTaskbar && !w.skipSwitcher && !w.skipPager);
  // Wieder markiert, z. B. nach dem Neuladen der Erweiterung
  w.caption = `HWS-Ablage ${TOKEN} · Uni`;
  w.captionChanged.emit();
  assert.ok(isHidden(w));
});

test('Die Browserliste aus kwinrc ersetzt die Standardliste', () => {
  const brave = stash('Brave-browser');
  const flatpak = stash('com.brave.Browser');
  const helium = stash('helium');
  const chrome = stash('google-chrome');
  run([brave, flatpak, helium, chrome], TOKEN, { browsers: ' Helium, brave-browser,,com.brave.browser ' });
  assert.ok(isHidden(brave) && isHidden(flatpak) && isHidden(helium));
  assert.ok(!chrome.skipTaskbar && !chrome.minimized, 'google-chrome steht nicht in der Liste');
});

test('Ohne oder mit leerer Browserliste gilt die Standardliste', () => {
  for (const browsers of [undefined, '']) {
    const chrome = stash('google-chrome');
    const brave = stash('brave-browser');
    run([chrome, brave], TOKEN, browsers === undefined ? {} : { browsers });
    assert.ok(isHidden(chrome), `browsers=${browsers}: Chrome nicht versteckt`);
    assert.ok(!brave.skipTaskbar && !brave.minimized, `browsers=${browsers}: Brave versteckt`);
  }
});

test('Fällt ein Browser aus der Liste, kommen seine versteckten Ablagen zurück in die Taskleiste', () => {
  const brave = stash('brave-browser');
  run([brave], TOKEN, { browsers: 'helium,brave-browser' });
  assert.ok(isHidden(brave));
  // install.sh --browsers '' lädt das Skript mit der Standardliste neu, das Fenster bleibt bestehen
  run([brave], TOKEN, { browsers: '' });
  assert.ok(!brave.skipTaskbar && !brave.skipSwitcher && !brave.skipPager);
});

test('Ändert sich der Schlüssel, kommen die mit dem alten Schlüssel versteckten Ablagen zurück', () => {
  const helium = stash('helium');
  const brave = stash('brave-browser');
  run([helium, brave], TOKEN, { browsers: 'helium,brave-browser' });
  assert.ok(isHidden(helium) && isHidden(brave));
  // install.sh trägt einen neuen Schlüssel ein und lädt das Skript neu; die Fenster tragen noch den alten.
  // Brave fällt dabei zugleich aus der Liste.
  run([helium, brave], 'ffffffffffffffffffffffff');
  for (const w of [helium, brave]) assert.ok(!w.skipTaskbar && !w.skipSwitcher && !w.skipPager, `${w.resourceClass} bleibt versteckt`);
});
