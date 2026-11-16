# Benutzung im Detail

[English](./usage.md) · **Deutsch** · [Zurück zur README](../README.de.md)

Die Tastenkürzel und die wichtigsten Aktionen stehen in der [README](../README.de.md#benutzung).

## Die Workspace-Liste

- Die Liste lässt sich komplett per Tastatur bedienen: <kbd>Tab</kbd> zum Springen, <kbd>↑</kbd> / <kbd>↓</kbd> wählt einen Workspace, <kbd>Enter</kbd> wechselt dorthin, <kbd>1</kbd>–<kbd>9</kbd> wechselt direkt, <kbd>Esc</kbd> schließt den Editor. Umsortieren geht im Editor mit ↑ / ↓.
- Angeheftete Tabs gehören zu allen Workspaces und bleiben immer im Fenster.
- Tab-Gruppen bleiben beim Wechseln erhalten.
- Wählst du einen Tab aus einer Ablage, etwa über die Tab-Suche, zeigt das zuletzt benutzte Hauptfenster dessen Workspace mit dem gewählten Tab.
- Mehrere Fenster dürfen denselben Workspace zeigen, etwa nach <kbd>Strg</kbd>+<kbd>N</kbd>. Ein Klick in der Liste auf einen Workspace, den ein anderes Fenster zeigt, holt dieses Fenster nach vorn.
- Einen gelöschten Workspace holt **Rückgängig** oben in der Liste bis zum nächsten Browserstart samt Tabs zurück. Seine Tabs öffnen sich dann beim Wechseln dorthin neu aus der Sicherung. Dasselbe gilt für die Workspaces, die **Ersetzen** beim Import entfernt.

## Ablagen entladen

**Ablagen entladen nach** (Standard: nie) entlädt die Tabs in einer Ablage, sobald sie so lange dort liegen. Die Zeit läuft ab dem Wegwechseln vom Workspace. Entladene Tabs geben ihren Arbeitsspeicher frei und behalten Adresse, Titel, Gruppe und Zurück-Verlauf. Beim Zurückwechseln laden sie neu; laufende Videos, Scrollposition und ungespeicherte Eingaben sind dann weg. Tabs, deren Ton zu hören ist oder in dieser Zeit zu hören war, bleiben geladen, etwa ein Videocall, in dem gerade niemand spricht; stummgeschaltete werden mit entladen.

## Das letzte Fenster schließen

Wird das letzte Fenster per X geschlossen oder darin der letzte Tab, schließt die Erweiterung auch die Ablagen, und der Browser beendet sich. Beim nächsten Start baut sie die Workspaces aus ihrer Sicherung wieder auf. Die Seiten laden dann neu und haben keinen Zurück-Verlauf (siehe [Was erhalten bleibt](#was-erhalten-bleibt)). Mit „Dort weitermachen, wo ich aufgehört habe“ holt Helium das zuletzt geschlossene Fenster samt Verlauf zurück. Die Erweiterung schließt deshalb die Ablage des vor dem aktuellen gezeigten Workspace zuletzt, sonst die mit den meisten Tabs. Wird Helium über das Menü beendet, kommen die Fenster samt Verlauf zurück.

## Exportieren und importieren

Der Export ist eine JSON-Datei mit allen Workspaces samt Reihenfolge, Farben, Emoji, Tabs, Tab-Gruppen und angehefteten Tabs sowie den Einstellungen **Ablagen stummschalten**, **Ablagen entladen nach** und **Automatisch sichern**, etwa für ein anderes Gerät oder ein neues Profil. Beim Import wird die Datei erst geprüft und zusammengefasst, die Zusammenfassung nennt die Einstellungen, die sich ändern. Beide Arten des Imports übernehmen sie. **Zusammenführen** ergänzt nur, was fehlt: Ein Workspace mit derselben ID oder demselben Namen bekommt die Tabs dazu, die er noch nicht hat. **Ersetzen** löscht die bisherigen Workspaces samt Tabs und fragt deshalb nach. Ein Fenster, dessen Tabs alle zu einem Workspace der Datei gehören und mehr als die Hälfte von dessen Tabs ausmachen, bleibt dabei offen und zeigt diesen Workspace, minimiert wird es zu dessen Ablage. Seine Tabs behalten so ihren Verlauf.

## Automatisch sichern

Unter **Exportieren / Importieren → Automatisch sichern** legt die Erweiterung auf Wunsch täglich oder wöchentlich einen Export in `Downloads/helium-workspaces/` ab und behält die letzten 10: Sie schreibt reihum `helium-workspaces-auto-1.json` bis `helium-workspaces-auto-10.json` und überschreibt dabei die älteste, auch wenn der Download-Verlauf geleert wurde. Das Datum steht in der Datei und im Änderungsdatum. Standard ist **nie**. Diese Dateien überstehen das Entfernen der Erweiterung und ein kaputtes Profil, zurück kommen die Workspaces dann per Import mit **Ersetzen**. Ist in Helium „Vor dem Download nach dem Speicherort fragen“ eingeschaltet, fragt Helium auch bei jeder automatischen Sicherung. Scheitert eine, zeigt das Popup einen Hinweis mit **Jetzt sichern**. Solange die automatische Sicherung aus ist und es mindestens zwei Workspaces gibt, weist das Popup einmal darauf hin, mit ✕ verschwindet der Hinweis für immer.

Export und automatische Sicherung enthalten die vollständigen Adressen und Titel aller Tabs im Klartext, also auch Zugangstoken sowie Freigabe- oder Passwort-Reset-Links darin. Wer den Downloads-Ordner synchronisiert oder eine Datei weitergibt, gibt sie mit.

## Was erhalten bleibt

Die Erweiterung speichert dauerhaft im Profil:

- die Workspaces mit Name, Farbe, Emoji und Reihenfolge sowie den zuletzt benutzten Workspace,
- eine Sicherung aller Tabs mit Adresse, Titel und Tab-Gruppe sowie der angehefteten Tabs,
- die drei letzten Stände davon (Workspaces und Sicherung) von vor einem Browserstart. Ordnet ein Start Tabs falsch zu und überschreibt so die Sicherung, holt **Exportieren / Importieren → Importieren** einen davon wie eine Datei zurück, vorgewählt mit **Ersetzen**.

Nur innerhalb der laufenden Browsersitzung gibt es:

- welches Fenster welchen Workspace zeigt und welcher Tab in jedem Workspace zuletzt aktiv war,
- den Zustand der geladenen Seiten: laufende Videos, Scrollposition, Formulareingaben und der Zurück-Verlauf jedes Tabs, solange er nicht neu angelegt wird.

Nach einem Neustart mit „Dort weitermachen, wo ich aufgehört habe“ stellt Helium alle Fenster samt Ablagen selbst wieder her, mit Verlauf. Die Erweiterung ordnet die Fenster in den ersten 20 Sekunden anhand ihrer Adressen wieder den Workspaces zu. Die Seiten laden dabei wie nach jedem Browser-Neustart neu.

Aus der Sicherung neu aufgebaut wird ein Workspace, wenn sein Fenster fehlt: nach einem Start mit einer anderen Starteinstellung, nach dem Schließen des letzten Fensters per X oder seines letzten Tabs oder beim Import. Dann kommen nur Adresse, Titel, Gruppe und angeheftete Tabs zurück. Die Seiten laden neu, haben keinen Zurück-Verlauf, und ungespeicherte Eingaben sind weg. Damit nicht alle Seiten auf einmal laden, legt die Erweiterung die Tabs in Schüben an: Höchstens sechs laden gleichzeitig, der nächste kommt, sobald einer fertig ist, spätestens nach 15 Sekunden. Damit nicht alle Seiten geladen bleiben, entlädt sie jeden so angelegten Tab, sobald er fertig geladen hat, außer dem aktiven. Er lädt neu, wenn du ihn anklickst. Logins bleiben, weil Cookies zum Profil gehören.

Helium (bzw. Chromium) verliert beim Neustart gelegentlich einen Tab, wenn er genau beim Neuschreiben der Sitzungsdatei zwischen zwei Fenstern verschoben wurde. Die Erweiterung erkennt das beim Start und legt fehlende Tabs an derselben Stelle neu an. Solche Tabs laden dann neu und haben keinen Zurück-Verlauf mehr.
