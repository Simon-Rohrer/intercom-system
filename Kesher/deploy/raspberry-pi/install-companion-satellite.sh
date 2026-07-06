#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="/etc/kesher/raspberry-pis.json"
COMPANION_HOST=""
COMPANION_PORT="16622"
REST_PORT="9999"
SATELLITE_BUILD="${SATELLITE_BUILD:-stable}"
SATELLITE_BRANCH="${SATELLITE_BRANCH:-main}"
REINSTALL="false"
MIN_FREE_MB="${KESHER_SATELLITE_MIN_FREE_MB:-2500}"
SKIP_DISK_CHECK="false"
SATELLITE_WORK_DIR="${KESHER_SATELLITE_WORK_DIR:-/opt/kesher-satellite-tmp}"

usage() {
  echo "Usage: sudo ./install-companion-satellite.sh [--host HOST] [--port PORT] [--rest-port PORT] [--config PATH] [--reinstall]"
  echo "  --host HOST      Companion server hostname or IP. Defaults to server_url host from raspberry-pis.json."
  echo "  --port PORT      Companion Satellite API port. Defaults to 16622."
  echo "  --rest-port PORT Satellite web configuration port. Defaults to 9999."
  echo "  --config PATH    Kesher Raspberry config. Defaults to /etc/kesher/raspberry-pis.json."
  echo "  --reinstall      Run the official Bitfocus installer even if satellite.service already exists."
  echo "  --min-free-mb MB Require this much free disk space before installing. Defaults to ${MIN_FREE_MB} MB."
  echo "  --work-dir PATH  Disk-backed temporary work directory. Defaults to ${SATELLITE_WORK_DIR}."
  echo "  --skip-disk-check"
  echo "                   Skip the free-space preflight check."
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --host)
      if [[ "$#" -lt 2 ]]; then
        echo "--host requires a value." >&2
        exit 1
      fi
      COMPANION_HOST="${2:-}"
      shift
      ;;
    --port)
      if [[ "$#" -lt 2 ]]; then
        echo "--port requires a value." >&2
        exit 1
      fi
      COMPANION_PORT="${2:-}"
      shift
      ;;
    --rest-port)
      if [[ "$#" -lt 2 ]]; then
        echo "--rest-port requires a value." >&2
        exit 1
      fi
      REST_PORT="${2:-}"
      shift
      ;;
    --config)
      if [[ "$#" -lt 2 ]]; then
        echo "--config requires a value." >&2
        exit 1
      fi
      CONFIG_PATH="${2:-}"
      shift
      ;;
    --reinstall)
      REINSTALL="true"
      ;;
    --min-free-mb)
      if [[ "$#" -lt 2 ]]; then
        echo "--min-free-mb requires a value." >&2
        exit 1
      fi
      MIN_FREE_MB="${2:-}"
      shift
      ;;
    --skip-disk-check)
      SKIP_DISK_CHECK="true"
      ;;
    --work-dir)
      if [[ "$#" -lt 2 ]]; then
        echo "--work-dir requires a value." >&2
        exit 1
      fi
      SATELLITE_WORK_DIR="${2:-}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

extract_companion_host() {
  local config_path="$1"

  if [[ ! -f "${config_path}" ]]; then
    return 0
  fi

  python3 - "${config_path}" <<'PY'
import json
import sys
from urllib.parse import urlparse

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        config = json.load(handle)
    parsed = urlparse(config.get("server_url", ""))
    print(parsed.hostname or "")
except Exception:
    print("")
PY
}

if [[ -z "${COMPANION_HOST}" ]]; then
  COMPANION_HOST="$(extract_companion_host "${CONFIG_PATH}")"
fi

if [[ -z "${COMPANION_HOST}" ]]; then
  echo "Could not determine Companion host. Pass --host <ip-or-hostname>." >&2
  exit 1
fi

if ! [[ "${COMPANION_PORT}" =~ ^[0-9]+$ ]] || ! [[ "${REST_PORT}" =~ ^[0-9]+$ ]]; then
  echo "Ports must be numeric." >&2
  exit 1
fi

if ! [[ "${MIN_FREE_MB}" =~ ^[0-9]+$ ]]; then
  echo "--min-free-mb must be numeric." >&2
  exit 1
fi

