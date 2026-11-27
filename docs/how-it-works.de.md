# So funktioniert's

[English](./how-it-works.md) · **Deutsch** · [Zurück zur README](../README.de.md)

Jedes normale Fenster zeigt genau einen Workspace. Die Tabs der gerade nicht gezeigten Workspaces liegen in versteckten **Ablage-Fenstern**, eins pro Workspace. Beim Wechseln werden die Tabs zwischen den Fenstern verschoben, nicht geschlossen. Deshalb bleiben sie geladen.

Drei Teile arbeiten zusammen:

- **Die Erweiterung** (Ordner `extension/`) verschiebt die Tabs und legt die Ablage-Fenster an. Der erste Tab jeder Ablage ist eine Seite der Erweiterung. Sie setzt den Fenstertitel auf `HWS-Ablage <Schlüssel> · <Workspace-Name>`. Sie ist nicht angeheftet, weil Helium ab 0.22 angeheftete Tabs mit allen Fenstern teilt. Aus demselben Grund stehen dort vor ihr in jeder Ablage auch entladene Kopien deiner angehefteten Tabs.
- **Der Schlüssel** entsteht beim ersten Start der Erweiterung und liegt in ihrem Speicher im Helium-Profil. `install.sh` trägt ihn in die KWin-Einstellungen (`kwinrc`) ein.
- **Das KWin-Skript** (Ordner `kwin/`) sucht Browserfenster, in deren Titel `HWS-Ablage` mit diesem Schlüssel steht. Es nimmt sie aus Taskleiste, Alt+Tab, Übersicht und Pager und hält sie minimiert. Eine Webseite kann sich deshalb nicht als Ablage ausgeben, denn sie kennt den Schlüssel nicht.

## Der Schlüssel

Die Erweiterung erzeugt beim ersten Start einen zufälligen Schlüssel und speichert ihn in ihrem Speicher im Helium-Profil. Webseiten können ihn dort nicht lesen. Er steht aber im Titel der Ablage-Tabs, und den kann jede andere installierte Erweiterung mit der Berechtigung `tabs` lesen. Der Schlüssel schützt also vor Webseiten, nicht vor anderen Erweiterungen. Jedes Gerät und jedes Browserprofil hat so seinen eigenen Schlüssel. Steht der Schlüssel nicht in `kwinrc`, bleiben die Ablage-Fenster sichtbar.

In `kwinrc` kommt er von selbst: `install.sh` meldet [`native-host.sh`](../native-host.sh) bei Helium, Google Chrome und Chromium als Native-Messaging-Host an, und zwar nur für die Erweiterung mit der ID `jchklfejnmfphkbcpnhdejmeoncejjbe` (entpackt) und `lgbjnmadobikjaclledhpooneefdojao` (aus dem Chrome Web Store). Andere Erweiterungen und Webseiten können ihn nicht aufrufen. Die Erweiterung schickt ihm ihren Schlüssel beim Start und beim Öffnen des Popups, bis er einmal je Browsersitzung angekommen ist. Fehlt er in `kwinrc`, trägt `native-host.sh` ihn mit `install.sh` ein und lädt so das KWin-Skript neu. Dafür braucht die Erweiterung die Berechtigung `nativeMessaging`. Ohne angemeldeten Host, etwa in einem anderen Browser, zeigt das Popup den Schlüssel unter **Schlüssel für install.sh**, und `./install.sh <Schlüssel>` trägt ihn ein. Derselbe Host schreibt auch die automatischen Sicherungen (siehe [Automatisch sichern](./usage.de.md#automatisch-sichern)), je Profil in einen Ordner, der nach dem Schlüssel benannt ist.

Mehrere Browser oder Profile mit der Erweiterung, etwa Helium und Chromium oder zwei Helium-Profile, haben je einen eigenen Schlüssel. Jeder kommt zu den eingetragenen dazu. Einen Schlüssel, der nicht mehr gebraucht wird, etwa nach dem Entfernen der Erweiterung aus einem Profil, trägt `./install.sh --remove <Schlüssel>` wieder aus. Die Ablagen mit diesem Schlüssel kommen dann zurück in die Taskleiste. Ist die Erweiterung in dem Profil noch installiert, trägt sie ihn beim nächsten Browserstart wieder ein.

Workspaces auf ein anderes Gerät bringt der [Export](./usage.de.md#exportieren-und-importieren). Er enthält den Schlüssel nicht.

## Google Chrome und Chromium

Die Erweiterung läuft auch in Google Chrome und Chromium. Sie wird dort genauso unter `chrome://extensions` installiert, und die [Starteinstellung](../README.de.md#voraussetzungen) gilt dort ebenso. Sie braucht Version 139 oder neuer, ältere Versionen lehnen die Installation ab. Dabei sind zwei Teile zu unterscheiden:

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
