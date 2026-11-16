# So funktioniert's

[English](./how-it-works.md) · **Deutsch** · [Zurück zur README](../README.de.md)

Jedes normale Fenster zeigt genau einen Workspace. Die Tabs der gerade nicht gezeigten Workspaces liegen in versteckten **Ablage-Fenstern**, eins pro Workspace. Beim Wechseln werden die Tabs zwischen den Fenstern verschoben, nicht geschlossen. Deshalb bleiben sie geladen.

Drei Teile arbeiten zusammen:

- **Die Erweiterung** (Ordner `extension/`) verschiebt die Tabs und legt die Ablage-Fenster an. Der erste, angeheftete Tab jeder Ablage ist eine Seite der Erweiterung. Sie setzt den Fenstertitel auf `HWS-Ablage <Schlüssel> · <Workspace-Name>`.
- **Der Schlüssel** entsteht beim ersten Start der Erweiterung und liegt in ihrem Speicher im Helium-Profil. `install.sh` trägt ihn in die KWin-Einstellungen (`kwinrc`) ein.
- **Das KWin-Skript** (Ordner `kwin/`) sucht Browserfenster, in deren Titel `HWS-Ablage` mit diesem Schlüssel steht. Es nimmt sie aus Taskleiste, Alt+Tab, Übersicht und Pager und hält sie minimiert. Eine Webseite kann sich deshalb nicht als Ablage ausgeben, denn sie kennt den Schlüssel nicht.

## Der Schlüssel

Die Erweiterung erzeugt beim ersten Start einen zufälligen Schlüssel und speichert ihn in ihrem Speicher im Helium-Profil. Webseiten können ihn dort nicht lesen. Er steht aber im Titel der Ablage-Tabs, und den kann jede andere installierte Erweiterung mit der Berechtigung `tabs` lesen. Der Schlüssel schützt also vor Webseiten, nicht vor anderen Erweiterungen. Das Popup zeigt ihn unter **Schlüssel für install.sh**, und `install.sh` trägt ihn in `kwinrc` ein. Jedes Gerät und jedes Browserprofil hat so seinen eigenen Schlüssel. Steht der Schlüssel aus dem Popup nicht in `kwinrc`, bleiben die Ablage-Fenster sichtbar.

Mehrere Browser oder Profile mit der Erweiterung, etwa Helium und Chromium oder zwei Helium-Profile, haben je einen eigenen Schlüssel. Für jeden `install.sh` mit dem Schlüssel aus dem jeweiligen Popup ausführen. Ein neuer Schlüssel kommt zu den eingetragenen dazu, `install.sh` nennt dann alle. Einen Schlüssel, der nicht mehr gebraucht wird, etwa nach dem Entfernen der Erweiterung aus einem Profil, trägt `./install.sh --remove <Schlüssel>` wieder aus. Die Ablagen mit diesem Schlüssel kommen dann zurück in die Taskleiste.

Workspaces auf ein anderes Gerät bringt der [Export](./usage.de.md#exportieren-und-importieren). Er enthält den Schlüssel nicht.

## Google Chrome und Chromium

Die Erweiterung läuft auch in Google Chrome und Chromium. Sie wird dort genauso unter `chrome://extensions` installiert, und die [Starteinstellung](../README.de.md#voraussetzungen) gilt dort ebenso. Sie braucht Version 102 oder neuer, ältere Versionen lehnen die Installation ab. Dabei sind zwei Teile zu unterscheiden:

- **Erweiterung:** Workspaces anlegen, umbenennen, wechseln und löschen, Tabs verschieben, angeheftete Tabs und die Tastenkürzel. Das funktioniert wie in Helium. Getestet mit Google Chrome 157.0.8103.78 und Chromium 160.0.8158.0.
- **Desktop-Integration:** Das KWin-Skript versteckt nur Ablage-Fenster von Browsern, die es an ihrer Fensterklasse (X11) bzw. App-ID (Wayland) erkennt: `helium`, `google-chrome`, `chromium` und `chromium-browser`. Getestet mit Google Chrome 157.0.8103.78 und Chromium 157.0.8103.38 unter KWin 6.8.2, als native Wayland-Fenster und als X11-Fenster über XWayland. Andere Browser wie Brave, Vivaldi oder Edge erkennt es erst, wenn sie in der Liste stehen, siehe unten. Bis dahin bleiben ihre Ablage-Fenster als minimierte Fenster sichtbar.

## Andere Browser

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
