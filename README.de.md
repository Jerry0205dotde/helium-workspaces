# Helium Workspaces

[English](./README.md) · **Deutsch**

Helium Workspaces bringt Arbeitsbereiche wie in Opera in den [Helium-Browser](https://github.com/imputnet/helium-linux): mehrere Tab-Sätze im selben Fenster, umschaltbar per Klick oder Tastenkürzel. Beim Wechseln wird nichts neu geladen, Videos und Logins laufen einfach weiter.

Besteht aus einer Browser-Erweiterung und einem kleinen KWin-Skript für KDE Plasma.

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

- Tabs in Ablagen bleiben geladen. Sie brauchen weiter Arbeitsspeicher, und Videos oder Musik laufen im Hintergrund weiter.
- Angeheftete Tabs gehören zu allen Workspaces und bleiben immer im Hauptfenster.
- Mehrere Fenster können denselben Workspace zeigen, etwa nach <kbd>Strg</kbd>+<kbd>N</kbd>.
- Inkognito-Fenster werden nicht berücksichtigt.
- Ohne das KWin-Skript funktioniert die Erweiterung auch, die Ablage-Fenster sind dann aber als minimierte Fenster sichtbar.

## Voraussetzungen

- [Helium](https://github.com/imputnet/helium-linux) unter Linux. Getestet mit Helium 0.21.
- KDE Plasma 6 mit KWin 6, unter Wayland oder X11. Andere Desktops verstecken die Ablage-Fenster nicht.
- Für `install.sh`: `bash` und `tr` sowie `kpackagetool6`, `kreadconfig6`, `kwriteconfig6` und `qdbus6`. Bei Arch heißen die Pakete `coreutils`, `kpackage`, `kconfig` und `qt6-tools`.
- Eine laufende Plasma-Sitzung. `install.sh` lädt das Skript über den D-Bus dieser Sitzung direkt in KWin. Am sichersten in einem Terminal innerhalb der Sitzung starten.
- In Helium unter *Einstellungen → Beim Start* die Option **„Dort weitermachen, wo ich aufgehört habe“**. Mit einer anderen Starteinstellung stellt Helium die Ablage-Fenster beim Start nicht wieder her. Die Erweiterung baut die Workspaces dann aus ihrer Sicherung neu auf, die Tabs laden dabei aber neu und verlieren ihren Verlauf (siehe [Was erhalten bleibt](#was-erhalten-bleibt)).

### Google Chrome und Chromium

Die Erweiterung läuft auch in Google Chrome und Chromium. Sie wird dort genauso unter `chrome://extensions` installiert, und die Starteinstellung oben gilt dort ebenso. Dabei sind zwei Teile zu unterscheiden:

- **Erweiterung:** Workspaces anlegen, umbenennen, wechseln und löschen, Tabs verschieben, angeheftete Tabs und die Tastenkürzel. Das funktioniert wie in Helium. Getestet mit Google Chrome 157.0.8103.78 und Chromium 160.0.8158.0.
- **Desktop-Integration:** Das KWin-Skript versteckt nur Ablage-Fenster von Browsern, die es an ihrer Fensterklasse (X11) bzw. App-ID (Wayland) erkennt: `helium`, `google-chrome`, `chromium` und `chromium-browser`. Getestet mit Google Chrome 157.0.8103.78 und Chromium 157.0.8103.38 unter KWin 6.8.2, als native Wayland-Fenster und als X11-Fenster über XWayland. Andere Browser wie Brave, Vivaldi oder Edge werden nicht erkannt. Ihre Ablage-Fenster bleiben als minimierte Fenster sichtbar.

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
5. Den Workspace-Button anklicken, unten **Schlüssel für install.sh** aufklappen und auf **Kopieren** klicken. Dann im Repository das KWin-Skript einrichten und den Schlüssel einfügen, wenn das Skript danach fragt:

   ```bash
   ./install.sh
   ```

   Am Ende steht `Fertig.`. Das KWin-Skript ist dann installiert, aktiviert, geladen und kennt den Schlüssel.
6. Zum Prüfen einen zweiten Workspace anlegen und hin- und herwechseln. In der Taskleiste darf kein zusätzliches Browserfenster auftauchen.

Den Ordner nach dem Laden nicht verschieben. Helium lädt die Erweiterung bei jedem Start aus genau diesem Ordner. Den Entwicklermodus eingeschaltet lassen. Ohne ihn deaktiviert Helium entpackte Erweiterungen.

### Aktualisieren

Es gibt keine automatischen Updates. Helium lädt die Erweiterung direkt aus dem Repository-Ordner, eine neue Version kommt also erst an, wenn du sie selbst holst:

1. Neuen Stand holen:

   ```bash
   cd helium-workspaces
   git pull
   ```

2. In `chrome://extensions` bei „Workspaces“ auf **Neu laden** (Kreispfeil) klicken. Ein Neustart von Helium reicht nicht, danach kann noch die alte Hintergrundlogik laufen.
3. Das KWin-Skript aktualisieren:

   ```bash
   ./install.sh
   ```

   Auf die Frage nach dem Schlüssel <kbd>Enter</kbd> drücken, dann bleibt der bisherige.

Beim Neuladen schließt Chromium alle Seiten der Erweiterung, auch die Ablage-Markierungen. Die Ablage-Fenster tauchen dann kurz in der Taskleiste auf, bis die Erweiterung sie nach ein bis zwei Sekunden wieder markiert. Die Tabs bleiben dabei, wo sie sind.

Die Erweiterung zum Aktualisieren nicht entfernen und neu hinzufügen. Beim Entfernen löscht Helium alle Workspaces und die Sicherung.

Einmalig beim Update von einer Version, in der der Schlüssel noch in `extension/token.js` stand: Nach dem Neuladen legt die Erweiterung einen neuen Schlüssel an, und die Ablage-Fenster sind sichtbar. In Schritt 3 deshalb nicht <kbd>Enter</kbd> drücken, sondern den neuen Schlüssel aus dem Popup einfügen. `install.sh` löscht dabei die alte `extension/token.js`.

### Der Schlüssel

Die Erweiterung erzeugt beim ersten Start einen zufälligen Schlüssel und speichert ihn in ihrem Speicher im Helium-Profil. Webseiten können ihn dort nicht lesen. Das Popup zeigt ihn unter **Schlüssel für install.sh**, und `install.sh` trägt ihn in `kwinrc` ein. Jedes Gerät hat so seinen eigenen Schlüssel. Passt der Schlüssel in `kwinrc` nicht zu dem im Popup, bleiben die Ablage-Fenster sichtbar.

Workspaces auf ein anderes Gerät bringt der Export (siehe unten). Er enthält den Schlüssel nicht.

## Benutzung

| Aktion | So geht's |
| --- | --- |
| Workspace-Liste öffnen | Button in der Symbolleiste oder <kbd>Alt</kbd>+<kbd>W</kbd> |
| Nächster / vorheriger Workspace | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↓</kbd> / <kbd>↑</kbd>, oder in der Liste <kbd>↓</kbd> / <kbd>↑</kbd> und <kbd>Enter</kbd> |
| Workspace anlegen, umbenennen, Farbe oder Emoji ändern, löschen | in der Liste |
| Reihenfolge ändern | in der Liste ziehen |
| Tab in einen anderen Workspace schieben | Rechtsklick auf die Seite → **Tab in Workspace verschieben** |
| Workspaces exportieren oder importieren | in der Liste → **Exportieren / Importieren** |

Gut zu wissen:

- Die Liste lässt sich komplett per Tastatur bedienen: <kbd>Tab</kbd> zum Springen, <kbd>↑</kbd> / <kbd>↓</kbd> wählt einen Workspace, <kbd>Enter</kbd> wechselt dorthin, <kbd>1</kbd>–<kbd>9</kbd> wechselt direkt, <kbd>Esc</kbd> schließt den Editor. Umsortieren geht im Editor mit ↑ / ↓.
- Angeheftete Tabs gehören zu allen Workspaces und bleiben immer im Fenster.
- Tab-Gruppen bleiben beim Wechseln erhalten.
- Wählst du einen Tab aus einer Ablage, etwa über die Tab-Suche, zeigt das zuletzt benutzte Hauptfenster dessen Workspace mit dem gewählten Tab.
- Mehrere Fenster dürfen denselben Workspace zeigen, etwa nach <kbd>Strg</kbd>+<kbd>N</kbd>.
- Wird das Fenster per X geschlossen, baut die Erweiterung beim nächsten Start alle Workspaces aus ihrer Sicherung wieder auf.
- Der Export ist eine JSON-Datei mit allen Workspaces samt Reihenfolge, Farben, Emoji, Tabs, Tab-Gruppen und angehefteten Tabs, etwa für ein anderes Gerät oder ein neues Profil. Beim Import wird die Datei erst geprüft und zusammengefasst. **Zusammenführen** ergänzt nur, was fehlt: Ein Workspace mit derselben ID oder demselben Namen bekommt die Tabs dazu, die er noch nicht hat. **Ersetzen** löscht die bisherigen Workspaces samt Tabs und fragt deshalb nach.

## Was erhalten bleibt

Die Erweiterung speichert dauerhaft im Profil:

- die Workspaces mit Name, Farbe, Emoji und Reihenfolge sowie den zuletzt benutzten Workspace,
- eine Sicherung aller Tabs mit Adresse, Titel und Tab-Gruppe sowie der angehefteten Tabs.

Nur innerhalb der laufenden Browsersitzung gibt es:

- welches Fenster welchen Workspace zeigt und welcher Tab in jedem Workspace zuletzt aktiv war,
- den Zustand der geladenen Seiten: laufende Videos, Scrollposition, Formulareingaben und der Zurück-Verlauf jedes Tabs, solange er nicht neu angelegt wird.

Nach einem Neustart mit „Dort weitermachen, wo ich aufgehört habe“ stellt Helium alle Fenster samt Ablagen selbst wieder her, mit Verlauf. Die Erweiterung ordnet die Fenster in den ersten 20 Sekunden anhand ihrer Adressen wieder den Workspaces zu. Die Seiten laden dabei wie nach jedem Browser-Neustart neu.

Aus der Sicherung neu aufgebaut wird ein Workspace, wenn sein Fenster fehlt: nach einem Start mit einer anderen Starteinstellung, nach dem Schließen des letzten Fensters per X oder beim Import. Dann kommen nur Adresse, Titel, Gruppe und angeheftete Tabs zurück. Die Seiten laden neu, haben keinen Zurück-Verlauf, und ungespeicherte Eingaben sind weg. Logins bleiben, weil Cookies zum Profil gehören.

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
3. Zum Reparieren `./install.sh` ausführen und den Schlüssel aus dem Popup einfügen. Das Skript lädt das KWin-Skript neu, nach ein bis zwei Sekunden verschwinden die Ablagen aus der Taskleiste.

### `install.sh` bricht ab

- **`Kommando nicht gefunden`** bzw. **`command not found`**: Ein Programm aus den [Voraussetzungen](#voraussetzungen) fehlt.
- **`Ungültiger Schlüssel`**: Es wurde kein oder ein unvollständiger Schlüssel eingegeben. Im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und erneut einfügen. Der Schlüssel besteht aus 24 Zeichen `0`–`9` und `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Cannot find 'org.kde.kwin.Scripting.unloadScript' in object /Scripting at org.kde.KWin`** oder **`KWin-Skript wurde nicht geladen`**: `install.sh` erreicht KWin nicht, etwa über SSH oder in einer Textkonsole. Das Skript ist dann schon installiert, aber nicht geladen. In einem Terminal in der Plasma-Sitzung erneut starten.

### Tabs fehlen nach einem Neustart

Zeigt die Workspace-Liste „… Tabs nicht wiederhergestellt“, konnte Helium diese Tabs nicht neu anlegen. **Erneut versuchen** wechselt in den Workspace und legt sie noch einmal an. Fehlen Tabs ohne diesen Hinweis, kurz warten. Die Zuordnung nach dem Start dauert bis zu 20 Sekunden.

### Die Erweiterung ist deaktiviert oder reagiert nicht

Ist die Erweiterung in `chrome://extensions` ausgeschaltet, war meist der Entwicklermodus aus. Die Ablage-Fenster stehen dann in der Taskleiste. Den Entwicklermodus wieder einschalten, dann ist die Erweiterung wieder aktiv und markiert die Ablagen neu.

Sonst bei „Workspaces“ auf **Fehler** oder auf **Service Worker** klicken. Meldungen der Erweiterung beginnen mit `[workspaces]`. Oft hilft **Neu laden**, die Tabs bleiben dabei erhalten.

## Deinstallieren

Ohne die Erweiterung verlieren die Ablage-Fenster ihre Markierung, ihre Tabs bleiben aber in den Fenstern. Nur das laufende KWin-Skript holt diese Fenster zurück in die Taskleiste. Damit keine Tabs unsichtbar weiterlaufen, die Reihenfolge einhalten:

1. **Sichern.** In der Workspace-Liste **Exportieren / Importieren** öffnen und den Export speichern.
2. **Alle Workspaces einmal anzeigen.** Einmal durch alle Workspaces wechseln, damit jeder als Fenster existiert. Workspaces, die nur in der Sicherung stehen (zum Beispiel nach einem Start mit neuer Tab-Seite), werden dabei angelegt. Hinweise „Tabs nicht wiederhergestellt“ mit **Erneut versuchen** erledigen.
3. **Ablagen sichtbar machen.** In `chrome://extensions` die Erweiterung mit dem Schalter **deaktivieren**, noch nicht entfernen. Das KWin-Skript bringt die Ablage-Fenster daraufhin zurück in Taskleiste und Alt+Tab. Sie bleiben minimiert, bis man sie anklickt. Jedes Fenster enthält die Tabs eines Workspace. Die Tabs nach Wunsch zusammenführen oder schließen. Übrig gebliebene Tabs mit der Adresse `chrome-extension://…/stash.html#…` sind leer und können zu.
4. **KWin-Skript entfernen.** Erst jetzt, denn ohne laufendes Skript tauchen versteckte Fenster nicht wieder auf:

   ```bash
   qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces
   kpackagetool6 --type=KWin/Script -r helium-workspaces
   kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled --delete
   kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token --delete
   ```

   Wurde das Skript zu früh entfernt, Helium beenden und neu starten. Danach sind die Fenster wieder normal sichtbar.
5. **Erweiterung entfernen.** In `chrome://extensions` bei „Workspaces“ auf **Entfernen** klicken. Das löscht die Workspaces und die Sicherung aus dem Profil. Danach kann der Repository-Ordner gelöscht werden.

## Einige Hinweise

Das ist ein privates Bastelprojekt. Rechne mit Fehlern.

## Testen

```bash
node --test test/*.test.js
```

Braucht nur Node.js ab Version 22, keinen Browser und kein KWin. Die Tests laden `background.js` unverändert in eine Nachbildung der Chrome-APIs und spielen damit Wechsel mit Gruppen und angehefteten Tabs, mehrere Fenster, Neustarts mit und ohne Sitzungswiederherstellung, das Neuladen der Erweiterung, gezielt scheiternde API-Aufrufe, schnell aufeinanderfolgende Änderungen sowie Export und Import samt Zusammenführen und Ersetzen durch. Dazu kommen Syntax, Manifest und KWin-Metadaten, außerdem läuft das KWin-Skript gegen eine Nachbildung der KWin-API und zeigt, welche Fenster es versteckt. Dieselben Prüfungen laufen in der CI bei jedem Pull Request.

Die Verbindung zu Helium und KWin prüfen die Tests nicht. Nach Änderungen daran kurz von Hand:

1. Die Erweiterung unter `chrome://extensions` neu laden und `./install.sh` mit dem Schlüssel aus dem Popup ausführen.
2. Zwei Workspaces mit einigen Tabs, einer Tab-Gruppe und einem angehefteten Tab einrichten und in einem davon ein Video starten.
3. Ein paar Mal hin und her wechseln: Das Video läuft weiter, Gruppe und angehefteter Tab bleiben, und kein Ablage-Fenster taucht in Taskleiste, <kbd>Alt</kbd>+<kbd>Tab</kbd> oder Übersicht auf.
4. Die Erweiterung unter `chrome://extensions` neu laden: Nach etwa einer Sekunde sind die Ablage-Fenster wieder versteckt, Wechseln geht weiter.
5. Helium beenden und neu starten: Alle Workspaces sind vollständig da, die Ablage-Fenster bleiben versteckt.
6. Das Fenster per X schließen und Helium neu starten: Alle Workspaces werden wieder aufgebaut.

## Aufbau

- [`extension/`](./extension): die Erweiterung (Manifest V3)
  - [`background.js`](./extension/background.js): Wechseln, Sicherung, Abgleich nach Neustart
  - [`popup.html`](./extension/popup.html) / [`popup.js`](./extension/popup.js): die Workspace-Liste
  - [`transfer.html`](./extension/transfer.html) / [`transfer.js`](./extension/transfer.js): Export und Import, [`exchange.js`](./extension/exchange.js): das Dateiformat und seine Prüfung
  - [`stash.html`](./extension/stash.html) / [`stash.js`](./extension/stash.js): die Seite, die ein Fenster als Ablage markiert
  - [`label.js`](./extension/label.js): das Zeichen im Symbol eines Workspace
- [`kwin/`](./kwin): KWin-Skript, das die Ablage-Fenster versteckt
- [`install.sh`](./install.sh): KWin-Skript einrichten und den Schlüssel eintragen
- [`test/`](./test): automatische Tests, [`fake-browser.js`](./test/fake-browser.js) bildet die Chrome-APIs nach
