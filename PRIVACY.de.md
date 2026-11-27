# Datenschutzerklärung

[English](./PRIVACY.md) · **Deutsch** · [Zurück zur README](./README.de.md)

Diese Erklärung gilt für die Browser-Erweiterung Helium Workspaces, ihr KWin-Skript, `install.sh` und `native-host.sh`.

## Kurz gesagt

Alles bleibt auf deinem Rechner. Die Erweiterung hat keinen Server, stellt keine Netzwerkanfragen, enthält keine Statistik und keine Werbung und gibt keine Daten weiter, auch nicht an den Entwickler.

## Was die Erweiterung speichert

Damit deine Workspaces erhalten bleiben, speichert die Erweiterung im Erweiterungsspeicher (`chrome.storage.local`) deines Browserprofils:

- deine Workspaces mit Name, Farbe und Emoji sowie ihre Tabs (Adresse und Titel), Tab-Gruppen (Name, Farbe, eingeklappt) und angeheftete Tabs
- die IDs von Fenstern, Tabs und Tab-Gruppen, damit sie sie nach einem Neustart wiederfindet
- deine Einstellungen, etwa **Ablagen stummschalten**, **Ablagen entladen nach** und **Automatisch sichern**
- einen zufälligen Schlüssel für das KWin-Skript (24 Hex-Ziffern), den die Erweiterung beim ersten Start erzeugt

Webseiten können diesen Speicher nicht lesen. Er wird gelöscht, wenn du die Erweiterung entfernst. Inkognito-Tabs werden nicht über die Inkognito-Sitzung hinaus gespeichert.

## Dateien auf deinem Rechner

- **Exportieren** speichert eine Datei mit deinen Workspaces, ihren Tabs und Einstellungen dort, wo du es wählst, über die Download-Funktion des Browsers.
- **Automatisch sichern** gibt denselben Export per Native Messaging an `native-host.sh` auf deinem Rechner. Das schreibt ihn nach `~/.local/share/helium-workspaces/backups/`, höchstens zehn Dateien je Browserprofil. Das geht nur, wenn du es mit `install.sh` eingerichtet hast.
- Die Erweiterung schickt ihren Schlüssel an `native-host.sh`, das ihn in `~/.config/kwinrc` einträgt. Das KWin-Skript erkennt daran die Ablage-Fenster dieses Profils und versteckt sie.

Nichts davon verlässt deinen Rechner. Lesen können diese Dateien nur Programme, die unter deinem Benutzerkonto laufen, wie bei jeder anderen Datei von dir.

## Wofür die Daten genutzt werden

Die Daten dienen nur dem einen Zweck der Erweiterung: mehrere Tab-Sätze im selben Fenster zu halten und zwischen ihnen zu wechseln, samt Sichern und Wiederherstellen. Sie werden nicht verkauft, nicht für Werbung oder zur Bewertung der Kreditwürdigkeit genutzt und von keinem Menschen gelesen.

Die Nutzung dieser Daten entspricht der [User Data Policy des Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/policies), einschließlich der Anforderungen zur eingeschränkten Nutzung ([Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)).

## Änderungen

Ändert sich diese Erklärung, steht die neue Fassung hier, und der Verlauf dieser Datei zeigt, was sich geändert hat. Sollte die Erweiterung je Daten von deinem Rechner schicken, steht das vorher hier und in der Erweiterung, und sie fragt dich um Zustimmung.

## Kontakt

Fragen bitte in die [Issues auf GitHub](https://github.com/Jerry0205dotde/helium-workspaces/issues).
