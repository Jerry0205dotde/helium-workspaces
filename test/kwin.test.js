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

function run(windows, token = TOKEN) {
  let added;
  const workspace = {
    windowList: () => windows,
    windowAdded: { connect: (f) => (added = f) },
  };
  vm.runInNewContext(SCRIPT, { workspace, readConfig: (key, def) => (key === 'token' ? token : def) });
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
