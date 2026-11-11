# Helium Workspaces

Helium Workspaces bringt Arbeitsbereiche wie in Opera in den [Helium-Browser](https://github.com/imputnet/helium-linux): mehrere Tab-Sätze im selben Fenster, umschaltbar per Klick oder Tastenkürzel. Beim Wechseln wird nichts neu geladen, Videos und Logins laufen einfach weiter.

Besteht aus einer Browser-Erweiterung und einem kleinen KWin-Skript für KDE Plasma.

## „Warum nicht einfach Profile?“

Profile trennen alles: Logins, Verlauf, Erweiterungen, und jedes Profil braucht ein eigenes Fenster. Ich wollte nur die Tabs trennen, zum Beispiel „Ich“ und „Uni“, und trotzdem überall eingeloggt bleiben.

Helium hat das nicht eingebaut, also habe ich es gebaut.

## So funktioniert's

Jedes normale Fenster zeigt genau einen Workspace. Die Tabs der gerade nicht gezeigten Workspaces liegen in versteckten **Ablage-Fenstern**, eins pro Workspace. Beim Wechseln werden die Tabs zwischen den Fenstern verschoben, nicht geschlossen. Deshalb bleiben sie geladen.

Das KWin-Skript erkennt die Ablage-Fenster an ihrem Titel und blendet sie aus Taskleiste, Alt+Tab und Übersicht aus.

## Installation

> [!WARNING]
> Getestet nur mit Helium unter Linux mit KDE Plasma 6. Ohne KWin funktioniert die Erweiterung auch, aber die Ablage-Fenster sind dann als minimierte Fenster sichtbar.
>
> In Helium muss beim Start **„Dort weitermachen, wo ich aufgehört habe“** eingestellt sein, sonst gehen die Ablage-Fenster beim Beenden verloren.

### 1. Schlüssel und KWin-Skript

```bash
./install.sh
```

Das erzeugt einen geräteeigenen Schlüssel (`extension/token.js`) und installiert bzw. aktualisiert das KWin-Skript mit demselben Schlüssel. Nur Fenster mit diesem Schlüssel im Titel werden versteckt, eine Webseite kann sich also nicht als Ablage ausgeben.

Braucht `kpackagetool6`, `kwriteconfig6` und `qdbus6`.

### 2. Erweiterung laden

1. `chrome://extensions` öffnen
2. **Entwicklermodus** einschalten
3. **Entpackte Erweiterung laden** und den Ordner `extension/` auswählen
4. Den Workspace-Button in der Symbolleiste anheften

Nach Änderungen am Code die Erweiterung dort neu laden oder Helium neu starten.

## Benutzung

| Aktion | So geht's |
| --- | --- |
| Workspace-Liste öffnen | Button in der Symbolleiste oder <kbd>Alt</kbd>+<kbd>W</kbd> |
| Nächster / vorheriger Workspace | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>→</kbd> / <kbd>←</kbd> |
| Workspace anlegen, umbenennen, Farbe oder Emoji ändern, löschen | in der Liste |
| Reihenfolge ändern | in der Liste ziehen |
| Tab in einen anderen Workspace schieben | Rechtsklick auf die Seite → **Tab in Workspace verschieben** |
| Workspaces exportieren oder importieren | in der Liste → **Exportieren / Importieren** |

Gut zu wissen:

- Die Liste lässt sich komplett per Tastatur bedienen: <kbd>Tab</kbd> zum Springen, <kbd>Enter</kbd> zum Auswählen, <kbd>1</kbd>–<kbd>9</kbd> wechselt direkt, <kbd>Esc</kbd> schließt den Editor. Umsortieren geht im Editor mit ↑ / ↓.
- Angeheftete Tabs gehören zu allen Workspaces und bleiben immer im Fenster.
- Tab-Gruppen bleiben beim Wechseln erhalten.
- Mehrere Fenster dürfen denselben Workspace zeigen, etwa nach <kbd>Strg</kbd>+<kbd>N</kbd>.
- Wird das Fenster per X geschlossen, baut die Erweiterung beim nächsten Start alle Workspaces aus ihrer Sicherung wieder auf.
- Der Export ist eine JSON-Datei mit allen Workspaces samt Reihenfolge, Farben, Emoji, Tabs, Tab-Gruppen und angehefteten Tabs, etwa für ein anderes Gerät oder ein neues Profil. Beim Import wird die Datei erst geprüft und zusammengefasst. **Zusammenführen** ergänzt nur, was fehlt: Ein Workspace mit derselben ID oder demselben Namen bekommt die Tabs dazu, die er noch nicht hat. **Ersetzen** löscht die bisherigen Workspaces samt Tabs und fragt deshalb nach.

## Einige Hinweise

Das ist ein privates Bastelprojekt. Rechne mit Fehlern.

Helium (bzw. Chromium) verliert beim Neustart gelegentlich einen Tab, wenn er genau beim Neuschreiben der Sitzungsdatei zwischen zwei Fenstern verschoben wurde. Die Erweiterung erkennt das beim Start und legt fehlende Tabs an derselben Stelle neu an. Solche Tabs laden dann neu und haben keinen Zurück-Verlauf mehr.

Nach dem Neuladen der Erweiterung schließt Chromium ihre Seiten, also auch die Ablage-Markierungen. Die Erweiterung stellt sie danach selbst wieder her.

## Aufbau

- [`extension/`](./extension): die Erweiterung (Manifest V3)
  - [`background.js`](./extension/background.js): Wechseln, Sicherung, Abgleich nach Neustart
  - [`popup.html`](./extension/popup.html) / [`popup.js`](./extension/popup.js): die Workspace-Liste
  - [`transfer.html`](./extension/transfer.html) / [`transfer.js`](./extension/transfer.js): Export und Import, [`exchange.js`](./extension/exchange.js): das Dateiformat und seine Prüfung
  - [`stash.html`](./extension/stash.html) / [`stash.js`](./extension/stash.js): die Seite, die ein Fenster als Ablage markiert
- [`kwin/`](./kwin): KWin-Skript, das die Ablage-Fenster versteckt
- [`install.sh`](./install.sh): Schlüssel erzeugen und KWin-Skript einrichten
