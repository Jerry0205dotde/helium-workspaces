# Mitmachen

[English](./CONTRIBUTING.md) · **Deutsch** · [Zurück zur README](./README.de.md)

## Testen

```bash
node --test test/*.test.js
```

Braucht nur Node.js ab Version 22, keinen Browser und kein KWin. Die Tests laden `background.js` samt der Dateien, die es lädt, unverändert in eine Nachbildung der Chrome-APIs und spielen damit Wechsel mit Gruppen und angehefteten Tabs, mehrere Fenster, Neustarts mit und ohne Sitzungswiederherstellung, das Neuladen der Erweiterung, gezielt scheiternde API-Aufrufe, schnell aufeinanderfolgende Änderungen sowie Export und Import samt Zusammenführen und Ersetzen durch. Dazu kommen Syntax, Manifest und KWin-Metadaten, außerdem läuft das KWin-Skript gegen eine Nachbildung der KWin-API und zeigt, welche Fenster es versteckt. `install.sh` läuft gegen Nachbildungen der KDE-Befehle: die Installation samt dem Hinweis auf die Starteinstellung, die Prüfung auf fehlende Programme, mehrere Schlüssel, `--help`, `--remove`, `--uninstall` und `--update`, das dabei mit echtem `git` aus einem Test-Repository holt. Die Meldungen von `install.sh` werden auf Deutsch und Englisch geprüft. Dieselben Prüfungen laufen in der CI bei jedem Pull Request.

ESLint prüft, dass jeder Name, den die Erweiterung und das KWin-Skript benutzen, definiert ist, auch in Zweigen, die kein Test nimmt. Skripte, die sich einen globalen Gültigkeitsbereich teilen (der Service Worker mit allem, was `background.js` lädt, jede Seite mit ihren `<script>`-Tags), werden zusammen geprüft, siehe [`eslint.config.js`](./eslint.config.js). Die CI führt das aus, lokal braucht `npx` dafür Netzzugang:

```bash
npx eslint@10.14.0 extension kwin
```

Ändert sich etwas in `extension/`, muss die Version in [`manifest.json`](./extension/manifest.json) höher sein als auf `main`, sonst schlägt `static.test.js` fehl. Die Version steht unten rechts im Popup, so sieht man nach einem Update, ob der neue Stand läuft. Das KWin-Skript trägt in [`metadata.json`](./kwin/metadata.json) dieselbe Version, auch das prüft `static.test.js`, und `install.sh` nennt sie am Ende. Verglichen wird mit `origin/main`, mit `VERSION_BASE` lässt sich eine andere Ref angeben. Fehlt die Ref, wird die Prüfung übersprungen.

Landet eine höhere Version auf `main`, setzt [`tag.yml`](./.github/workflows/tag.yml) auf diesen Commit das Tag `v<Version>`, zum Beispiel `v0.2.0`, und legt dazu ein [Release](https://github.com/Jerry0205dotde/helium-workspaces/releases) an, das die PRs seit der vorigen Version auflistet.

Mit einem Chromium-Browser laufen die wichtigsten Abläufe zusätzlich in einem echten Browser:

```bash
CHROME=/usr/bin/chromium node --test test/chromium.test.js
```

[`chromium.test.js`](./test/chromium.test.js) installiert die Erweiterung in ein frisches Profil und spielt durch: Wechsel mit Tab-Gruppe und angeheftetem Tab, ohne dass eine Seite neu lädt, Neuladen der Erweiterung, Beenden und Neustart mit „Dort weitermachen, wo ich aufgehört habe“ und mit „Neuer Tab“ sowie Schließen per X und Neustart. Ein zweiter Test spielt den Umstieg auf die feste Erweiterungs-ID durch: Installation ohne `key`, Export, Neuladen mit `key` und Import mit **Ersetzen**, ohne dass eine Seite neu lädt. Ohne `CHROME` werden die Tests übersprungen, ohne Bildschirm bleibt der Browser unsichtbar. In der CI laufen sie mit Chrome for Testing.

Mit demselben `CHROME` laufen auch [`popup.test.js`](./test/popup.test.js) und [`transfer.test.js`](./test/transfer.test.js): Popup und Importseite in einem headless Chromium, bedient mit echten Maus- und Tastaturereignissen. Geprüft wird das Verlassen eines Feldes per Klick, <kbd>Tab</kbd>, <kbd>Enter</kbd> und <kbd>Esc</kbd>, Nachfragen und Doppelklicks. Die Nachrichten der Seiten gehen an die Nachbildung der Chrome-APIs, nicht an eine installierte Erweiterung.

KWin prüfen die Tests nicht. Nach Änderungen daran kurz von Hand:

1. Die Erweiterung unter `chrome://extensions` neu laden und `./install.sh` mit dem Schlüssel aus dem Popup ausführen.
2. Zwei Workspaces einrichten und ein paar Mal hin und her wechseln: Kein Ablage-Fenster taucht in Taskleiste, <kbd>Alt</kbd>+<kbd>Tab</kbd> oder Übersicht auf.
3. Die Erweiterung unter `chrome://extensions` neu laden: Nach etwa einer Sekunde sind die Ablage-Fenster wieder versteckt.
4. Helium beenden und neu starten: Die Ablage-Fenster bleiben versteckt.

## Aufbau

- [`extension/`](./extension): die Erweiterung (Manifest V3)
  - [`background.js`](./extension/background.js): der Service Worker, nimmt Ereignisse und Nachrichten entgegen und lädt die übrige Hintergrundlogik:
    [`core.js`](./extension/core.js) (Grundlagen), [`switch.js`](./extension/switch.js) (Wechseln), [`backup.js`](./extension/backup.js) (Sicherung),
    [`restore.js`](./extension/restore.js) (Wiederherstellen aus der Sicherung), [`reconcile.js`](./extension/reconcile.js) (Abgleich nach Neustart),
    [`workspaces.js`](./extension/workspaces.js), [`export-import.js`](./extension/export-import.js), [`autobackup.js`](./extension/autobackup.js) (automatische Sicherung als Datei), [`unload.js`](./extension/unload.js) (Entladen),
    [`sound.js`](./extension/sound.js) (Ton), [`icons.js`](./extension/icons.js) (Symbole) und [`menus.js`](./extension/menus.js) (Kontextmenü)
  - [`popup.html`](./extension/popup.html) / [`popup.js`](./extension/popup.js): die Workspace-Liste
  - [`transfer.html`](./extension/transfer.html) / [`transfer.js`](./extension/transfer.js): Export und Import, [`exchange.js`](./extension/exchange.js): das Dateiformat und seine Prüfung
  - [`stash.html`](./extension/stash.html) / [`stash.js`](./extension/stash.js): die Seite, die ein Fenster als Ablage markiert
  - [`label.js`](./extension/label.js): das Zeichen im Symbol eines Workspace
- [`kwin/`](./kwin): KWin-Skript, das die Ablage-Fenster versteckt
- [`docs/`](./docs): die ausführliche Doku und die Bilder der README
- [`install.sh`](./install.sh): KWin-Skript einrichten und den Schlüssel eintragen, mit `--remove` einen Schlüssel austragen, mit `--update` aktualisieren, mit `--uninstall` wieder entfernen
- [`test/`](./test): automatische Tests, [`fake-browser.js`](./test/fake-browser.js) bildet die Chrome-APIs nach, [`page.js`](./test/page.js) bedient Popup und Importseite in Chromium, [`chromium.js`](./test/chromium.js) steuert einen echten Chromium
