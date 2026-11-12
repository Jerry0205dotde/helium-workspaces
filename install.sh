#!/bin/bash
# Installiert bzw. aktualisiert das KWin-Skript auf diesem Gerät und trägt den
# geräteeigenen Schlüssel der Erweiterung in kwinrc ein. Die Erweiterung erzeugt ihn
# beim ersten Start, ihr Popup zeigt ihn unter "Schlüssel für install.sh".
# Aufruf: ./install.sh [Schlüssel]. Ohne Schlüssel fragt das Skript danach.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

OLD="$(kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token)"
TOKEN="${1-}"
if [ -z "$TOKEN" ]; then
  read -rp "Schlüssel aus dem Popup der Erweiterung${OLD:+ (Enter behält $OLD)}: " TOKEN || true
  TOKEN="${TOKEN:-$OLD}"
fi
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^[0-9a-f]{24}$ ]] \
  || { echo "Ungültiger Schlüssel. Im Popup der Erweiterung unter \"Schlüssel für install.sh\" kopieren." >&2; exit 1; }
# Überbleibsel älterer Versionen, die den Schlüssel als Datei abgelegt haben
rm -f "$DIR/extension/token.js"

kpackagetool6 --type=KWin/Script -u "$DIR/kwin" >/dev/null 2>&1 || kpackagetool6 --type=KWin/Script -i "$DIR/kwin" >/dev/null
kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token "$TOKEN"
kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled true
# Skript neu laden, damit es den Schlüssel übernimmt
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
[ "$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces)" = true ] \
  || { echo "KWin-Skript wurde nicht geladen" >&2; exit 1; }
echo "Fertig."
