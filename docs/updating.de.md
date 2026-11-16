# Aktualisieren und deinstallieren

[English](./updating.md) · **Deutsch** · [Zurück zur README](../README.de.md)

Die zwei Schritte eines normalen Updates stehen in der [README](../README.de.md#aktualisieren).

## Beim Neuladen

Beim Neuladen schließt Chromium alle Seiten der Erweiterung, auch die Ablage-Markierungen. Die Ablage-Fenster tauchen dann kurz in der Taskleiste auf, bis die Erweiterung sie nach ein bis zwei Sekunden wieder markiert. Die Tabs bleiben dabei, wo sie sind.

## Einmalig: Umstieg auf die feste Erweiterungs-ID (ab Version 0.3.0)

Bis Version 0.2.23 hing die ID der Erweiterung vom Pfad ihres Ordners ab. Seit 0.3.0 legt das Feld `key` in `manifest.json` sie fest. Beim ersten Neuladen danach bekommt sie deshalb einmalig die neue ID `jchklfejnmfphkbcpnhdejmeoncejjbe`, und Helium behandelt sie wie eine neu installierte Erweiterung mit leerem Speicher: Workspaces, Sicherung, Einstellungen und Schlüssel fehlen, und Chromium schließt die Ablage-Seiten. Die Tabs bleiben in ihren Fenstern, die alten Ablagen sind danach normale minimierte Fenster. So kommt alles zurück:

1. **Vor dem Update exportieren:** In der Workspace-Liste **Exportieren / Importieren** öffnen und den Export speichern. Fehlt er, geht auch die neueste Datei der automatischen Sicherung aus `Downloads/helium-workspaces/`, die mit dem jüngsten Änderungsdatum.
2. **Aktualisieren** wie in der [README](../README.de.md#aktualisieren) beschrieben: `./install.sh --update`, dann in `chrome://extensions` auf **Neu laden**. Die Workspace-Liste zeigt danach nur „Standard“. Helium bis nach dem Import nicht neu starten, sonst stellt es die alten Ablagen als normale Fenster wieder her, und sie bleiben auch danach sichtbar.
3. **Importieren mit Ersetzen:** **Exportieren / Importieren** öffnen, die Datei aus Schritt 1 wählen, **Ersetzen** wählen und **Importieren** zweimal anklicken. Fenster, deren Tabs alle zu einem Workspace der Datei gehören, übernimmt die Erweiterung samt Tabs und Verlauf: Das sichtbare Fenster zeigt wieder seinen Workspace, die minimierten werden wieder Ablagen. Was darin fehlt, kommt aus der Datei dazu.
4. **Neuen Schlüssel eintragen:** Im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den Befehl im Repository-Ordner ausführen. Bis dahin stehen die Ablage-Fenster in der Taskleiste. `install.sh` nennt danach den alten und den neuen Schlüssel, den alten trägt `./install.sh --remove <alter Schlüssel>` aus.
5. **Einstellungen prüfen:** **Ablagen stummschalten**, **Ablagen entladen nach** und **Automatisch sichern** übernimmt der Import aus einer Datei von Version 0.2.22 oder neuer, sonst neu setzen. Selbst festgelegte Tastenkürzel unter `chrome://extensions/shortcuts` neu festlegen. Automatische Sicherungen mit Datum im Namen in `Downloads/helium-workspaces/`, von Versionen vor 0.3.5, räumt die Erweiterung nicht mehr auf, sie lassen sich von Hand löschen.

In `chrome://extensions` steht danach zusätzlich ein ausgeschalteter Eintrag „Workspaces“ mit der alten ID. Er stört nicht, Helium lädt beim Start nur die Erweiterung mit der neuen ID.

## Einmalig: von einer Version mit `extension/token.js`

Einmalig beim Update von einer Version, in der der Schlüssel noch in `extension/token.js` stand: Nach dem Neuladen legt die Erweiterung einen neuen Schlüssel an, und die Ablage-Fenster sind sichtbar. Nach dem Neuladen deshalb im Popup unter **Schlüssel für install.sh** auf **Kopieren** klicken und den Befehl im Repository-Ordner ausführen. `install.sh` löscht dabei die alte `extension/token.js`.

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
