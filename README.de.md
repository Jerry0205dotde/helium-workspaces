# Helium Workspaces

[English](./README.md) · **Deutsch**

Helium Workspaces bringt Arbeitsbereiche wie in Opera in den [Helium-Browser](https://github.com/imputnet/helium-linux): mehrere Tab-Sätze im selben Fenster, umschaltbar per Klick oder Tastenkürzel. Beim Wechseln wird nichts neu geladen, Videos und Logins laufen einfach weiter.

Besteht aus einer Browser-Erweiterung und einem kleinen KWin-Skript für KDE Plasma. Die Erweiterung spricht Deutsch und Englisch und richtet sich nach der Sprache des Browsers.

## „Warum nicht einfach Profile?“

Profile trennen alles: Logins, Verlauf, Erweiterungen, und jedes Profil braucht ein eigenes Fenster. Ich wollte nur die Tabs trennen, zum Beispiel „Ich“ und „Uni“, und trotzdem überall eingeloggt bleiben.

Helium hat das nicht eingebaut, also habe ich es gebaut.

## So funktioniert's

Jedes normale Fenster zeigt genau einen Workspace. Die Tabs der gerade nicht gezeigten Workspaces liegen in versteckten **Ablage-Fenstern**, eins pro Workspace. Beim Wechseln werden die Tabs zwischen den Fenstern verschoben, nicht geschlossen. Deshalb bleiben sie geladen.

Drei Teile arbeiten zusammen:

- **Die Erweiterung** (Ordner `extension/`) verschiebt die Tabs und legt die Ablage-Fenster an. Der erste, angeheftete Tab jeder Ablage ist eine Seite der Erweiterung. Sie setzt den Fenstertitel auf `HWS-Ablage <Schlüssel> · <Workspace-Name>`.
- **Der Schlüssel** entsteht beim ersten Start der Erweiterung und liegt in ihrem Speicher im Helium-Profil. `install.sh` trägt ihn in die KWin-Einstellungen (`kwinrc`) ein.
- **Das KWin-Skript** (Ordner `kwin/`) sucht Browserfenster, in deren Titel `HWS-Ablage` mit diesem Schlüssel steht. Es nimmt sie aus Taskleiste, Alt+Tab, Übersicht und Pager und hält sie minimiert. Eine Webseite kann sich deshalb nicht als Ablage ausgeben, denn sie kennt den Schlüssel nicht.

### Grenzen

- Tabs in Ablagen bleiben geladen. Sie brauchen weiter Arbeitsspeicher, und Videos oder Musik laufen im Hintergrund weiter. Mit **Ablagen stummschalten** in der Workspace-Liste sind sie dabei wenigstens stumm. Mit **Ablagen entladen nach** werden sie nach einer gewählten Zeit entladen (siehe unten).
- Angeheftete Tabs gehören zu allen Workspaces und bleiben immer im Hauptfenster.
- Mehrere Fenster können denselben Workspace zeigen, etwa nach <kbd>Strg</kbd>+<kbd>N</kbd>.
- Inkognito-Fenster werden nicht berücksichtigt.
- Ohne das KWin-Skript funktioniert die Erweiterung auch, die Ablage-Fenster sind dann aber als minimierte Fenster sichtbar.

## Voraussetzungen

- [Helium](https://github.com/imputnet/helium-linux) unter Linux. Getestet mit Helium 0.21.
- KDE Plasma 6 mit KWin 6, unter Wayland oder X11. Andere Desktops verstecken die Ablage-Fenster nicht.
- Für `install.sh`: `bash`, `sed`, `tr` und `git` sowie `kpackagetool6`, `kreadconfig6`, `kwriteconfig6` und `qdbus6`. Bei Arch heißen die Pakete `coreutils`, `kpackage`, `kconfig` und `qt6-tools`. Statt `qdbus6` nimmt `install.sh` auch `qdbus-qt6` (so bei Fedora) oder `qdbus`. Fehlt etwas, nennt `install.sh` die Programme und bricht ab, bevor es etwas ändert.
- Eine laufende Plasma-Sitzung. `install.sh` lädt das Skript über den D-Bus dieser Sitzung direkt in KWin. Am sichersten in einem Terminal innerhalb der Sitzung starten.
- In Helium unter *Einstellungen → Beim Start* die Option **„Dort weitermachen, wo ich aufgehört habe“**. Mit einer anderen Starteinstellung stellt Helium die Ablage-Fenster beim Start nicht wieder her. Die Erweiterung baut die Workspaces dann aus ihrer Sicherung neu auf, die Tabs laden dabei aber neu und verlieren ihren Verlauf (siehe [Was erhalten bleibt](#was-erhalten-bleibt)). `install.sh` nennt am Ende die Profile von Helium, Google Chrome und Chromium, in denen die Option fehlt, und ändert dort nichts.

### Google Chrome und Chromium

Die Erweiterung läuft auch in Google Chrome und Chromium. Sie wird dort genauso unter `chrome://extensions` installiert, und die Starteinstellung oben gilt dort ebenso. Sie braucht Version 102 oder neuer, ältere Versionen lehnen die Installation ab. Dabei sind zwei Teile zu unterscheiden:

- **Erweiterung:** Workspaces anlegen, umbenennen, wechseln und löschen, Tabs verschieben, angeheftete Tabs und die Tastenkürzel. Das funktioniert wie in Helium. Getestet mit Google Chrome 157.0.8103.78 und Chromium 160.0.8158.0.
- **Desktop-Integration:** Das KWin-Skript versteckt nur Ablage-Fenster von Browsern, die es an ihrer Fensterklasse (X11) bzw. App-ID (Wayland) erkennt: `helium`, `google-chrome`, `chromium` und `chromium-browser`. Getestet mit Google Chrome 157.0.8103.78 und Chromium 157.0.8103.38 unter KWin 6.8.2, als native Wayland-Fenster und als X11-Fenster über XWayland. Andere Browser wie Brave, Vivaldi oder Edge erkennt es erst, wenn sie in der Liste stehen, siehe unten. Bis dahin bleiben ihre Ablage-Fenster als minimierte Fenster sichtbar.

### Andere Browser

`install.sh --browsers` legt fest, welche Fensterklassen (X11) bzw. App-IDs (Wayland) das KWin-Skript erkennt, kommagetrennt und ohne Rücksicht auf Groß-/Kleinschreibung. Die Liste ersetzt die Standardliste `helium,google-chrome,chromium,chromium-browser`, muss also jeden genutzten Browser nennen:

```bash
./install.sh --browsers helium,brave-browser
```

Die Einstellung bleibt bei späteren Aufrufen von `install.sh` ohne `--browsers` erhalten. `--browsers ''` stellt die Standardliste wieder her.

Die Fensterklasse eines Browsers zeigt dieser Befehl in einem Terminal in der Plasma-Sitzung, danach ein Fenster des Browsers anklicken:

```bash
qdbus6 org.kde.KWin /KWin org.kde.KWin.queryWindowInfo | grep resourceClass
```

Alternativ in den Systemeinstellungen unter **Fensterverwaltung → Fensterregeln**: **Neu hinzufügen …**, dann **Fenstereigenschaften ermitteln** und ein Fenster des Browsers anklicken. **Fensterklasse (Programm)** zeigt denselben Wert. Flatpak-Fassungen können eine andere Klasse melden als das Systempaket.

## Installation

### Erstinstallation

1. Repository klonen:

   ```bash
   git clone https://github.com/Jerry0205dotde/helium-workspaces.git
   cd helium-workspaces
   ```

2. In Helium `chrome://extensions` öffnen und oben rechts den **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** wählen und den Ordner `extension/` aus dem Repository auswählen.
4. Den Workspace-Button in der Symbolleiste anheften.
5. Den Workspace-Button anklicken, unten **Schlüssel für install.sh** aufklappen und auf **Kopieren** klicken. Das kopiert den fertigen Befehl samt Schlüssel:

   ```bash
   ./install.sh <Schlüssel>
   ```

   Ihn in einem Terminal im Repository-Ordner einfügen und ausführen. Er richtet das KWin-Skript ein.

   Am Ende steht `Fertig, KWin-Skript <Version> installiert.`. Das KWin-Skript ist dann installiert, aktiviert, geladen und kennt den Schlüssel. `install.sh` antwortet auf Deutsch, wenn die Sprache der Sitzung Deutsch ist (`LANGUAGE`, `LC_ALL`, `LC_MESSAGES` oder `LANG`), sonst auf Englisch. `./install.sh --help` zeigt alle Optionen.
6. Zum Prüfen einen zweiten Workspace anlegen und hin- und herwechseln. In der Taskleiste darf kein zusätzliches Browserfenster auftauchen.

Den Ordner nach dem Laden nicht verschieben. Helium lädt die Erweiterung bei jedem Start aus genau diesem Ordner. Den Entwicklermodus eingeschaltet lassen. Ohne ihn deaktiviert Helium entpackte Erweiterungen.

### Aktualisieren

Es gibt keine automatischen Updates. Helium lädt die Erweiterung direkt aus dem Repository-Ordner, eine neue Version kommt also erst an, wenn du sie selbst holst:

1. Neuen Stand holen und das KWin-Skript aktualisieren:

   ```bash
   cd helium-workspaces
   ./install.sh --update
   ```

   Das führt `git pull --ff-only` aus und richtet das KWin-Skript ohne Rückfrage neu ein. Schlüssel und Browserliste bleiben.
2. In `chrome://extensions` bei „Workspaces“ auf **Neu laden** (Kreispfeil) klicken. Ein Neustart von Helium reicht nicht, danach kann noch die alte Hintergrundlogik laufen. `install.sh` nennt am Ende die neue Version, das Popup zeigt sie unten rechts.

Beim Neuladen schließt Chromium alle Seiten der Erweiterung, auch die Ablage-Markierungen. Die Ablage-Fenster tauchen dann kurz in der Taskleiste auf, bis die Erweiterung sie nach ein bis zwei Sekunden wieder markiert. Die Tabs bleiben dabei, wo sie sind.

Die Erweiterung zum Aktualisieren nicht entfernen und neu hinzufügen. Beim Entfernen löscht Helium alle Workspaces und die Sicherung. Nur ein Export bleibt dann übrig, von Hand oder automatisch (siehe [Benutzung](#benutzung)).

Einmalig beim Update von einer Version, in der der Schlüssel noch in `extension/token.js` stand: Nach dem Neuladen legt die Erweiterung einen neuen Schlüssel an, und die Ablage-Fenster sind sichtbar. Nach Schritt 2 deshalb im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den Befehl im Repository-Ordner ausführen. `install.sh` löscht dabei die alte `extension/token.js`.

### Der Schlüssel

Die Erweiterung erzeugt beim ersten Start einen zufälligen Schlüssel und speichert ihn in ihrem Speicher im Helium-Profil. Webseiten können ihn dort nicht lesen. Er steht aber im Titel der Ablage-Tabs, und den kann jede andere installierte Erweiterung mit der Berechtigung `tabs` lesen. Der Schlüssel schützt also vor Webseiten, nicht vor anderen Erweiterungen. Das Popup zeigt ihn unter **Schlüssel für install.sh**, und `install.sh` trägt ihn in `kwinrc` ein. Jedes Gerät hat so seinen eigenen Schlüssel. Passt der Schlüssel in `kwinrc` nicht zu dem im Popup, bleiben die Ablage-Fenster sichtbar.

Workspaces auf ein anderes Gerät bringt der Export (siehe unten). Er enthält den Schlüssel nicht.

## Benutzung

| Aktion | So geht's |
| --- | --- |
| Workspace-Liste öffnen | Button in der Symbolleiste oder <kbd>Alt</kbd>+<kbd>W</kbd> |
| Nächster / vorheriger Workspace | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↓</kbd> / <kbd>↑</kbd>, oder in der Liste <kbd>↓</kbd> / <kbd>↑</kbd> und <kbd>Enter</kbd> |
| Zurück zum zuletzt benutzten Workspace | <kbd>Alt</kbd>+<kbd>Q</kbd>, erneut drücken springt wieder hin (wie Alt+Tab) |
| Direkt zu Workspace 1–9 | Kürzel unter `chrome://extensions/shortcuts` selbst festlegen (Chromium schlägt höchstens vier vor), oder in der Liste <kbd>1</kbd>–<kbd>9</kbd> |
| Workspace anlegen, umbenennen, Farbe oder Emoji ändern, löschen | in der Liste |
| Reihenfolge ändern | in der Liste ziehen |
| Tab in einen anderen Workspace schieben | Rechtsklick irgendwo auf die Seite, auch auf einen Link, ein Bild oder markierten Text → **Tab in Workspace verschieben**, oder in der Liste auf ↪ neben dem Ziel |
| Mehrere Tabs auf einmal schieben | Tabs mit <kbd>Strg</kbd> / <kbd>Shift</kbd> markieren, dann wie oben. Ganz markierte Gruppen behalten Titel und Farbe. |
| Ganze Tab-Gruppe schieben | in einem Tab der Gruppe Rechtsklick auf die Seite → **Gruppe in Workspace verschieben** |
| Workspaces exportieren oder importieren | in der Liste → **Exportieren / Importieren** |
| Ton eines Workspace ausschalten | in der Liste auf 🔊 neben dem Workspace klicken (erscheint, solange darin etwas zu hören ist) |
| Nicht gezeigte Workspaces immer stumm | in der Liste **Ablagen stummschalten** anhaken. Beim Zurückholen bekommen die Tabs ihren Ton wieder, von Hand stummgeschaltete bleiben stumm. |
| Tabs nicht gezeigter Workspaces entladen | in der Liste → **Ablagen entladen nach** |

Gut zu wissen:

- Die Liste lässt sich komplett per Tastatur bedienen: <kbd>Tab</kbd> zum Springen, <kbd>↑</kbd> / <kbd>↓</kbd> wählt einen Workspace, <kbd>Enter</kbd> wechselt dorthin, <kbd>1</kbd>–<kbd>9</kbd> wechselt direkt, <kbd>Esc</kbd> schließt den Editor. Umsortieren geht im Editor mit ↑ / ↓.
- Angeheftete Tabs gehören zu allen Workspaces und bleiben immer im Fenster.
- Tab-Gruppen bleiben beim Wechseln erhalten.
- Wählst du einen Tab aus einer Ablage, etwa über die Tab-Suche, zeigt das zuletzt benutzte Hauptfenster dessen Workspace mit dem gewählten Tab.
- Mehrere Fenster dürfen denselben Workspace zeigen, etwa nach <kbd>Strg</kbd>+<kbd>N</kbd>.
- **Ablagen entladen nach** (Standard: nie) entlädt die Tabs in einer Ablage, sobald sie so lange dort liegen. Die Zeit läuft ab dem Wegwechseln vom Workspace. Entladene Tabs geben ihren Arbeitsspeicher frei und behalten Adresse, Titel, Gruppe und Zurück-Verlauf. Beim Zurückwechseln laden sie neu; laufende Videos, Scrollposition und ungespeicherte Eingaben sind dann weg. Tabs, deren Ton gerade zu hören ist, bleiben geladen; stummgeschaltete werden mit entladen.
- Einen gelöschten Workspace holt **Rückgängig** oben in der Liste bis zum nächsten Browserstart samt Tabs zurück. Seine Tabs öffnen sich dann beim Wechseln dorthin neu aus der Sicherung. Dasselbe gilt für die Workspaces, die **Ersetzen** beim Import entfernt.
- Wird das letzte Fenster per X geschlossen oder darin der letzte Tab, schließt die Erweiterung auch die Ablagen, und der Browser beendet sich. Beim nächsten Start baut sie alle Workspaces aus ihrer Sicherung wieder auf. Die Seiten laden dann neu und haben keinen Zurück-Verlauf (siehe [Was erhalten bleibt](#was-erhalten-bleibt)). Wird Helium über das Menü beendet, kommen die Fenster samt Verlauf zurück.
- Der Export ist eine JSON-Datei mit allen Workspaces samt Reihenfolge, Farben, Emoji, Tabs, Tab-Gruppen und angehefteten Tabs, etwa für ein anderes Gerät oder ein neues Profil. Beim Import wird die Datei erst geprüft und zusammengefasst. **Zusammenführen** ergänzt nur, was fehlt: Ein Workspace mit derselben ID oder demselben Namen bekommt die Tabs dazu, die er noch nicht hat. **Ersetzen** löscht die bisherigen Workspaces samt Tabs und fragt deshalb nach.
- Unter **Exportieren / Importieren → Automatisch sichern** legt die Erweiterung auf Wunsch täglich oder wöchentlich einen Export in `Downloads/helium-workspaces/` ab und behält die letzten 10. Standard ist **nie**. Diese Dateien überstehen das Entfernen der Erweiterung und ein kaputtes Profil, zurück kommen die Workspaces dann per Import mit **Ersetzen**. Ist in Helium „Vor dem Download nach dem Speicherort fragen“ eingeschaltet, fragt Helium auch bei jeder automatischen Sicherung. Scheitert eine, zeigt das Popup einen Hinweis.

## Was erhalten bleibt

Die Erweiterung speichert dauerhaft im Profil:

- die Workspaces mit Name, Farbe, Emoji und Reihenfolge sowie den zuletzt benutzten Workspace,
- eine Sicherung aller Tabs mit Adresse, Titel und Tab-Gruppe sowie der angehefteten Tabs.

Nur innerhalb der laufenden Browsersitzung gibt es:

- welches Fenster welchen Workspace zeigt und welcher Tab in jedem Workspace zuletzt aktiv war,
- den Zustand der geladenen Seiten: laufende Videos, Scrollposition, Formulareingaben und der Zurück-Verlauf jedes Tabs, solange er nicht neu angelegt wird.

Nach einem Neustart mit „Dort weitermachen, wo ich aufgehört habe“ stellt Helium alle Fenster samt Ablagen selbst wieder her, mit Verlauf. Die Erweiterung ordnet die Fenster in den ersten 20 Sekunden anhand ihrer Adressen wieder den Workspaces zu. Die Seiten laden dabei wie nach jedem Browser-Neustart neu.

Aus der Sicherung neu aufgebaut wird ein Workspace, wenn sein Fenster fehlt: nach einem Start mit einer anderen Starteinstellung, nach dem Schließen des letzten Fensters per X oder seines letzten Tabs oder beim Import. Dann kommen nur Adresse, Titel, Gruppe und angeheftete Tabs zurück. Die Seiten laden neu, haben keinen Zurück-Verlauf, und ungespeicherte Eingaben sind weg. Damit nicht alle Seiten geladen bleiben, entlädt die Erweiterung jeden so angelegten Tab, sobald er fertig geladen hat, außer dem aktiven. Er lädt neu, wenn du ihn anklickst. Logins bleiben, weil Cookies zum Profil gehören.

Helium (bzw. Chromium) verliert beim Neustart gelegentlich einen Tab, wenn er genau beim Neuschreiben der Sitzungsdatei zwischen zwei Fenstern verschoben wurde. Die Erweiterung erkennt das beim Start und legt fehlende Tabs an derselben Stelle neu an. Solche Tabs laden dann neu und haben keinen Zurück-Verlauf mehr.

## Probleme beheben

### Ablage-Fenster sind in Taskleiste oder Alt+Tab zu sehen

Ein sichtbares Ablage-Fenster hat einen Titel wie `HWS-Ablage 3f9c… · Uni` und als ersten Tab die Seite „Workspace-Ablage“. Nicht schließen, sonst sind die Tabs dieses Workspace zu. Der Reihe nach prüfen:

1. Läuft das KWin-Skript?

   ```bash
   qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces
   ```

   Steht dort nicht `true`, `./install.sh` erneut ausführen. Es installiert, aktiviert und lädt das Skript.
2. Stimmen die Schlüssel überein?

   ```bash
   kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token
   ```

   Die Ausgabe muss der Schlüssel sein, den das Popup unter **Schlüssel für install.sh** zeigt, und der Fenstertitel muss ihn nach `HWS-Ablage` zeigen. Steht im Titel kein Schlüssel (`HWS-Ablage · Uni`), die Erweiterung in `chrome://extensions` neu laden.
3. Zum Reparieren im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den Befehl im Repository-Ordner ausführen. Das Skript lädt das KWin-Skript neu, nach ein bis zwei Sekunden verschwinden die Ablagen aus der Taskleiste.

### `install.sh` bricht ab

- **`Es fehlen Programme, die install.sh braucht`**: Die darunter genannten Programme aus den [Voraussetzungen](#voraussetzungen) installieren. `install.sh` hat noch nichts geändert.
- **`Ungültiger Schlüssel`**: Es wurde kein oder ein unvollständiger Schlüssel eingegeben. Im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den kopierten Befehl ausführen. Der Schlüssel besteht aus 24 Zeichen `0`–`9` und `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Cannot find 'org.kde.kwin.Scripting.unloadScript' in object /Scripting at org.kde.KWin`** oder **`KWin-Skript wurde nicht geladen`**: `install.sh` erreicht KWin nicht, etwa über SSH oder in einer Textkonsole. Das Skript ist dann schon installiert, aber nicht geladen. In einem Terminal in der Plasma-Sitzung erneut starten.

### Tabs fehlen nach einem Neustart

Zeigt die Workspace-Liste „… Tabs nicht wiederhergestellt“, konnte Helium diese Tabs nicht neu anlegen. **Erneut versuchen** wechselt in den Workspace und legt sie noch einmal an. Fehlen Tabs ohne diesen Hinweis, kurz warten. Die Zuordnung nach dem Start dauert bis zu 20 Sekunden.

### Die Erweiterung ist deaktiviert oder reagiert nicht

Ist die Erweiterung in `chrome://extensions` ausgeschaltet, war meist der Entwicklermodus aus. Die Ablage-Fenster stehen dann in der Taskleiste. Den Entwicklermodus wieder einschalten, dann ist die Erweiterung wieder aktiv und markiert die Ablagen neu.

Sonst bei „Workspaces“ auf **Fehler** oder auf **Service Worker** klicken. Meldungen der Erweiterung beginnen mit `[workspaces]`. Oft hilft **Neu laden**, die Tabs bleiben dabei erhalten.

## Deinstallieren

Ohne die Erweiterung verlieren die Ablage-Fenster ihre Markierung, ihre Tabs bleiben aber in den Fenstern. Damit keine Tabs unsichtbar weiterlaufen:

1. **Sichern.** In der Workspace-Liste **Exportieren / Importieren** öffnen und den Export speichern.
2. **Alle Workspaces einmal anzeigen.** Einmal durch alle Workspaces wechseln, damit jeder als Fenster existiert. Workspaces, die nur in der Sicherung stehen (zum Beispiel nach einem Start mit neuer Tab-Seite), werden dabei angelegt. Hinweise „Tabs nicht wiederhergestellt“ mit **Erneut versuchen** erledigen.
3. **KWin-Skript entfernen.**

   ```bash
   ./install.sh --uninstall
   ```

   Das holt die Ablage-Fenster zurück in Taskleiste und Alt+Tab, entlädt dann das Skript, entfernt es und löscht seine Einträge aus `kwinrc`. Wie beim Installieren in einem Terminal in der Plasma-Sitzung ausführen. Erreicht es KWin nicht, bricht es ab, ohne etwas zu entfernen.
4. **Erweiterung entfernen.** In `chrome://extensions` bei „Workspaces“ auf **Entfernen** klicken. Das löscht die Workspaces und die Sicherung aus dem Profil. Danach kann der Repository-Ordner gelöscht werden.

Die Ablage-Fenster bleiben minimiert, bis man sie anklickt. Jedes enthält die Tabs eines Workspace. Die Tabs nach Wunsch zusammenführen oder schließen. Übrig gebliebene Tabs mit der Adresse `chrome-extension://…/stash.html#…` sind leer und können zu. Bleibt doch ein Fenster unsichtbar, Helium beenden und neu starten.

## Einige Hinweise

Das ist ein privates Bastelprojekt. Rechne mit Fehlern.

## Testen

```bash
node --test test/*.test.js
```

Braucht nur Node.js ab Version 22, keinen Browser und kein KWin. Die Tests laden `background.js` samt der Dateien, die es lädt, unverändert in eine Nachbildung der Chrome-APIs und spielen damit Wechsel mit Gruppen und angehefteten Tabs, mehrere Fenster, Neustarts mit und ohne Sitzungswiederherstellung, das Neuladen der Erweiterung, gezielt scheiternde API-Aufrufe, schnell aufeinanderfolgende Änderungen sowie Export und Import samt Zusammenführen und Ersetzen durch. Dazu kommen Syntax, Manifest und KWin-Metadaten, außerdem läuft das KWin-Skript gegen eine Nachbildung der KWin-API und zeigt, welche Fenster es versteckt. `install.sh` läuft gegen Nachbildungen der KDE-Befehle: die Installation samt dem Hinweis auf die Starteinstellung, die Prüfung auf fehlende Programme, `--help`, `--uninstall` und `--update`, das dabei mit echtem `git` aus einem Test-Repository holt. Die Meldungen von `install.sh` werden auf Deutsch und Englisch geprüft. Dieselben Prüfungen laufen in der CI bei jedem Pull Request.

Ändert sich etwas in `extension/`, muss die Version in [`manifest.json`](./extension/manifest.json) höher sein als auf `main`, sonst schlägt `static.test.js` fehl. Die Version steht unten rechts im Popup, so sieht man nach einem Update, ob der neue Stand läuft. Das KWin-Skript trägt in [`metadata.json`](./kwin/metadata.json) dieselbe Version, auch das prüft `static.test.js`, und `install.sh` nennt sie am Ende. Verglichen wird mit `origin/main`, mit `VERSION_BASE` lässt sich eine andere Ref angeben. Fehlt die Ref, wird die Prüfung übersprungen.

Landet eine höhere Version auf `main`, setzt [`tag.yml`](./.github/workflows/tag.yml) auf diesen Commit das Tag `v<Version>`, zum Beispiel `v0.2.0`.

Mit einem Chromium-Browser laufen die wichtigsten Abläufe zusätzlich in einem echten Browser:

```bash
CHROME=/usr/bin/chromium node --test test/chromium.test.js
```

[`chromium.test.js`](./test/chromium.test.js) installiert die Erweiterung in ein frisches Profil und spielt durch: Wechsel mit Tab-Gruppe und angeheftetem Tab, ohne dass eine Seite neu lädt, Neuladen der Erweiterung, Beenden und Neustart mit „Dort weitermachen, wo ich aufgehört habe“ und mit „Neuer Tab“ sowie Schließen per X und Neustart. Ohne `CHROME` wird der Test übersprungen, ohne Bildschirm bleibt der Browser unsichtbar. In der CI läuft er mit Chrome for Testing.

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
- [`install.sh`](./install.sh): KWin-Skript einrichten und den Schlüssel eintragen, mit `--update` aktualisieren, mit `--uninstall` wieder entfernen
- [`test/`](./test): automatische Tests, [`fake-browser.js`](./test/fake-browser.js) bildet die Chrome-APIs nach, [`page.js`](./test/page.js) bedient Popup und Importseite in Chromium, [`chromium.js`](./test/chromium.js) steuert einen echten Chromium

## Lizenz

[GPL-3.0-or-later](./LICENSE). Du darfst Helium Workspaces benutzen, ändern und weitergeben, solange alles, was du darauf aufbauend weitergibst, ebenfalls unter der GPL steht und mit Quellcode kommt.
