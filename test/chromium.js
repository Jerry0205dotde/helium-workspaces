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

// ID einer entpackt geladenen Erweiterung: SHA-256 des öffentlichen Schlüssels aus dem
// Manifest, ohne Schlüssel des Pfads, Hex-Ziffern als a–p
function extIdOf(dir) {
  const { key } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const src = key ? Buffer.from(key, 'base64') : fs.realpathSync(dir);
  return [...crypto.createHash('sha256').update(src).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}
const EXT_ID = extIdOf(EXT);

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

// Flag in creation_flags, das nur Extensions.loadUnpacked setzt (ohne es 38 wie über
// „Entpackte Erweiterung laden“). Damit entfernt Chromium die Erweiterung beim nächsten
// Start, als wäre sie nur für diesen Start geladen; erst ein Neuladen installiert sie ohne
// das Flag neu (#241).
const DEVTOOLS_FLAG = 1 << 15;

// restore: 'last' = „Dort weitermachen, wo ich aufgehört habe“, 'newtab' = „Neuer Tab“.
// Der Entwicklermodus ist an wie bei jedem, der die Erweiterung entpackt lädt; ohne ihn
// deaktiviert Chromium sie beim Neuladen.
function setPrefs(profile, restore, extId) {
  const file = path.join(profile, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  prefs.session = { ...prefs.session, restore_on_startup: restore === 'last' ? 1 : 5 };
  prefs.extensions = { ...prefs.extensions, ui: { ...prefs.extensions?.ui, developer_mode: true } };
  // Downloads (die automatische Sicherung) landen im Testprofil, ohne Rückfrage
  prefs.download = { ...prefs.download, default_directory: path.join(profile, 'Downloads'), prompt_for_download: false };
  // Die Installation aus dem letzten Start bleibt wie eine über die Oberfläche, ohne dass
  // die Erweiterung dafür neu geladen wird
  const ext = prefs.extensions.settings?.[extId];
  if (ext?.creation_flags & DEVTOOLS_FLAG) ext.creation_flags &= ~DEVTOOLS_FLAG;
  fs.writeFileSync(file, JSON.stringify(prefs));
}

class Chromium {
  // ext: Ordner der Erweiterung. Ändert sich ihre ID (Schlüssel im Manifest ergänzt), vor
  // attachWorker() extId neu setzen.
  constructor(bin, profile, ext = EXT) {
    this.bin = bin;
    this.profile = profile;
    this.ext = ext;
    this.extId = extIdOf(ext);
    // Umgebung des Browsers, die auch ein Native-Messaging-Host bekommt
    this.env = process.env;
  }

  // Startet den Browser mit dem Profil. Beim ersten Start wird die Erweiterung wie über
  // „Entpackte Erweiterung laden“ installiert, danach lädt Chromium sie beim Start aus dem
  // Profil, vor der Sitzungswiederherstellung, wie bei einer normalen Installation.
  // (--load-extension lädt sie dagegen erst nach den Fenstern und nur für einen Start.)
  async launch({ restore = 'last' } = {}) {
    setPrefs(this.profile, restore, this.extId);
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
    const proc = spawn(this.bin, args, { env: this.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
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
      const { id } = await this.send('Extensions.loadUnpacked', { path: this.ext });
      if (id !== this.extId) throw new Error(`unerwartete Erweiterungs-ID ${id}`);
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
  // neuen, sobald die Verbindung zum alten getrennt ist. Der alte kann noch kurz in der
  // Liste stehen, nachdem die Verbindung getrennt ist, und hat dieselbe Adresse.
  async attachWorker() {
    const old = this.worker?.targetId;
    const target = await waitFor(async () => {
      const { targetInfos } = await this.send('Target.getTargets');
      if (this.worker && !this.worker.detached && targetInfos.some((x) => x.targetId === old)) {
        throw new Error('alter Service Worker läuft noch');
      }
      const t = targetInfos.find((x) => x.type === 'service_worker' && x.targetId !== old && x.url === `chrome-extension://${this.extId}/background.js`);
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

  // Führt fn mit einer DevTools-Sitzung der Seite mit dieser Adresse aus
  async withPage(url, fn) {
    const t = await waitFor(async () => {
      const { targetInfos } = await this.send('Target.getTargets');
      const x = targetInfos.find((i) => i.type === 'page' && i.url === url);
      if (!x) throw new Error(`keine Seite mit ${url}`);
      return x;
    });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    try {
      return await fn(sessionId);
    } finally {
      await this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  // Wertet expression in der Seite aus
  inPage(url, expression) {
    return this.withPage(url, (s) => this.send('Runtime.evaluate', { expression }, s));
  }

  // Zahl der Einträge im Verlauf der Seite
  historyOf(url) {
    return this.withPage(url, async (s) => (await this.send('Page.getNavigationHistory', {}, s)).entries.length);
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

module.exports = { Chromium, EXT, EXT_ID, extIdOf, waitFor, sleep };
