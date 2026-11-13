#!/bin/bash
# Installiert bzw. aktualisiert das KWin-Skript auf diesem Gerät und trägt den
# geräteeigenen Schlüssel der Erweiterung in kwinrc ein. Die Erweiterung erzeugt ihn
# beim ersten Start, ihr Popup zeigt ihn unter "Schlüssel für install.sh".
# Aufruf: ./install.sh [--browsers Liste] [Schlüssel]. Ohne Schlüssel fragt das Skript danach.
# --browsers legt kommagetrennt die Fensterklassen (X11) bzw. App-IDs (Wayland) der Browser
# fest, deren Ablagen versteckt werden, z. B. --browsers helium,brave-browser. Eine leere
# Liste stellt die Standardliste wieder her, ohne --browsers bleibt die bisherige Einstellung.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

TOKEN=""
BROWSERS=""
SET_BROWSERS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --browsers)
      [ $# -ge 2 ] || { echo "--browsers braucht eine Liste, z. B. --browsers helium,brave-browser" >&2; exit 1; }
      BROWSERS="$2"; SET_BROWSERS=1; shift 2 ;;
    --browsers=*) BROWSERS="${1#*=}"; SET_BROWSERS=1; shift ;;
    -*) echo "Unbekannte Option: $1" >&2; exit 1 ;;
    *) TOKEN="$1"; shift ;;
  esac
done
BROWSERS="$(printf '%s' "$BROWSERS" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
[[ -z "$BROWSERS" || "$BROWSERS" =~ ^[a-z0-9._-]+(,[a-z0-9._-]+)*$ ]] \
  || { echo "Ungültige Browserliste: $BROWSERS. Erwartet werden Fensterklassen mit Kommas dazwischen, z. B. helium,brave-browser." >&2; exit 1; }

OLD="$(kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token)"
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
if [ -n "$SET_BROWSERS" ]; then
  if [ -n "$BROWSERS" ]; then
    kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers "$BROWSERS"
  else
    kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers --delete
  fi
fi
kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled true
# Skript neu laden, damit es Schlüssel und Browserliste übernimmt
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
[ "$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces)" = true ] \
  || { echo "KWin-Skript wurde nicht geladen" >&2; exit 1; }
echo "Fertig."
