#!/usr/bin/env bash
# Installiert den Multiview-Server auf Linux (funktioniert auch auf macOS):
#   1. prüft Node.js
#   2. installiert die Node-Pakete
#   3. lädt MediaMTX (Stream-Empfang) passend zum System und prüft die Prüfsumme
#
# Aufruf:  ./install-linux.sh              nur installieren
#          ./install-linux.sh --autostart  zusätzlich als Dienst einrichten (startet mit dem Rechner)
set -euo pipefail
cd "$(dirname "$0")"

MEDIAMTX_VERSION="v1.21.2"
MEDIAMTX_BASE="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}"

echo "== Multiview – Installation =="

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "FEHLER: Node.js ist nicht installiert."
  echo "  Debian/Ubuntu:  sudo apt install nodejs npm   (Version 18 oder neuer nötig)"
  echo "  oder:           https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "FEHLER: Node.js $(node -v) ist zu alt – Version 18 oder neuer nötig."
  exit 1
fi
echo "Node.js $(node -v) gefunden."

# 2. Node-Pakete
echo "Installiere Node-Pakete …"
npm ci --omit=dev --no-audit --no-fund

# 3. MediaMTX
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)          ASSET="linux_amd64" ;;
  Linux-aarch64|Linux-arm64) ASSET="linux_arm64" ;;
  Linux-armv7l)          ASSET="linux_armv7" ;;
  Linux-armv6l)          ASSET="linux_armv6" ;;
  Darwin-arm64)          ASSET="darwin_arm64" ;;
  Darwin-x86_64)         ASSET="darwin_amd64" ;;
  *) echo "FEHLER: Unbekanntes System $(uname -s) $(uname -m)"; exit 1 ;;
esac
FILE="mediamtx_${MEDIAMTX_VERSION}_${ASSET}.tar.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

echo "Lade MediaMTX ${MEDIAMTX_VERSION} (${ASSET}) …"
download "${MEDIAMTX_BASE}/${FILE}" "$TMP/$FILE"
download "${MEDIAMTX_BASE}/checksums.sha256" "$TMP/checksums.sha256"

EXPECTED="$(grep -F "$FILE" "$TMP/checksums.sha256" | awk '{print $1}')"
ACTUAL="$(sha256 "$TMP/$FILE")"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "FEHLER: Prüfsumme von MediaMTX stimmt nicht – Datei wird nicht verwendet."
  exit 1
fi
echo "Prüfsumme OK."

tar -xzf "$TMP/$FILE" -C "$TMP" mediamtx
mkdir -p bin
mv "$TMP/mediamtx" bin/mediamtx
chmod +x bin/mediamtx
echo "MediaMTX installiert: bin/mediamtx"

# 4. Optional: Dienst (systemd) – startet den Server mit dem Rechner und bei Absturz neu
if [ "${1:-}" = "--autostart" ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Kein systemd gefunden – Autostart bitte selbst einrichten (start-linux.sh)."
  else
    echo "Richte Dienst 'multiview' ein (braucht sudo) …"
    sudo tee /etc/systemd/system/multiview.service >/dev/null <<EOF
[Unit]
Description=Multiview für Blackmagic ATEM
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${PWD}
ExecStart=$(command -v node) ${PWD}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now multiview
    echo "Dienst läuft. Status: sudo systemctl status multiview"
  fi
fi

echo
echo "Fertig. Starten mit:  ./start-linux.sh"
echo "Dann im Browser:      http://<IP-dieses-Rechners>:8090"
