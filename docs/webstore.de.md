# Chrome Web Store

[English](./webstore.md) · **Deutsch** · [Zurück zur README](../README.de.md)

Was die Erweiterung für den [Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies) braucht und was ins Entwickler-Dashboard kommt ([#51](https://github.com/Jerry0205dotde/helium-workspaces/issues/51)). Die Store-ID ist `lgbjnmadobikjaclledhpooneefdojao`.

## Das Paket

An jedem [Release](https://github.com/Jerry0205dotde/helium-workspaces/releases) ab 0.3.49 hängt `helium-workspaces-v<Version>-webstore.zip`. Das ist `extension/` ohne das Feld `key` aus `manifest.json`, denn der Store nimmt kein Manifest mit `key` an und vergibt eine eigene ID. Gebaut wird es in [`tag.yml`](../.github/workflows/tag.yml).

Zu beachten:

- Die Store-Version hat eine andere ID als die entpackte (`jchklfejnmfphkbcpnhdejmeoncejjbe`). `install.sh` meldet `native-host.sh` für beide an, Schlüssel und automatische Sicherung gehen also in beiden.
- Der Umstieg von der entpackten Erweiterung geht wie beim [Umstieg auf die feste Erweiterungs-ID](./updating.de.md): in der alten Version exportieren, in der Store-Version mit **Ersetzen** importieren, erst dann die entpackte entfernen.
- Mit automatischen Updates haben Erweiterung und KWin-Skript nicht mehr immer dieselbe Version. Das Titelformat der Ablage-Fenster (`HWS-Ablage <Schlüssel> · …`) wird damit zur Schnittstelle zwischen beiden.

## Eintrag im Store

- **Name** und **Kurzbeschreibung**: kommen aus `extName` und `extDescription` in `_locales/*/messages.json`.
- **Kategorie**: Produktivität → Workflow & Planung
- **Symbol**: `extension/icons/128.png`
- **Screenshots**: mindestens einer, 1280×800 oder 640×400: [`docs/webstore/`](./webstore), gebaut aus den Aufnahmen in `docs/`.
- **Kleine Werbekachel** (440×280): freiwillig, aber ohne sie steht die Erweiterung hinter denen, die eine haben.
- **Beschreibung**:

  > Workspaces für deine Tabs: mehrere Tab-Sätze im selben Fenster, zum Beispiel „Ich“ und „Uni“, umschaltbar per Klick oder Tastenkürzel. Beim Wechseln wird nichts neu geladen, Videos und Logins laufen weiter.
  >
  > Die Tabs der nicht gezeigten Workspaces warten in eigenen Ablage-Fenstern. Unter KDE Plasma versteckt das KWin-Skript aus dem GitHub-Repository diese Fenster vor Taskleiste und Alt+Tab. Ohne das Skript und auf anderen Systemen sind sie als minimierte Fenster sichtbar. Auch die automatische Sicherung in einen Ordner braucht die Einrichtung des Skripts.
  >
  > Alle Daten bleiben auf deinem Rechner: kein Server, keine Netzwerkanfragen, keine Statistik.
  >
  > Quellcode, Einrichtung und Hilfe: https://github.com/Jerry0205dotde/helium-workspaces

## Datenschutz

Die Felder im Dashboard sind auf Englisch auszufüllen, die Texte dafür stehen in der [englischen Fassung](./webstore.md#privacy-practices). Inhaltlich:

- **Einziger Zweck**: mehrere Tab-Sätze im selben Fenster halten und ohne Neuladen zwischen ihnen wechseln. Sichern, Exportieren und Importieren dienen demselben Zweck.
- **Berechtigungen**: je eine Begründung für `tabs`, `tabGroups`, `storage`, `unlimitedStorage`, `contextMenus`, `alarms`, `nativeMessaging` und `downloads`. Hostberechtigungen fragt das Manifest nicht an.
- **Code von außen**: nein.
- **Datennutzung**: nur **Web history** ankreuzen, denn die Erweiterung speichert Adressen und Titel der Tabs, nur auf dem Rechner. Das gilt auch für nur lokal gespeicherte Daten. Alle drei Bestätigungen ankreuzen.
- **Datenschutzerklärung**: https://github.com/Jerry0205dotde/helium-workspaces/blob/main/PRIVACY.de.md (im Dashboard die englische, [`PRIVACY.md`](../PRIVACY.md))

## Entwicklerkonto

- Einmalige Registrierungsgebühr und Bestätigung in zwei Schritten am Google-Konto, Pflicht vor dem Veröffentlichen.
- Die Kontakt-E-Mail erreichbar halten: Ablehnungen und Entfernungen kommen nur dorthin.
- Support: Link auf die [Issues](https://github.com/Jerry0205dotde/helium-workspaces/issues).
- Das Dashboard fragt, ob man Händler nach EU-Recht ist (Digital Services Act). Für ein kostenloses Hobbyprojekt meist „kein Händler“.
- Jedes Update wird wieder geprüft, meist in Stunden bis wenigen Tagen. Die Version in `manifest.json` muss höher sein als beim letzten Upload.
