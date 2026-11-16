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
3. Zum Reparieren im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den Befehl im Repository-Ordner ausführen. Das Skript lädt das KWin-Skript neu, nach ein bis zwei Sekunden verschwinden die Ablagen aus der Taskleiste.

## `install.sh` bricht ab

- **`Es fehlen Programme, die install.sh braucht`**: Die darunter genannten Programme aus den [Voraussetzungen](../README.de.md#voraussetzungen) installieren. `install.sh` hat noch nichts geändert.
- **`Ungültiger Schlüssel`**: Es wurde kein oder ein unvollständiger Schlüssel eingegeben. Im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den kopierten Befehl ausführen. Der Schlüssel besteht aus 24 Zeichen `0`–`9` und `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Cannot find 'org.kde.kwin.Scripting.unloadScript' in object /Scripting at org.kde.KWin`** oder **`KWin-Skript wurde nicht geladen`**: `install.sh` erreicht KWin nicht, etwa über SSH oder in einer Textkonsole. Das Skript ist dann schon installiert, aber nicht geladen. In einem Terminal in der Plasma-Sitzung erneut starten.

## Tabs fehlen nach einem Neustart

Zeigt die Workspace-Liste „… Tabs nicht wiederhergestellt“, konnte Helium diese Tabs nicht neu anlegen. **Erneut versuchen** wechselt in den Workspace und legt sie noch einmal an. Fehlen Tabs ohne diesen Hinweis, kurz warten. Die Zuordnung nach dem Start dauert bis zu 20 Sekunden.

## Die Erweiterung ist deaktiviert oder reagiert nicht

Ist die Erweiterung in `chrome://extensions` ausgeschaltet, war meist der Entwicklermodus aus. Die Ablage-Fenster stehen dann in der Taskleiste. Den Entwicklermodus wieder einschalten, dann ist die Erweiterung wieder aktiv und markiert die Ablagen neu.

Sonst bei „Workspaces“ auf **Fehler** oder auf **Service Worker** klicken. Meldungen der Erweiterung beginnen mit `[workspaces]`. Oft hilft **Neu laden**, die Tabs bleiben dabei erhalten.
