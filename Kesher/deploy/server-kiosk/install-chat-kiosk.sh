#!/usr/bin/env bash
# Installs the Kesher chat display as a kiosk on the server's own monitor
# (Ubuntu Server without desktop): cage + Chromium on tty1 as a separate,
# unprivileged user. Existing services (Docker, Kesher, Caddy, Companion,
# SSH) are not modified or restarted.
#
#   sudo ./install-chat-kiosk.sh [--role-id chat-monitor] [--username Chat-Monitor]
#                                [--url http://127.0.0.1:8080] [--update-config]
#                                [--display-url http://127.0.0.1:8090/output.html?id=1]
#   --display-url shows that page instead of the plain chat (e.g. the multiview
#   output with a chat tile); --display-url chat switches back to the chat.
#   sudo ./install-chat-kiosk.sh --uninstall
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bitte mit sudo ausführen." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIOSK_USER="kesher-kiosk"
INSTALL_DIR="/opt/kesher-chat-kiosk"
CONFIG_FILE="/etc/kesher/chat-kiosk.env"
SERVICE_FILE="/etc/systemd/system/kesher-chat-kiosk.service"
PAM_FILE="/etc/pam.d/kesher-chat-kiosk"

ROLE_ID="chat-monitor"
USERNAME="Chat-Monitor"
URL="http://127.0.0.1:8080"
DISPLAY_URL=""
UPDATE_CONFIG="false"
UNINSTALL="false"

require_value() {
  if [[ "$#" -lt 2 || -z "$2" ]]; then
    echo "$1 benötigt einen Wert." >&2
    exit 1
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --role-id) require_value "$@"; ROLE_ID="$2"; UPDATE_CONFIG="true"; shift ;;
    --username) require_value "$@"; USERNAME="$2"; UPDATE_CONFIG="true"; shift ;;
    --url) require_value "$@"; URL="${2%/}"; UPDATE_CONFIG="true"; shift ;;
    --display-url) require_value "$@"; DISPLAY_URL="$2"; UPDATE_CONFIG="true"; shift ;;
    --update-config) UPDATE_CONFIG="true" ;;
    --uninstall) UNINSTALL="true" ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ "${USERNAME}" =~ [[:space:]] ]]; then
  echo "Der Benutzername darf keine Leerzeichen enthalten." >&2
  exit 1
fi

if [[ "${UNINSTALL}" == "true" ]]; then
  systemctl disable --now kesher-chat-kiosk.service 2>/dev/null || true
  rm -f "${SERVICE_FILE}" "${PAM_FILE}" \
    /etc/chromium/policies/managed/kesher-chat-kiosk.json \
    /etc/chromium-browser/policies/managed/kesher-chat-kiosk.json
  rm -rf "${INSTALL_DIR}"
  systemctl daemon-reload
  # Give the monitor its console login back.
  systemctl start getty@tty1.service || true
  echo "Chat-Kiosk entfernt. ${CONFIG_FILE} und Benutzer ${KIOSK_USER} wurden behalten."
  exit 0
fi

echo "==> Pakete installieren (nur Ergänzungen, keine Systemaktualisierung)"
if ! command -v cage >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cage curl
fi
if [[ ! -x /snap/bin/chromium && ! -x /usr/bin/chromium && ! -x /usr/bin/chromium-browser ]]; then
  snap install chromium
fi

echo "==> Benutzer ${KIOSK_USER} anlegen"
if ! id -u "${KIOSK_USER}" >/dev/null 2>&1; then
  # Home under /home: the Chromium snap only runs for such users.
  useradd --create-home --shell /usr/sbin/nologin "${KIOSK_USER}"
  passwd --lock "${KIOSK_USER}" >/dev/null
fi
for group in video render input; do
  if getent group "${group}" >/dev/null; then
    usermod -aG "${group}" "${KIOSK_USER}"
  fi
done

echo "==> Dateien installieren"
install -d -m 0755 "${INSTALL_DIR}" /etc/kesher
install -m 0755 "${SCRIPT_DIR}/kesher-chat-kiosk-launch.sh" "${INSTALL_DIR}/kesher-chat-kiosk-launch.sh"
install -m 0644 "${SCRIPT_DIR}/kesher-chat-kiosk.service" "${SERVICE_FILE}"
cat >"${PAM_FILE}" <<'EOF'
# Login session for the Kesher chat kiosk (seat and GPU access via logind).
auth     required pam_unix.so nullok
account  required pam_unix.so
session  required pam_unix.so
session  required pam_systemd.so
EOF

# Browser policy: never offer page translation on the display. The Chromium
# snap and the deb package read different policy directories.
for policy_dir in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
  install -d -m 0755 "${policy_dir}"
  printf '{\n  "TranslateEnabled": false\n}\n' >"${policy_dir}/kesher-chat-kiosk.json"
done

if [[ "${DISPLAY_URL}" == "chat" ]]; then
  DISPLAY_URL=""
elif [[ -z "${DISPLAY_URL}" && -f "${CONFIG_FILE}" ]]; then
  # Keep a configured display page when only other options change.
  DISPLAY_URL="$(sed -n 's/^KIOSK_URL="\(.*\)"$/\1/p' "${CONFIG_FILE}")"
fi

if [[ ! -f "${CONFIG_FILE}" || "${UPDATE_CONFIG}" == "true" ]]; then
  cat >"${CONFIG_FILE}" <<EOF
# Kesher chat display on the server monitor.
# Change and apply with: sudo systemctl restart kesher-chat-kiosk
KESHER_URL="${URL}"
KESHER_USERNAME="${USERNAME}"
KESHER_ROLE_ID="${ROLE_ID}"
# Page shown on the monitor; empty = plain Kesher chat.
KIOSK_URL="${DISPLAY_URL}"
EOF
  chmod 0644 "${CONFIG_FILE}"
fi

echo "==> Rolle prüfen"
# shellcheck disable=SC1090
source "${CONFIG_FILE}"
if curl -fsS --max-time 5 "${KESHER_URL}/api/public-bootstrap" 2>/dev/null \
  | grep -q "\"id\":\"${KESHER_ROLE_ID}\""; then
  echo "Rolle '${KESHER_ROLE_ID}' ist in Kesher vorhanden."
else
  echo "WARNUNG: Rolle '${KESHER_ROLE_ID}' wurde in Kesher nicht gefunden (oder Kesher ist nicht erreichbar)."
  echo "         Im Admin-Bereich anlegen und auf allen Party Lines als Empfänger eintragen."
fi

echo "==> Dienst aktivieren"
systemctl daemon-reload
systemctl enable kesher-chat-kiosk.service
systemctl restart kesher-chat-kiosk.service

echo
echo "Fertig. Die Chat-Anzeige startet auf dem Bildschirm, sobald Kesher erreichbar ist."
echo "Status:     sudo systemctl status kesher-chat-kiosk"
echo "Protokoll:  journalctl -u kesher-chat-kiosk -f"
echo "Konsole:    Strg+Alt+F2 am Server"
echo "Entfernen:  sudo ${SCRIPT_DIR}/install-chat-kiosk.sh --uninstall"
