# Probleme beheben

[English](./troubleshooting.md) · **Deutsch** · [Zurück zur README](../README.de.md)

## Ablage-Fenster sind in Taskleiste oder Alt+Tab zu sehen

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

   In der Ausgabe muss der Schlüssel stehen, den das Popup unter **Schlüssel für install.sh** zeigt (bei mehreren Browsern oder Profilen kommagetrennt), und der Fenstertitel muss ihn nach `HWS-Ablage` zeigen. Steht im Titel kein Schlüssel (`HWS-Ablage · Uni`), die Erweiterung in `chrome://extensions` neu laden.
3. Zum Reparieren `./install.sh` im Repository-Ordner ausführen, die Frage mit <kbd>Enter</kbd> beantworten (meldet `native-host.sh` neu an, die Schlüssel bleiben) und das Popup öffnen. Bleiben die Ablagen sichtbar, im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den Befehl im Repository-Ordner ausführen. Das Skript lädt das KWin-Skript neu, nach ein bis zwei Sekunden verschwinden die Ablagen aus der Taskleiste.

## `install.sh` bricht ab

- **`Es fehlen Programme, die install.sh braucht`**: Die darunter genannten Programme aus den [Voraussetzungen](../README.de.md#voraussetzungen) installieren. `install.sh` hat noch nichts geändert.
- **`Ungültiger Schlüssel`**: Es wurde ein unvollständiger Schlüssel eingegeben. <kbd>Enter</kbd> ohne Eingabe überlässt das Eintragen der Erweiterung. Im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den kopierten Befehl ausführen. Der Schlüssel besteht aus 24 Zeichen `0`–`9` und `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Service 'org.kde.KWin' does not exist.`** oder **`Cannot find 'org.kde.kwin.Scripting.isScriptLoaded' in object /Scripting at org.kde.KWin`**: `install.sh` erreicht KWin nicht, etwa über SSH, in einer Textkonsole oder außerhalb von Plasma. `install.sh` hat noch nichts geändert. In einem Terminal in der Plasma-Sitzung erneut starten.
- **`KWin-Skript wurde nicht geladen`**: KWin war erreichbar, und das Paket samt `kwinrc` ist schon aktualisiert, aber KWin hat das Skript danach nicht geladen. `./install.sh` in einem Terminal in der Plasma-Sitzung erneut ausführen (mit <kbd>Enter</kbd> bleibt der Schlüssel) und prüfen, ob das Skript in den Systemeinstellungen unter *Fensterverwaltung → KWin-Skripte* geladen werden kann. Nach `--update` ist das Repository schon auf dem neuen Stand; sobald `./install.sh` durchläuft, die Erweiterung in `chrome://extensions` neu laden.

## Tabs fehlen nach einem Neustart

Zeigt die Workspace-Liste „… Tabs nicht wiederhergestellt“, konnte Helium diese Tabs nicht neu anlegen. **Erneut versuchen** wechselt in den Workspace und legt sie noch einmal an. Fehlen Tabs ohne diesen Hinweis, kurz warten. Die Zuordnung nach dem Start dauert bis zu 20 Sekunden.

## Nach einem Neustart ist die Erweiterung weg und Ablagen zeigen `ERR_BLOCKED_BY_CLIENT`

Zeigt ein Fenster nach dem Start „jchklfejnmfphkbcpnhdejmeoncejjbe ist gesperrt – Diese Seite wurde von Helium blockiert“ und fehlt das Symbol der Erweiterung, hat Helium sie beim Start nicht geladen. Ursache ist ein Eintrag mit der alten ID aus der Zeit vor 0.3.0, der auf denselben Ordner zeigt (siehe [Umstieg auf die feste Erweiterungs-ID](./updating.de.md#einmalig-umstieg-auf-die-feste-erweiterungs-id-ab-version-030)). In `chrome://extensions` taucht keiner der beiden auf.

1. Die Ablage-Fenster mit der Fehlerseite **nicht schließen**, ihre Tabs gehören zu den Workspaces.
2. Helium beenden.
3. `./install.sh` im Repository-Ordner ausführen und die Frage mit <kbd>Enter</kbd> beantworten. Es meldet „Alte Einträge der Erweiterung entfernt“. Dafür braucht es `python3`. Läuft Helium noch, ändert es nichts und weist darauf hin.
4. Helium starten. Die Erweiterung lädt wieder mit Workspaces, Sicherung und Schlüssel, die Ablagen werden wieder versteckt. Tastenkürzel des alten Eintrags wie <kbd>Alt</kbd>+<kbd>W</kbd> hat sie übernommen.

## <kbd>Alt</kbd>+<kbd>W</kbd> öffnet die Workspace-Liste nicht

Chromium vergibt die Tastenkürzel aus `manifest.json` nur beim Installieren oder Aktualisieren der Erweiterung, und nur, wenn sie frei sind. Beim Umstieg auf die feste ID (ab 0.3.0) hatte der alte Eintrag <kbd>Alt</kbd>+<kbd>W</kbd> und <kbd>Alt</kbd>+<kbd>Q</kbd> noch, die Erweiterung ging deshalb leer aus. Hat eine ältere Fassung von `install.sh` den alten Eintrag entfernt, sind die Kürzel seitdem frei, gehören aber niemandem.

- Unter `chrome://extensions/shortcuts` bei „Workspaces“ die Kürzel selbst festlegen, oder
- in `chrome://extensions` bei „Workspaces“ auf **Neu laden** klicken. Helium vergibt dabei die freien Kürzel nach, die nicht von Hand geändert wurden.

Lässt sich ein Kürzel dort nicht setzen, hat es eine andere Erweiterung. Reagiert es trotzdem nicht, belegt es ein Kurzbefehl von Plasma (Systemeinstellungen → Tastatur → Kurzbefehle).

## Die Erweiterung ist deaktiviert oder reagiert nicht

Ist die Erweiterung in `chrome://extensions` ausgeschaltet, war meist der Entwicklermodus aus. Die Ablage-Fenster stehen dann in der Taskleiste. Den Entwicklermodus wieder einschalten, dann ist die Erweiterung wieder aktiv und markiert die Ablagen neu.

Sonst bei „Workspaces“ auf **Fehler** oder auf **Service Worker** klicken. Meldungen der Erweiterung beginnen mit `[workspaces]`. Oft hilft **Neu laden**, die Tabs bleiben dabei erhalten.
