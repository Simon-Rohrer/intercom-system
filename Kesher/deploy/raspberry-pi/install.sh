#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-pi}"
UPDATE_CONFIG="false"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --update-config|--replace-config)
      UPDATE_CONFIG="true"
      ;;
    --help|-h)
      echo "Usage: sudo ./install.sh [desktop-user] [--update-config]"
      echo "  --update-config  replace /etc/kesher/raspberry-pis.json with the local file"
      exit 0
      ;;
    *)
      TARGET_USER="$1"
      ;;
  esac
  shift
done

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
elif [[ "${UPDATE_CONFIG}" == "true" ]]; then
  BACKUP_PATH="/etc/kesher/raspberry-pis.json.$(date +%Y%m%d%H%M%S).bak"
  cp /etc/kesher/raspberry-pis.json "${BACKUP_PATH}"
  install -m 0644 "${SCRIPT_DIR}/raspberry-pis.json" /etc/kesher/raspberry-pis.json
  echo "Updated /etc/kesher/raspberry-pis.json from ${SCRIPT_DIR}/raspberry-pis.json."
  echo "Previous config saved as ${BACKUP_PATH}."
elif ! cmp -s "${SCRIPT_DIR}/raspberry-pis.json" /etc/kesher/raspberry-pis.json; then
  echo "Kept existing /etc/kesher/raspberry-pis.json."
  echo "The service reads /etc/kesher/raspberry-pis.json, not ${SCRIPT_DIR}/raspberry-pis.json."
  echo "To apply the local JSON, run: sudo ./install.sh ${TARGET_USER} --update-config"
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
