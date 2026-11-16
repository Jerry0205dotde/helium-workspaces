#!/bin/bash
# Installiert bzw. aktualisiert das KWin-Skript auf diesem Gerät und trägt den
# Schlüssel der Erweiterung in kwinrc ein. Die Erweiterung erzeugt ihn beim ersten Start,
# ihr Popup zeigt ihn unter "Schlüssel für install.sh".
# Aufruf: ./install.sh [--browsers Liste] [Schlüssel]. Ohne Schlüssel fragt das Skript danach.
# Jeder Browser bzw. jedes Profil mit der Erweiterung hat einen eigenen Schlüssel. Ein neuer
# Schlüssel kommt zu den eingetragenen dazu, ./install.sh --remove <Schlüssel> trägt einen aus.
# --browsers legt kommagetrennt die Fensterklassen (X11) bzw. App-IDs (Wayland) der Browser
# fest, deren Ablagen versteckt werden, z. B. --browsers helium,brave-browser. Eine leere
# Liste stellt die Standardliste wieder her, ohne --browsers bleibt die bisherige Einstellung.
# ./install.sh --uninstall holt versteckte Ablagen zurück in die Taskleiste, entlädt und entfernt
# dann das KWin-Skript samt seiner Einträge in kwinrc.
# ./install.sh --update holt mit git pull den neuen Stand und richtet das KWin-Skript ohne
# Rückfrage neu ein, Schlüssel und Browserliste bleiben.
# Nach der Installation weist das Skript auf Profile von Helium, Google Chrome und Chromium hin,
# in denen die Erweiterung installiert ist, die aber nicht mit „Dort weitermachen, wo ich
# aufgehört habe“ starten. Es ändert dort nichts.
# Bevor es etwas ändert, prüft das Skript, ob alle benötigten Programme da sind. Für qdbus6
# nimmt es auch qdbus-qt6 (Fedora) oder qdbus. ./install.sh --help zeigt diesen Text.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Meldungen auf Deutsch, wenn die Sprache der Sitzung Deutsch ist, sonst auf Englisch.
# Vorrang wie bei gettext: LC_ALL vor LC_MESSAGES vor LANG, davor die Sprachliste in
# LANGUAGE (setzt Plasma), außer die Locale ist C bzw. POSIX. Aus der Liste zählt die
# erste Sprache, die es gibt, also Deutsch oder Englisch (auch C bzw. POSIX).
LOC="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
case "$LOC" in C|C.*|POSIX|"") ;; *) LOC="${LANGUAGE:+$LANGUAGE:}$LOC" ;; esac
DE=""
IFS=: read -ra LANGS <<< "$LOC"
for l in "${LANGS[@]}"; do
  case "$l" in
    de|de_*|de.*|de@*) DE=1; break ;;
    en|en_*|en.*|en@*|C|C.*|POSIX) break ;;
  esac
done
# t "deutsch" "english" gibt die Meldung in der Sprache der Sitzung aus
t() { if [ -n "$DE" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }

TOKEN=""
BROWSERS=""
SET_BROWSERS=""
UNINSTALL=""
UPDATE=""
REMOVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --browsers)
      [ $# -ge 2 ] || { t "--browsers braucht eine Liste, z. B. --browsers helium,brave-browser" \
                          "--browsers needs a list, e.g. --browsers helium,brave-browser" >&2; exit 1; }
      BROWSERS="$2"; SET_BROWSERS=1; shift 2 ;;
    --browsers=*) BROWSERS="${1#*=}"; SET_BROWSERS=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --update) UPDATE=1; shift ;;
    --remove) REMOVE=1; shift ;;
    # Der Kommentar am Anfang dieser Datei, ohne die Zeile mit #!
    -h|--help) sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0"; exit 0 ;;
    -*) t "Unbekannte Option: $1" "Unknown option: $1" >&2; exit 1 ;;
    *) TOKEN="$1"; shift ;;
  esac
done