if [[ -z "${SATELLITE_WORK_DIR}" || "${SATELLITE_WORK_DIR}" != /* ]]; then
  echo "--work-dir must be an absolute path." >&2
  exit 1
fi

OFFICIAL_INSTALL_URL="https://raw.githubusercontent.com/bitfocus/companion-satellite/main/pi-image/install.sh"

available_mb_for_path() {
  local path="$1"
  df -Pm "${path}" | awk 'NR == 2 { print $4 }'
}

check_free_space() {
  local min_free_mb="$1"
  local path
  local free_mb
  local checked_paths=()

  for path in / /usr/local /opt "${SATELLITE_WORK_DIR}"; do
    if [[ ! -d "${path}" ]]; then
      continue
    fi
    free_mb="$(available_mb_for_path "${path}")"
    checked_paths+=("${path}:${free_mb}MB")
    if [[ -z "${free_mb}" ]] || (( free_mb < min_free_mb )); then
      echo "Not enough free disk space for Companion Satellite." >&2
      echo "Required: at least ${min_free_mb} MB free on ${path}; available: ${free_mb:-unknown} MB." >&2
      echo "Checked: ${checked_paths[*]}" >&2
      echo "Free space first, then rerun this installer." >&2
      echo "Useful commands:" >&2
      echo "  df -h / /tmp /usr/local /opt ${SATELLITE_WORK_DIR}" >&2
      echo "  sudo du -xh /home /opt /usr/local /var/cache/apt /tmp 2>/dev/null | sort -h | tail -40" >&2
      exit 1
    fi
  done
}

cleanup_partial_install() {
  rm -f /tmp/satellite-version-selection /tmp/satellite-version-selection-name
  rm -f /tmp/satellite-update.tar.gz
  rm -rf /tmp/satellite-update /tmp/companion-satellite /tmp/companion-satellite-*

  if systemctl cat satellite.service >/dev/null 2>&1; then
    return 0
  fi

  rm -rf "${SATELLITE_WORK_DIR}/satellite-update" "${SATELLITE_WORK_DIR}/satellite-update.tar.gz"
  rm -rf /usr/local/src/companion-satellite
  rm -rf /opt/companion-satellite
}

patch_official_installer() {
  local installer_path="$1"
  local work_dir="$2"

  python3 - "${installer_path}" "${work_dir}" <<'PY'
import pathlib
import sys

installer_path = pathlib.Path(sys.argv[1])
work_dir = sys.argv[2].rstrip("/")
content = installer_path.read_text(encoding="utf-8")
needle = './pi-image/update.sh "$BUILD_BRANCH" "$SATELLITE_BUILD"'
replacement = f'''sed -i \\
  -e 's|/tmp/satellite-update.tar.gz|{work_dir}/satellite-update.tar.gz|g' \\
  -e 's|/tmp/satellite-update|{work_dir}/satellite-update|g' \\
  ./pi-image/update.sh
./pi-image/update.sh "$BUILD_BRANCH" "$SATELLITE_BUILD"'''
if needle not in content:
    raise SystemExit("Could not patch official Companion Satellite installer: update invocation not found.")
installer_path.write_text(content.replace(needle, replacement), encoding="utf-8")
PY
}

if [[ "${REINSTALL}" == "true" ]] || ! systemctl cat satellite.service >/dev/null 2>&1; then
  install -d -m 0755 "${SATELLITE_WORK_DIR}"
  cleanup_partial_install

  TMP_INSTALLER="$(mktemp "${SATELLITE_WORK_DIR}/installer.XXXXXX")"
  trap 'rm -f "${TMP_INSTALLER}"' EXIT

  if [[ "${SKIP_DISK_CHECK}" != "true" ]]; then
    check_free_space "${MIN_FREE_MB}"
  fi

  echo "Installing Companion Satellite from Bitfocus..."
  curl -fsSL "${OFFICIAL_INSTALL_URL}" -o "${TMP_INSTALLER}"
  patch_official_installer "${TMP_INSTALLER}" "${SATELLITE_WORK_DIR}"
  if ! SATELLITE_BUILD="${SATELLITE_BUILD}" SATELLITE_BRANCH="${SATELLITE_BRANCH}" bash "${TMP_INSTALLER}"; then
    echo "Companion Satellite installer failed." >&2
    echo "Check free space and remove partial install files before retrying:" >&2
    echo "  df -h / /tmp /usr/local /opt ${SATELLITE_WORK_DIR}" >&2
    echo "  sudo rm -f /tmp/satellite-update.tar.gz" >&2
    echo "  sudo rm -rf /tmp/companion-satellite /tmp/companion-satellite-* /tmp/satellite-update" >&2
    echo "  sudo rm -rf ${SATELLITE_WORK_DIR}/satellite-update ${SATELLITE_WORK_DIR}/satellite-update.tar.gz" >&2
    echo "  sudo rm -rf /usr/local/src/companion-satellite /opt/companion-satellite" >&2
    exit 1
  fi
else
  echo "Companion Satellite is already installed. Use --reinstall to run the official installer again."
fi

install -d -m 0755 /boot
cat > /boot/satellite-config <<EOF
# Generated by Kesher Raspberry installer.
# Satellite imports this file on service start and then resets it to defaults.
COMPANION_IP=${COMPANION_HOST}
COMPANION_PORT=${COMPANION_PORT}
REST_PORT=${REST_PORT}
EOF
chmod 0666 /boot/satellite-config

systemctl daemon-reload
systemctl enable satellite.service
systemctl restart satellite.service

echo "Companion Satellite is installed and running."
echo "Target Companion server: ${COMPANION_HOST}:${COMPANION_PORT}"
echo "Satellite web UI: http://$(hostname -I | awk '{print $1}'):${REST_PORT}"
