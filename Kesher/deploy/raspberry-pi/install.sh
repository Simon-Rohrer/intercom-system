#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

TARGET_USER="${1:-${SUDO_USER:-pi}}"
if ! getent passwd "${TARGET_USER}" >/dev/null; then
  echo "Linux user not found: ${TARGET_USER}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_UID="$(id -u "${TARGET_USER}")"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"

install -d -m 0755 /opt/kesher-pi /etc/kesher
install -m 0755 "${SCRIPT_DIR}/kesher-pi-launcher.py" /opt/kesher-pi/kesher-pi-launcher.py

if [[ ! -f /etc/kesher/raspberry-pis.json ]]; then
  install -m 0644 "${SCRIPT_DIR}/raspberry-pis.json" /etc/kesher/raspberry-pis.json
  echo "Created /etc/kesher/raspberry-pis.json. Edit it before rebooting."
fi

sed \
  -e "s|__KESHER_USER__|${TARGET_USER}|g" \
  -e "s|__KESHER_UID__|${TARGET_UID}|g" \
  -e "s|__KESHER_HOME__|${TARGET_HOME}|g" \
  "${SCRIPT_DIR}/kesher-pi.service.template" \
  > /etc/systemd/system/kesher-pi.service

systemctl daemon-reload
systemctl enable kesher-pi.service

echo "Installation complete."
echo "1. Edit /etc/kesher/raspberry-pis.json"
echo "2. Test with: sudo -u ${TARGET_USER} KESHER_PI_IP=<PI-IP> /opt/kesher-pi/kesher-pi-launcher.py --print-url"
echo "3. Start with: sudo systemctl start kesher-pi.service"
