#!/bin/bash
# Native-Messaging-Host: Die Erweiterung schickt bei jedem Start ihren Schlüssel als
# {"key":"<24 Hex-Ziffern>"}. Fehlt er in kwinrc, trägt ihn dieser Host mit install.sh ein,
# das lädt auch das KWin-Skript neu. Steht er schon dort, ändert sich nichts.
# install.sh meldet den Host bei Helium, Google Chrome und Chromium an, nur für die Erweiterung
# mit der festen ID (allowed_origins), und --uninstall meldet ihn wieder ab.
# Jede Nachricht beginnt mit ihrer Länge als 32-Bit-Zahl in der Bytereihenfolge des Rechners.
# stdout ist der Weg zurück zur Erweiterung, deshalb landet jede andere Ausgabe in /dev/null.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Antwort mit vorangestellter Länge, little-endian wie auf x86 und ARM unter Linux
reply() {
  local n=${#1}
  printf '%b' "\\x$(printf %02x $((n & 255)))\\x$(printf %02x $((n >> 8 & 255)))\\x00\\x00"
  printf '%s' "$1"
}

# Die vier Bytes Länge überspringen, dann bis zur schließenden Klammer lesen. read liest aus
# einer Pipe Byte für Byte und nimmt nichts darüber hinaus.
dd bs=1 count=4 of=/dev/null 2>/dev/null
IFS= read -r -d '}' msg || true
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
