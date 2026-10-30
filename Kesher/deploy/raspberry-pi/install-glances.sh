#!/usr/bin/env bash
# Glances auf einer Raspberry-Station: liefert dem Dashboard (Homepage, Seite Admin, Abschnitt
# „Raspberry Pis“) dieselben Werte wie beim Server – Prozessor, Speicher, Temperatur, Laufwerk,
# Prozesse. Nur die Schnittstelle (/api/4/…) auf Port 61208, ohne Weboberfläche. Antworten bekommt
# nur der Server (systemd IPAddressAllow), alle anderen Geräte im LAN werden abgewiesen.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

ALLOW="192.168.0.230"
PORT="61208"

usage() {
  echo "Usage: sudo ./install-glances.sh [--allow IP] [--port PORT] [--remove]"
  echo "  --allow IP    only this address may query Glances (the JMS server), default ${ALLOW}"
  echo "  --port PORT   Glances API port, default ${PORT}"
  echo "  --remove      stop and remove the service (the glances package stays)"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --allow)
      ALLOW="${2:?--allow requires a value}"
      shift
      ;;
    --port)
      PORT="${2:?--port requires a value}"
      shift
      ;;
    --remove)
      systemctl disable --now kesher-glances.service 2>/dev/null || true
      rm -f /etc/systemd/system/kesher-glances.service
      systemctl daemon-reload
      echo "Removed kesher-glances.service."
      exit 0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if ! command -v glances >/dev/null; then
  apt-get update
  # Ohne Empfehlungen: keine Weboberfläche, keine Docker-/Grafik-Bibliotheken – der Pi 3 ist knapp
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    glances python3-fastapi python3-uvicorn python3-jinja2
fi

# Das Paket bringt eigene Dienste mit (Server-Modus), die braucht es hier nicht
systemctl disable --now glances.service 2>/dev/null || true

cat > /etc/systemd/system/kesher-glances.service <<UNIT
[Unit]
Description=Glances-Messwerte fuer das JMS-Dashboard
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/glances -w --disable-webui --disable-check-update -B 0.0.0.0 -p ${PORT}
Restart=on-failure
RestartSec=10
# Nur der Server darf fragen (Homepage kommt über ihn); alle anderen werden abgewiesen
IPAddressAllow=localhost ${ALLOW}
IPAddressDeny=any
# Der Kiosk (Intercom im Browser) hat Vorrang
Nice=10
CPUWeight=20
MemoryMax=150M
DynamicUser=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable kesher-glances.service
systemctl restart kesher-glances.service

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/4/status" >/dev/null 2>&1; then
    echo "Glances is answering on port ${PORT} (only for ${ALLOW} and this Pi)."
    exit 0
  fi
  sleep 2
done
echo "Glances did not answer on port ${PORT}. Check: journalctl -u kesher-glances -n 50" >&2
exit 1
