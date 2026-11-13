'use strict';
// Popup und Importseite in einem echten Chromium (headless), bedient über das
// DevTools-Protokoll mit echten Maus- und Tastaturereignissen. Fokus, change beim
// Verlassen eines Feldes, Tab-Reihenfolge und gesperrte Schaltflächen verhalten sich
// damit wie im Browser. Die Chrome-APIs der Seite gehen an die Nachbildung aus
// fake-browser.js, Nachrichten an das unveränderte background.js darin.
//
// Läuft nur, wenn CHROME auf einen Chromium-Browser zeigt, wie test/chromium.test.js:
//
//   CHROME=/usr/bin/chromium node --test test/popup.test.js test/transfer.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const EXT_DIR = path.join(__dirname, '..', 'extension');
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Grund zum Überspringen für node:test, oder false
const skipReason = () => (process.env.CHROME ? false : 'CHROME nicht gesetzt');

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.calls = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const c = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.error) c.reject(new Error(`${c.method}: ${m.error.message}`));
        else c.resolve(m.result);
      } else {
        for (const l of this.listeners) l(m);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.calls.set(id, { method, resolve, reject }));
  }
}

class Chromium {
  static async launch() {
    const bin = process.env.CHROME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helium-workspaces-test-'));
    const proc = spawn(bin, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--no-sandbox',
      '--disable-gpu',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const url = await new Promise((resolve, reject) => {
      let err = '';
      proc.stderr.on('data', (d) => {
        err += d;
        const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      proc.on('exit', (code) => reject(new Error(`${bin} beendet (${code}):\n${err}`)));
    });
    proc.stderr.resume();
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const c = new Chromium();
    Object.assign(c, { proc, dir, ws, cdp: new Cdp(ws) });
    return c;
  }

  // Öffnet eine Seite der Erweiterung (z. B. 'popup.html') mit den APIs aus env
  async open(file, env) {
    const page = new Page(this.cdp, env);
    await page.load(pathToFileURL(path.join(EXT_DIR, file)).href);
    return page;
  }

  // Regulär beenden: Nach einem harten kill schreiben Hilfsprozesse noch ins Profil,
  // und es ließe sich nicht löschen
  async close() {
    const exited = new Promise((r) => (this.proc.exitCode !== null ? r() : this.proc.once('exit', r)));
    this.cdp.send('Browser.close').catch(() => {});
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 10000);
    await exited;
    clearTimeout(timer);
    this.ws.close();
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Ersetzt window.chrome in der Seite. Jeder Aufruf geht als JSON an __bridge (Node),
// die Antwort kommt über __reply zurück. getManifest liefert manifest.json. window.close
// schließt nicht, sondern merkt sich das.
const STUB = `(() => {
  const waiting = new Map();
  let seq = 0;
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    __bridge(JSON.stringify({ id, method, args }));
  });
  window.__reply = (id, ok, value) => {
    const w = waiting.get(id);
    waiting.delete(id);
    if (ok) w.resolve(value);
    else w.reject(new Error(value));
  };
  const api = (ns, names) => Object.fromEntries(names.map((n) => [n, (...a) => call(ns + '.' + n, a)]));
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        ...api('runtime', ['sendMessage']),
        getURL: (p) => 'chrome-extension://test/' + p,
        getManifest: () => (${fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8').trim()}),
      },
      tabs: api('tabs', ['query']),
      windows: api('windows', ['getCurrent', 'update', 'create']),
    },
  });
  window.__closed = false;
  window.close = () => { window.__closed = true; };
})();`;

const KEYS = {
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
};

class Page {
  constructor(cdp, env) {
    this.cdp = cdp;
    this.env = env;
    this.sent = []; // alle Nachrichten an die Hintergrundlogik, in Reihenfolge
    this.calls = []; // alle anderen API-Aufrufe ('windows.create' usw.)
    this.outstanding = 0;
    this.overrides = {}; // Nachrichtentyp -> Funktion(msg), ersetzt die Hintergrundlogik
  }

  send(method, params) {
    return this.cdp.send(method, params, this.session);
  }

  async load(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    this.target = targetId;
    ({ sessionId: this.session } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    this.cdp.listeners.add((m) => {
      if (m.sessionId === this.session && m.method === 'Runtime.bindingCalled') this.bridge(JSON.parse(m.params.payload));
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    // Headless hat sonst kein fokussiertes Fenster: focus() und Tab würden nichts tun
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.send('Runtime.addBinding', { name: '__bridge' });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
    const loaded = new Promise((resolve) => {
      const l = (m) => {
        if (m.sessionId !== this.session || m.method !== 'Page.loadEventFired') return;
        this.cdp.listeners.delete(l);
        resolve();
      };
      this.cdp.listeners.add(l);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await this.idle();
  }

  async bridge({ id, method, args }) {
    this.outstanding++;
    let ok = true;
    let value;
    try {
      value = plain(await this.api(method, args));
    } catch (e) {
      ok = false;
      value = String(e.message || e);
    }
    const arg = value === undefined ? 'undefined' : JSON.stringify(value);
    await this.send('Runtime.evaluate', { expression: `__reply(${id}, ${ok}, ${arg})` }).catch(() => {});
    this.outstanding--;
  }

  async api(method, args) {
    const { b, win } = this.env;
    if (method === 'runtime.sendMessage') {
      const msg = args[0];
      this.sent.push(msg);
      const own = this.overrides[msg.type];
      if (own) return own(msg);
      return this.env.w.request(msg);
    }
    this.calls.push({ method, args });
    switch (method) {
      case 'windows.getCurrent':
        return { id: win };
      case 'tabs.query':
        return b.chrome.tabs.query(args[0]);
      default:
        return undefined;
    }
  }

  // Wert eines Ausdrucks in der Seite; Promises werden abgewartet
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  // Wartet, bis keine Antwort mehr aussteht, die Seite nicht gesperrt ist und auch
  // nachgelagerte Zeitgeber (setTimeout 0) gelaufen sind
  async idle() {
    for (let calm = 0, i = 0; calm < 3; i++) {
      if (i > 500) throw new Error('Seite kommt nicht zur Ruhe');
      const busy = await this.eval('new Promise((r) => setTimeout(() => r(typeof busy === "boolean" && busy), 0))');
      calm = busy || this.outstanding ? 0 : calm + 1;
    }
  }

  // Bildschirmmitte eines Elements
  async center(selector) {
    const at = await this.eval(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      e.scrollIntoView({ block: 'nearest' });
      const r = e.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    if (!at) throw new Error(`nicht gefunden: ${selector}`);
    return at;
  }

  mouse(type, [x, y], clickCount = 1) {
    const pressed = type === 'mousePressed';
    return this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: pressed ? 1 : 0, clickCount });
  }

  // Klick mit der Maus. Zwischen Drücken und Loslassen bearbeitet die Seite, was das
  // Drücken ausgelöst hat (z. B. change des verlassenen Feldes), wie bei einem Menschen.
  // Beim Doppelklick ist auch die Aktion des ersten Klicks fertig, bevor der zweite
  // kommt: Die Sperre während der Aktion fängt ihn dann nicht ab. Mit quick kommt der
  // zweite Klick, während die Aktion des ersten noch läuft.
  async click(selector, { count = 1, quick = false } = {}) {
    const at = await this.center(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    for (let n = 1; n <= count; n++) {
      await this.mouse('mousePressed', at, n);
      await this.idle();
      await this.mouse('mouseReleased', at, n);
      if (!quick || n === count) await this.idle();
    }
  }

  dblclick(selector, { quick = false } = {}) {
    return this.click(selector, { count: 2, quick });
  }

  async press(key, { shift = false } = {}) {
    const k = KEYS[key];
    const base = { key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: shift ? 8 : 0 };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.idle();
  }

  // Ersetzt den Inhalt des fokussierten Feldes durch Tippen
  async type(text) {
    await this.eval('document.activeElement.select()');
    await this.send('Input.insertText', { text });
    await this.idle();
  }

  // data-focus des fokussierten Elements
  focused() {
    return this.eval('document.activeElement?.dataset?.focus ?? document.activeElement?.tagName');
  }

  text(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  }

  closed() {
    return this.eval('window.__closed');
  }

  // Wählt eine Datei im Dateifeld aus, wie über den Dateidialog
  async chooseFile(selector, file) {
    const { result } = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    await this.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId });
    await this.idle();
  }

  async close() {
    await this.cdp.send('Target.closeTarget', { targetId: this.target });
  }
}

module.exports = { Chromium, skipReason };
