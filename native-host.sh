#!/bin/bash
# Native-Messaging-Host der Erweiterung für zwei Dinge:
# - Schlüssel: Die Erweiterung schickt bei jedem Start ihren Schlüssel als
#   {"key":"<24 Hex-Ziffern>"}. Fehlt er in kwinrc, trägt ihn dieser Host mit install.sh ein,
#   das lädt auch das KWin-Skript neu. Steht er schon dort, ändert sich nichts.
# - Automatische Sicherung: {"backup":<1–10>,"profile":"<Schlüssel>","gzip":"<Base64>"}
#   schreibt den Export nach ${XDG_DATA_HOME:-~/.local/share}/helium-workspaces/backups/
#   <Schlüssel>/helium-workspaces-auto-<n>.json, außerhalb von Downloads und Browserprofil.
#   Der Export ist gzip-komprimiert (#245). Ältere Fassungen der Erweiterung, die nach einem
#   Update noch nicht neu geladen sind, schicken ihn unkomprimiert als "data":"<Base64>".
#   Je Profil ein Ordner, darin höchstens zehn Dateien, die die Erweiterung reihum
#   überschreibt. Erst in eine neue Datei daneben, dann umbenannt, so entsteht nie eine
#   halbe Datei. Die Antwort nennt den Pfad. Die Sicherungen bleiben auch nach
#   install.sh --uninstall liegen.
# install.sh meldet den Host bei Helium, Google Chrome und Chromium an, nur für die Erweiterung
# mit der festen ID (allowed_origins), und --uninstall meldet ihn wieder ab.
# Jede Nachricht beginnt mit ihrer Länge als 32-Bit-Zahl in der Bytereihenfolge des Rechners.
# stdout ist der Weg zurück zur Erweiterung, deshalb landet jede andere Ausgabe in /dev/null.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Antwort mit vorangestellter Länge, little-endian wie auf x86 und ARM unter Linux. Die Länge
# zählt Bytes, nicht Zeichen, falls ein Pfad Umlaute enthält.
reply() {
  local LC_ALL=C
  local n=${#1}
  printf '%b' "\\x$(printf %02x $((n & 255)))\\x$(printf %02x $((n >> 8 & 255)))\\x00\\x00"
  printf '%s' "$1"
}
# Zeichenkette für JSON, Anführungszeichen und Backslash maskiert
json() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }

# Genau so viele Bytes lesen, wie die Länge sagt: Chromium lässt stdin danach offen. head -c
# liest nie mehr als verlangt. Eine Sicherung kann einige MB groß sein, deshalb in eine Datei.
LEN="$(head -c 4 | od -An -tu4 | tr -d '[:space:]')"
[[ "$LEN" =~ ^[0-9]+$ && "$LEN" -le $((64 * 1024 * 1024)) ]] || { reply '{"ok":false,"error":"message"}'; exit 0; }
MSG="$(mktemp "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/helium-workspaces-host.XXXXXX")" || { reply '{"ok":false,"error":"message"}'; exit 0; }
trap 'rm -f "$MSG" "${OUT:-}"' EXIT
head -c "$LEN" > "$MSG"

# Ein Feld der Nachricht. Base64 enthält kein Anführungszeichen, ein Feld kann also nicht in
# den Daten beginnen. Chromium schreibt die Felder in eigener Reihenfolge, deshalb einzeln suchen.
field() { LC_ALL=C grep -m1 -oE "\"$1\":$2" "$MSG"; }

# Der Export aus der Nachricht, auf stdout
export_data() {
  if LC_ALL=C grep -q '"gzip":' "$MSG"; then
    field gzip '"[A-Za-z0-9+/=]*"' | cut -d'"' -f4 | base64 -d | gzip -dc
  else
    field data '"[A-Za-z0-9+/=]*"' | cut -d'"' -f4 | base64 -d
  fi
}

backup() {
  local slot profile base dir file
  slot="$(field backup '[0-9]+')"; slot="${slot#*:}"
  profile="$(field profile '"[0-9a-f]{24}"')"; profile="${profile#*:\"}"; profile="${profile%\"}"
  [[ "$slot" =~ ^([1-9]|10)$ && -n "$profile" ]] || { reply '{"ok":false,"error":"message"}'; return; }
  base="${XDG_DATA_HOME:-}"
  [[ "$base" == /* ]] || base="$HOME/.local/share"
  dir="$base/helium-workspaces/backups/$profile"
  file="$dir/helium-workspaces-auto-$slot.json"
  # Die Sicherungen enthalten alle Adressen im Klartext, nur für diesen Benutzer lesbar
  umask 077
  if mkdir -p "$dir" 2>/dev/null && OUT="$(mktemp "$dir/.helium-workspaces-auto-$slot.XXXXXX")" \
    && export_data > "$OUT" 2>/dev/null \
    && [ -s "$OUT" ] && mv -f "$OUT" "$file"; then
    reply "{\"ok\":true,\"file\":$(json "$file")}"
  else
    reply "{\"ok\":false,\"error\":\"write\",\"file\":$(json "$file")}"
  fi
}

if LC_ALL=C grep -q '"backup":' "$MSG"; then
  backup
  exit 0
fi

msg="$(head -c 4096 "$MSG")"
[[ "$msg" =~ \"key\":\"([0-9a-f]{24})\" ]] || { reply '{"ok":false,"error":"key"}'; exit 0; }
KEY="${BASH_REMATCH[1]}"

# Starten zwei Profile zugleich, tragen sie ihre Schlüssel nacheinander ein, sonst
# überschreibt einer den anderen in kwinrc. Ohne flock geht es auch, nur ohne diesen Schutz.
{ exec 9>"${XDG_RUNTIME_DIR:-/tmp}/helium-workspaces-host.$UID.lock" && flock -w 60 9; } 2>/dev/null

KNOWN="$(kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token 2>/dev/null | tr -d '[:space:]')"
case ",$KNOWN," in
  *",$KEY,"*) reply '{"ok":true}'; exit 0 ;;
esac
if bash "$DIR/install.sh" "$KEY" </dev/null >/dev/null 2>&1; then
  reply '{"ok":true,"added":true}'
else
  reply '{"ok":false,"error":"install"}'
fi
