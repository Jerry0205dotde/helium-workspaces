'use strict';
// Startet einen echten Chromium mit der Erweiterung und steuert ihn über das DevTools-
// Protokoll (--remote-debugging-pipe, ohne Abhängigkeiten). Die Erweiterung wird über
// ihren Service Worker bedient: Dort laufen dieselben Funktionen wie bei einer
// Nachricht aus dem Popup, und dort werden Fenster, Tabs und Speicher abgefragt.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXT = path.join(__dirname, '..', 'extension');

// ID einer entpackt geladenen Erweiterung: SHA-256 des Pfads, Hex-Ziffern als a–p
const EXT_ID = [...crypto.createHash('sha256').update(fs.realpathSync(EXT)).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wiederholt fn, bis es nicht mehr wirft. Wirft nach timeout den letzten Fehler.
async function waitFor(fn, { timeout = 20000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (e.final || Date.now() > end) throw e;
    }
    await sleep(interval);
  }
}

// restore: 'last' = „Dort weitermachen, wo ich aufgehört habe“, 'newtab' = „Neuer Tab“.
// Der Entwicklermodus ist an wie bei jedem, der die Erweiterung entpackt lädt; ohne ihn
// deaktiviert Chromium sie beim Neuladen.
function setPrefs(profile, restore) {
  const file = path.join(profile, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  prefs.session = { ...prefs.session, restore_on_startup: restore === 'last' ? 1 : 5 };
  prefs.extensions = { ...prefs.extensions, ui: { ...prefs.extensions?.ui, developer_mode: true } };
  fs.writeFileSync(file, JSON.stringify(prefs));
}

class Chromium {
  constructor(bin, profile) {
    this.bin = bin;
    this.profile = profile;
  }

  // Startet den Browser mit dem Profil. Beim ersten Start wird die Erweiterung wie über
  // „Entpackte Erweiterung laden“ installiert, danach lädt Chromium sie beim Start aus dem
  // Profil, vor der Sitzungswiederherstellung, wie bei einer normalen Installation.
  // (--load-extension lädt sie dagegen erst nach den Fenstern und nur für einen Start.)
  async launch({ restore = 'last' } = {}) {
    setPrefs(this.profile, restore);
    const args = [
      `--user-data-dir=${this.profile}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      // Ubuntu ab 23.10 (auch die CI) erlaubt die Sandbox ohne Zusatzrechte nicht;
      // geladen werden nur die eigenen Testseiten von 127.0.0.1
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--window-size=1200,800',
    ];
    // Ohne Bildschirm unsichtbar, aber sonst wie ein normaler Browser (anders als
    // --headless beendet er sich z. B., wenn das letzte Fenster geschlossen wird)
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=headless');
    const proc = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.log = '';
    proc.stderr.on('data', (d) => (this.log = (this.log + d).slice(-200000)));
    this.exited = new Promise((r) => proc.once('exit', (code, sig) => r({ code, sig })));
    this.exited.then(() => this.fail('Browser beendet'));
    this.id = 0;
    this.pending = new Map();
    this.errors ??= [];
    this.worker = null;
    proc.stdio[3].on('error', () => {});
    let buf = Buffer.alloc(0);
    proc.stdio[4].on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let i; (i = buf.indexOf(0)) >= 0; buf = buf.subarray(i + 1)) this.receive(JSON.parse(buf.subarray(0, i).toString('utf8')));
    });
    await this.send('Target.setDiscoverTargets', { discover: true });
    if (!this.installed) {
      const { id } = await this.send('Extensions.loadUnpacked', { path: EXT });
      if (id !== EXT_ID) throw new Error(`unerwartete Erweiterungs-ID ${id}`);
      this.installed = true;
    }
    await this.attachWorker();
  }

  receive(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method === 'Target.detachedFromTarget' && msg.params.sessionId === this.worker?.sessionId) {
      this.worker.detached = true;
    } else if (msg.method === 'Runtime.exceptionThrown' && msg.sessionId === this.worker?.sessionId) {
      // Unbehandelte Fehler im Service Worker
      this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      if (this.proc.exitCode !== null || this.proc.signalCode) return reject(new Error(`${method}: Browser beendet`));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: keine Antwort nach ${timeout} ms`));
      }, timeout);
      const done = (fn) => (v) => (clearTimeout(timer), fn(v));
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
      this.proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }

  fail(why) {
    for (const { reject, method } of this.pending.values()) reject(new Error(`${method}: ${why}`));
    this.pending.clear();
  }

  // Verbindet sich mit dem Service Worker der Erweiterung, nach dem Neuladen mit dem
  // neuen, sobald die Verbindung zum alten getrennt ist
  async attachWorker() {
    const target = await waitFor(async () => {
      const { targetInfos } = await this.send('Target.getTargets');
      if (this.worker && !this.worker.detached && targetInfos.some((x) => x.targetId === this.worker.targetId)) {
        throw new Error('alter Service Worker läuft noch');
      }
      const t = targetInfos.find((x) => x.type === 'service_worker' && x.url === `chrome-extension://${EXT_ID}/background.js`);
      if (!t) throw new Error('Service Worker der Erweiterung nicht gefunden');
      return t;
    });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.worker = { targetId: target.targetId, sessionId };
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  // Wertet expr (async-Funktionsrumpf) im Service Worker aus und gibt das Ergebnis zurück
  async sw(body, ...args) {
    const expression = `(async (...args) => { ${body} })(...${JSON.stringify(args)})`;
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.worker.sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  // Wie das Popup: dieselbe Aktion, die runtime.onMessage für diese Nachricht ausführt
  action(code, ...args) {
    return this.sw(`return userAction(() => (${code})(...args));`, ...args);
  }

  // Beenden wie über das Menü
  async quit() {
    this.send('Browser.close').catch(() => {});
    await this.waitExit();
  }

  // Beenden, ohne den Browser darum zu bitten, etwa nach dem Schließen des letzten Fensters
  async waitExit(timeout = 20000) {
    const r = await Promise.race([this.exited, sleep(timeout).then(() => null)]);
    if (!r) {
      this.proc.kill('SIGKILL');
      await this.exited;
      throw new Error(`Browser hat sich nach ${timeout / 1000} s nicht beendet`);
    }
    if (r.code !== 0) throw new Error(`Browser endete mit ${r.sig || `Code ${r.code}`}`);
    return r;
  }

  // Am Ende: beenden, notfalls hart
  async kill() {
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      this.send('Browser.close').catch(() => {});
      await this.waitExit(5000).catch(() => {});
    }
  }
}

module.exports = { Chromium, EXT_ID, waitFor, sleep };
