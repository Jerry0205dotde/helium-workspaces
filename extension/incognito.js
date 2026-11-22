// Inkognito (#250): Ob die Erweiterung in Inkognito-Fenstern läuft, entscheidet man unter
// chrome://extensions mit „Im Inkognitomodus zulassen“, standardmäßig aus. Ist es an, läuft
// wegen "incognito": "split" im Manifest eine zweite Instanz, die nur die Inkognito-Fenster
// sieht und dort eigene Workspaces samt Ablagen führt.
//
// storage.local und storage.session teilt diese Instanz aber mit der normalen, und
// storage.local liegt auf der Festplatte. Deshalb ersetzt diese Datei beide in der
// Inkognito-Instanz durch deren eigene IndexedDB. Die sieht die normale Instanz nicht, und
// Chromium löscht sie mit dem letzten Inkognito-Fenster: Inkognito-Tabs landen weder in der
// Sicherung des Profils noch auf der Festplatte und sind weg, wenn Inkognito endet.
//
// Jede Inkognito-Sitzung beginnt mit den Workspaces des normalen Profils, ohne deren Tabs, und
// mit dessen Schlüssel, damit das KWin-Skript auch die Inkognito-Ablagen versteckt. Änderungen
// daran bleiben in der Inkognito-Sitzung.

const INCOGNITO = !!chrome.extension?.inIncognitoContext;
// Aus dem normalen Profil übernommen, wenn eine Inkognito-Sitzung beginnt
const INCOGNITO_SEED = ['workspaces', 'token', 'muteStash', 'unloadAfter'];

// init: nur der Service Worker. Er übernimmt beim Beginn einer Inkognito-Sitzung die
// Workspaces und leert nach dem Neuladen der Erweiterung den Ersatz für storage.session.
function useIncognitoStorage(init) {
  const real = { local: chrome.storage.local, session: chrome.storage.session };
  const req = (r) => new Promise((ok, fail) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => fail(r.error))));
  const done = (tx) => new Promise((ok, fail) => ((tx.oncomplete = () => ok()), (tx.onerror = tx.onabort = () => fail(tx.error))));
  const open = () => {
    const r = indexedDB.open('incognito', 1);
    r.onupgradeneeded = () => ['local', 'session', 'meta'].forEach((s) => r.result.createObjectStore(s));
    return req(r);
  };

  async function start(db) {
    // Das Neuladen der Erweiterung leert storage.session, die IndexedDB aber nicht. Ein
    // Vermerk in storage.session zeigt, ob der Ersatz noch zu diesem Lauf gehört.
    const { incognitoRun } = await real.session.get('incognitoRun');
    const mine = await req(db.transaction('meta').objectStore('meta').get('run'));
    if (!incognitoRun || incognitoRun !== mine) {
      const run = incognitoRun || crypto.randomUUID();
      const tx = db.transaction(['session', 'meta'], 'readwrite');
      tx.objectStore('session').clear();
      tx.objectStore('meta').put(run, 'run');
      await done(tx);
      if (!incognitoRun) await real.session.set({ incognitoRun: run });
    }
    if (await req(db.transaction('meta').objectStore('meta').get('seeded'))) return;
    const seed = await real.local.get(INCOGNITO_SEED);
    const tx = db.transaction(['local', 'meta'], 'readwrite');
    for (const [k, v] of Object.entries(seed)) tx.objectStore('local').put(v, k);
    tx.objectStore('meta').put(true, 'seeded');
    await done(tx);
  }

  // Ein Promise für alle Aufrufe: So legen sie ihre Transaktionen in der Reihenfolge an, in
  // der sie kamen, und IndexedDB führt sie in dieser Reihenfolge aus wie chrome.storage.
  const ready = open().then(async (db) => {
    if (init) await start(db);
    return db;
  });
  // Ersetzt storage.onChanged für die Seiten (stash.js)
  const channel = new BroadcastChannel('incognito-storage');

  // Die Teile der chrome.storage-Schnittstelle, die die Erweiterung benutzt. Werte gehen wie
  // dort als JSON hinein, getBytesInUse fehlt (sessionUsage schätzt dann).
  const area = (name) => ({
    async get(keys) {
      const st = (await ready).transaction(name).objectStore(name);
      const out = {};
      if (keys === null || keys === undefined) {
        const [k, v] = await Promise.all([req(st.getAllKeys()), req(st.getAll())]);
        k.forEach((key, i) => (out[key] = v[i]));
      } else {
        const list = [].concat(keys);
        const v = await Promise.all(list.map((key) => req(st.get(key))));
        list.forEach((key, i) => v[i] !== undefined && (out[key] = v[i]));
      }
      return out;
    },
    async set(items) {
      const tx = (await ready).transaction(name, 'readwrite');
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        if (v === undefined) continue;
        const value = JSON.parse(JSON.stringify(v));
        tx.objectStore(name).put(value, k);
        changes[k] = { newValue: value };
      }
      await done(tx);
      channel.postMessage({ changes, name });
    },
    async remove(keys) {
      const tx = (await ready).transaction(name, 'readwrite');
      const changes = {};
      for (const k of [].concat(keys)) {
        tx.objectStore(name).delete(k);
        changes[k] = {};
      }
      await done(tx);
      channel.postMessage({ changes, name });
    },
  });

  const replace = (key, value) => Object.defineProperty(chrome.storage, key, { value, configurable: true });
  replace('local', area('local'));
  replace('session', area('session'));
  replace('onChanged', { addListener: (fn) => channel.addEventListener('message', (e) => fn(e.data.changes, e.data.name)) });
}

// Vor allen anderen Skripten, die den Speicher benutzen: im Service Worker als erstes von
// importScripts geladen, auf der Ablage-Seite vor stash.js
if (INCOGNITO) useIncognitoStorage(typeof importScripts === 'function');