# Fehlt ein Programm, abbrechen, bevor etwas geändert ist. qdbus6 heißt nicht überall so.
QDBUS=""
for q in qdbus6 qdbus-qt6 qdbus; do
  command -v "$q" >/dev/null && { QDBUS="$q"; break; }
done
MISSING=()
[ -n "$QDBUS" ] || MISSING+=("qdbus6 (qdbus-qt6, qdbus)")
for p in kpackagetool6 kreadconfig6 kwriteconfig6 sed tr ${UPDATE:+git}; do
  command -v "$p" >/dev/null || MISSING+=("$p")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  t "Es fehlen Programme, die install.sh braucht:" "Programs that install.sh needs are missing:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  t "Siehe Voraussetzungen in der README." "See Requirements in the README." >&2
  exit 1
fi

# Die eingetragenen Schlüssel stehen kommagetrennt in kwinrc. Ältere Fassungen trugen genau einen ein.
read_keys() {
  local k
  KEYS=()
  IFS=, read -ra k <<< "$(kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token | tr -d '[:space:]')"
  for k in "${k[@]}"; do [ -z "$k" ] || has_key "$k" || KEYS+=("$k"); done
}
has_key() { local k; for k in "${KEYS[@]}"; do [ "$k" = "$1" ] && return 0; done; return 1; }
join_keys() { local IFS=,; printf '%s' "${KEYS[*]}"; }
# Wer den kopierten Befehl aus dem Popup einfügt, bekommt trotzdem nur den Schlüssel
clean_key() { local k="${1##*install.sh}"; printf '%s' "$k" | tr -d '[:space:]'; }
invalid_key() {
  t "Ungültiger Schlüssel. Im Popup der Erweiterung unter \"Schlüssel für install.sh\" kopieren." \
    "Invalid key. Copy it in the extension's popup under \"Key for install.sh\"." >&2
  exit 1
}

if [ -n "$UPDATE" ]; then
  [ -z "$TOKEN$SET_BROWSERS$UNINSTALL$REMOVE" ] \
    || { t "--update nimmt keine weiteren Angaben, Schlüssel und Browserliste bleiben wie eingetragen." \
           "--update takes no further arguments, the key and the browser list stay as they are." >&2; exit 1; }
  OLD="$(kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token)"
  [ -n "$OLD" ] || { t "Noch kein Schlüssel eingetragen. Zuerst ./install.sh ohne --update ausführen." \
                       "No key set up yet. Run ./install.sh without --update first." >&2; exit 1; }
  git -C "$DIR" pull --ff-only
  # Die eben geholte Fassung von install.sh richtet das KWin-Skript ein, sie kann neuer sein als diese
  bash "$DIR/install.sh" "$OLD"
  VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$DIR/extension/manifest.json")"
  # Die deutschen Anführungszeichen sind gewollter Text, keine verirrten Shell-Quotes
  # shellcheck disable=SC1111
  t "Jetzt in chrome://extensions bei „Workspaces“ auf Neu laden klicken. Danach zeigt das Popup unten rechts die Version $VERSION." \
    "Now click Reload on \"Workspaces\" in chrome://extensions. The popup then shows version $VERSION in the bottom right."
  exit 0
fi

