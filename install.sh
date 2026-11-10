#!/bin/bash
# Richtet die Workspaces auf diesem Gerät ein: erzeugt den geräteeigenen Schlüssel für
# die Ablage-Fenster (extension/token.js) und installiert bzw. aktualisiert das
# KWin-Skript mit demselben Schlüssel. Die Erweiterung selbst wird in Helium unter
# chrome://extensions als "Entpackte Erweiterung" aus dem Ordner extension/ geladen.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$DIR/extension/token.js"

if [ ! -f "$TOKEN_FILE" ]; then
  printf "self.HWS_TOKEN = '%s';\n" "$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')" > "$TOKEN_FILE"
fi
TOKEN="$(sed -n "s/^self.HWS_TOKEN = '\([0-9a-f]*\)';$/\1/p" "$TOKEN_FILE")"
[ -n "$TOKEN" ] || { echo "Ungültige $TOKEN_FILE" >&2; exit 1; }

kpackagetool6 --type=KWin/Script -u "$DIR/kwin" >/dev/null 2>&1 || kpackagetool6 --type=KWin/Script -i "$DIR/kwin" >/dev/null
kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token "$TOKEN"
kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled true
# Skript neu laden, damit es den Schlüssel übernimmt
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
[ "$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces)" = true ] \
  || { echo "KWin-Skript wurde nicht geladen" >&2; exit 1; }
echo "Fertig. Falls Helium die Erweiterung schon nutzt: dort unter chrome://extensions neu laden."
