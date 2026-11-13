#!/bin/bash
# Installiert bzw. aktualisiert das KWin-Skript auf diesem Gerät und trägt den
# geräteeigenen Schlüssel der Erweiterung in kwinrc ein. Die Erweiterung erzeugt ihn
# beim ersten Start, ihr Popup zeigt ihn unter "Schlüssel für install.sh".
# Aufruf: ./install.sh [--browsers Liste] [Schlüssel]. Ohne Schlüssel fragt das Skript danach.
# --browsers legt kommagetrennt die Fensterklassen (X11) bzw. App-IDs (Wayland) der Browser
# fest, deren Ablagen versteckt werden, z. B. --browsers helium,brave-browser. Eine leere
# Liste stellt die Standardliste wieder her, ohne --browsers bleibt die bisherige Einstellung.
# ./install.sh --uninstall entlädt und entfernt das KWin-Skript samt seiner Einträge in kwinrc.
# ./install.sh --update holt mit git pull den neuen Stand und richtet das KWin-Skript ohne
# Rückfrage neu ein, Schlüssel und Browserliste bleiben.
# Nach der Installation weist das Skript auf Profile von Helium, Google Chrome und Chromium hin,
# die nicht mit „Dort weitermachen, wo ich aufgehört habe“ starten. Es ändert dort nichts.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

TOKEN=""
BROWSERS=""
SET_BROWSERS=""
UNINSTALL=""
UPDATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --browsers)
      [ $# -ge 2 ] || { echo "--browsers braucht eine Liste, z. B. --browsers helium,brave-browser" >&2; exit 1; }
      BROWSERS="$2"; SET_BROWSERS=1; shift 2 ;;
    --browsers=*) BROWSERS="${1#*=}"; SET_BROWSERS=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --update) UPDATE=1; shift ;;
    -*) echo "Unbekannte Option: $1" >&2; exit 1 ;;
    *) TOKEN="$1"; shift ;;
  esac
done

if [ -n "$UPDATE" ]; then
  [ -z "$TOKEN$SET_BROWSERS$UNINSTALL" ] \
    || { echo "--update nimmt keine weiteren Angaben, Schlüssel und Browserliste bleiben wie eingetragen." >&2; exit 1; }
  OLD="$(kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token)"
  [ -n "$OLD" ] || { echo "Noch kein Schlüssel eingetragen. Zuerst ./install.sh ohne --update ausführen." >&2; exit 1; }
  git -C "$DIR" pull --ff-only
  # Die eben geholte Fassung von install.sh richtet das KWin-Skript ein, sie kann neuer sein als diese
  bash "$DIR/install.sh" "$OLD"
  VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$DIR/extension/manifest.json")"
  echo "Jetzt in chrome://extensions bei „Workspaces“ auf Neu laden klicken. Danach zeigt das Popup unten rechts die Version $VERSION."
  exit 0
fi

if [ -n "$UNINSTALL" ]; then
  # Zuerst entladen, sonst läuft das Skript bis zum nächsten Start von KWin weiter. Erreicht
  # qdbus6 KWin nicht, bricht das Skript hier ab, bevor etwas entfernt ist.
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
  if kpackagetool6 --type=KWin/Script -s helium-workspaces >/dev/null 2>&1; then
    kpackagetool6 --type=KWin/Script -r helium-workspaces >/dev/null
  fi
  kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled --delete
  kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token --delete
  kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers --delete
  echo "KWin-Skript entfernt."
  exit 0
fi

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

# session.restore_on_startup ist 1 bei „Dort weitermachen, wo ich aufgehört habe“. Fehlt der
# Wert, gilt der Standard „Neuer Tab“ (5). Die gleichnamigen Prüfsummen unter protection.macs
# sind Zeichenketten und passen deshalb nicht auf das Muster.
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
RESTORE_RE='"restore_on_startup":([0-9]+)'
NOT_RESTORING=()
for entry in "net.imput.helium:Helium" "google-chrome:Google Chrome" "chromium:Chromium"; do
  dir="$CONFIG/${entry%%:*}"
  for prefs in "$dir/Default/Preferences" "$dir"/Profile\ */Preferences; do
    [ -f "$prefs" ] || continue
    [[ "$(<"$prefs")" =~ $RESTORE_RE && "${BASH_REMATCH[1]}" = 1 ]] && continue
    profile="${prefs%/Preferences}"
    NOT_RESTORING+=("${entry#*:}: ${profile/#"$HOME"/\~}")
  done
done
if [ ${#NOT_RESTORING[@]} -gt 0 ]; then
  echo "Hinweis: Diese Profile starten nicht mit „Dort weitermachen, wo ich aufgehört habe“:"
  printf '  %s\n' "${NOT_RESTORING[@]}"
  echo "Dann stellt der Browser die Ablage-Fenster beim Start nicht wieder her, und ihre Tabs laden"
  echo "neu und verlieren ihren Verlauf. Nutzt du die Erweiterung in einem dieser Profile, dort unter"
  echo "Einstellungen → Beim Start die Option wählen."
fi
echo "Fertig."