if [ -n "$REMOVE" ]; then
  [ -z "$SET_BROWSERS$UNINSTALL" ] \
    || { t "--remove nimmt nur den Schlüssel, der ausgetragen werden soll." \
           "--remove only takes the key to remove." >&2; exit 1; }
  TOKEN="$(clean_key "$TOKEN")"
  [[ "$TOKEN" =~ ^[0-9a-f]{24}$ ]] || invalid_key
  # Erreicht qdbus KWin nicht, bricht das Skript hier ab, bevor etwas geändert ist.
  "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces >/dev/null
  read_keys
  has_key "$TOKEN" || { t "Der Schlüssel $TOKEN ist nicht eingetragen." "The key $TOKEN is not set up." >&2; exit 1; }
  REST=()
  for k in "${KEYS[@]}"; do [ "$k" = "$TOKEN" ] || REST+=("$k"); done
  KEYS=("${REST[@]}")
  if [ ${#KEYS[@]} -gt 0 ]; then
    kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token "$(join_keys)"
  else
    kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token --delete
  fi
  # Neu geladen holt das KWin-Skript die Ablagen mit diesem Schlüssel zurück in die Taskleiste,
  # auch wenn es in den Systemeinstellungen deaktiviert war, wie bei der Installation
  kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled true
  "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
  "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
  if [ ${#KEYS[@]} -gt 0 ]; then
    t "Schlüssel ausgetragen. Noch eingetragen: $(join_keys)" "Key removed. Still set up: $(join_keys)"
  else
    t "Schlüssel ausgetragen. Es ist keiner mehr eingetragen, alle Ablagen sind wieder sichtbar." \
      "Key removed. No key is set up anymore, all stashes are visible again."
  fi
  exit 0
fi

if [ -n "$UNINSTALL" ]; then
  # Erreicht qdbus KWin nicht, bricht das Skript hier ab, bevor etwas entfernt ist.
  "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces >/dev/null
  INSTALLED=""
  kpackagetool6 --type=KWin/Script -s helium-workspaces >/dev/null 2>&1 && INSTALLED=1
  kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token --delete
  if [ -n "$INSTALLED" ]; then
    # Ohne Schlüssel neu geladen holt das KWin-Skript alle versteckten Ablagen zurück in die
    # Taskleiste. Ältere Fassungen tun das nicht, deshalb zuerst die aus diesem Ordner. KWin
    # führt das Skript erst kurz nach dem Laden aus, deshalb die Pause.
    kpackagetool6 --type=KWin/Script -u "$DIR/kwin" >/dev/null
    # Auch ein in den Systemeinstellungen deaktiviertes Skript, sonst lädt KWin es nicht
    kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled true
    "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
    "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
    sleep 1
  fi
  # Dann entladen, sonst läuft das Skript bis zum nächsten Start von KWin weiter
  "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
  [ -z "$INSTALLED" ] || kpackagetool6 --type=KWin/Script -r helium-workspaces >/dev/null
  kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled --delete
  kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers --delete
  t "KWin-Skript entfernt." "KWin script removed."
  exit 0
fi

BROWSERS="$(printf '%s' "$BROWSERS" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
[[ -z "$BROWSERS" || "$BROWSERS" =~ ^[a-z0-9._-]+(,[a-z0-9._-]+)*$ ]] \
  || { t "Ungültige Browserliste: $BROWSERS. Erwartet werden Fensterklassen mit Kommas dazwischen, z. B. helium,brave-browser." \
         "Invalid browser list: $BROWSERS. Expected window classes separated by commas, e.g. helium,brave-browser." >&2; exit 1; }

read_keys
OLD="$(join_keys)"
if [ -z "$TOKEN" ]; then
  read -rp "$(t "Schlüssel aus dem Popup der Erweiterung${OLD:+ (Enter behält $OLD)}: " \
              "Key from the extension's popup${OLD:+ (Enter keeps $OLD)}: ")" TOKEN || true
  TOKEN="${TOKEN:-$OLD}"
fi
# Mehrere Schlüssel kommagetrennt, so gibt --update die eingetragenen weiter
TOKEN="$(clean_key "$TOKEN")"
[[ "$TOKEN" =~ ^[0-9a-f]{24}(,[0-9a-f]{24})*$ ]] || invalid_key
IFS=, read -ra NEW <<< "$TOKEN"
for k in "${NEW[@]}"; do has_key "$k" || KEYS+=("$k"); done
# Überbleibsel älterer Versionen, die den Schlüssel als Datei abgelegt haben
rm -f "$DIR/extension/token.js"

# Erst nachsehen, ob das Paket da ist, damit ein Fehler beim Aktualisieren sichtbar bleibt,
# statt in einem Installationsversuch mit irreführender Meldung zu enden
if kpackagetool6 --type=KWin/Script -s helium-workspaces >/dev/null 2>&1; then
  kpackagetool6 --type=KWin/Script -u "$DIR/kwin" >/dev/null
else
  kpackagetool6 --type=KWin/Script -i "$DIR/kwin" >/dev/null
fi
kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key token "$(join_keys)"
if [ -n "$SET_BROWSERS" ]; then
  if [ -n "$BROWSERS" ]; then
    kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers "$BROWSERS"
  else
    kwriteconfig6 --file kwinrc --group Script-helium-workspaces --key browsers --delete
  fi
fi
kwriteconfig6 --file kwinrc --group Plugins --key helium-workspacesEnabled true
# Skript neu laden, damit es Schlüssel und Browserliste übernimmt
"$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript helium-workspaces >/dev/null
"$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null
[ "$("$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces)" = true ] \
  || { t "KWin-Skript wurde nicht geladen" "KWin script was not loaded" >&2; exit 1; }

# session.restore_on_startup ist 1 bei „Dort weitermachen, wo ich aufgehört habe“. Fehlt der
# Wert, gilt der Standard „Neuer Tab“ (5). Die gleichnamigen Prüfsummen unter protection.macs
# sind Zeichenketten und passen deshalb nicht auf das Muster. Profile ohne die Erweiterung
# zählen nicht: Ihre Einstellungen unter extensions.settings stehen je nach Browser in
# Preferences oder Secure Preferences, unter der festen ID aus dem Schlüssel in manifest.json.
EXT_ID=jchklfejnmfphkbcpnhdejmeoncejjbe
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
RESTORE_RE='"restore_on_startup":([0-9]+)'
NOT_RESTORING=()
for entry in "net.imput.helium:Helium" "google-chrome:Google Chrome" "chromium:Chromium"; do
  dir="$CONFIG/${entry%%:*}"
  for prefs in "$dir/Default/Preferences" "$dir"/Profile\ */Preferences; do
    [ -f "$prefs" ] || continue
    profile="${prefs%/Preferences}"
    content="$(<"$prefs")"
    secure=""
    [ ! -f "$profile/Secure Preferences" ] || secure="$(<"$profile/Secure Preferences")"
    [[ "$content$secure" == *"\"$EXT_ID\":{"* ]] || continue
    [[ "$content" =~ $RESTORE_RE && "${BASH_REMATCH[1]}" = 1 ]] && continue
    NOT_RESTORING+=("${entry#*:}: ${profile/#"$HOME"/\~}")
  done
done
if [ ${#NOT_RESTORING[@]} -gt 0 ]; then
  printf '\n'
  t "Achtung: In diesen Profilen ist die Erweiterung installiert, sie starten aber nicht mit" \
    "Warning: these profiles have the extension installed but do not start with"
  # Die deutschen Anführungszeichen sind gewollter Text, keine verirrten Shell-Quotes
  # shellcheck disable=SC1111
  t "„Dort weitermachen, wo ich aufgehört habe“:" "\"Continue where you left off\":"
  printf '  %s\n' "${NOT_RESTORING[@]}"
  t "Nach einem Neustart des Browsers laden die Tabs der Ablagen dort neu und verlieren ihren Verlauf." \
    "After a browser restart, the tabs of the stashes reload there and lose their history."
  t "Abhilfe: im Browser unter Einstellungen → Beim Start diese Option wählen." \
    "Fix: choose that option in the browser under Settings → On startup."
  printf '\n'
fi
# Die Version des KWin-Skripts ist dieselbe wie die der Erweiterung (test/static.test.js)
[ ${#KEYS[@]} -lt 2 ] || t "Eingetragene Schlüssel: $(join_keys)" "Keys set up: $(join_keys)"
KWIN_VERSION="$(sed -n 's/^ *"Version": *"\([^"]*\)".*/\1/p' "$DIR/kwin/metadata.json")"
t "Fertig, KWin-Skript $KWIN_VERSION installiert." "Done, KWin script $KWIN_VERSION installed."
