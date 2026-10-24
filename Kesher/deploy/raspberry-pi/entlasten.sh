#!/usr/bin/env bash
# Pi entlasten: Dienste, die eine Kesher-Station nicht braucht, abschalten – nichts wird
# deinstalliert. Ein Pi 3 hat nur 905 MB; jeder Dienst weniger lässt Chromium mehr Luft.
#
# Bleibt an: Kesher-Launcher (Desktop-Sitzung, labwc, PipeWire), Companion Satellite
# (satellite, jms-satellite-tls, kesher-satellite.timer), Glances, WLAN (NetworkManager,
# wpa_supplicant), SSH, Bluetooth (Headsets), avahi, Zeit, Gerätezertifikate (/etc/jms-device).
#
# Rückgängig: systemctl unmask/enable der Einheiten aus der Sicherung unter /var/backups,
# rm /etc/cloud/cloud-init.disabled
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

TARGET_USER="${1:-${SUDO_USER:-pi}}"
TARGET_UID="$(id -u "${TARGET_USER}")"
user_systemctl() {
  sudo -u "${TARGET_USER}" XDG_RUNTIME_DIR="/run/user/${TARGET_UID}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${TARGET_UID}/bus" systemctl --user "$@"
}

BACKUP="/var/backups/kesher-pi-dienste-$(date +%Y%m%d%H%M%S).txt"
{
  echo "# systemctl list-units --all"
  systemctl list-units --all --no-pager --plain
  echo "# systemctl list-unit-files"
  systemctl list-unit-files --no-pager --plain
  echo "# systemctl --user list-units --all (${TARGET_USER})"
  user_systemctl list-units --all --no-pager --plain || true
  echo "# systemctl --user list-unit-files (${TARGET_USER})"
  user_systemctl list-unit-files --no-pager --plain || true
} >"${BACKUP}"
echo "Saved the service list to ${BACKUP}"

# Abschalten (beim Start nicht mehr), aber nicht sperren
SYSTEM_DISABLE=(
  cups.service cups.socket cups.path cups-browsed.service
  nfs-blkmap.service nfs-client.target
  xrdp.service xrdp-sesman.service
  wayvnc.service wayvnc-control.service
  unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
  cloud-init-local.service cloud-init-main.service cloud-init-network.service
  cloud-config.service cloud-final.service cloud-init-hotplugd.socket
)
# Sperren: werden sonst per D-Bus oder Socket wieder gestartet
SYSTEM_MASK=(
  packagekit.service packagekit-offline-update.service
  colord.service
  rpcbind.service rpcbind.socket
)
USER_DISABLE=(rpi-connect.service rpi-connect-wayvnc.service rpi-connect-signin.path)
USER_MASK=(
  gvfs-daemon.service gvfs-metadata.service
  gvfs-afc-volume-monitor.service gvfs-goa-volume-monitor.service
  gvfs-gphoto2-volume-monitor.service gvfs-mtp-volume-monitor.service
  gvfs-udisks2-volume-monitor.service
)

existing() {
  local unit
  for unit in "$@"; do
    if systemctl cat "${unit}" >/dev/null 2>&1; then
      printf '%s\n' "${unit}"
    fi
  done
}

mapfile -t units < <(existing "${SYSTEM_DISABLE[@]}")
if [[ "${#units[@]}" -gt 0 ]]; then
  systemctl disable --now "${units[@]}" || true
fi
mapfile -t units < <(existing "${SYSTEM_MASK[@]}")
if [[ "${#units[@]}" -gt 0 ]]; then
  systemctl stop "${units[@]}" 2>/dev/null || true
  systemctl mask "${units[@]}"
fi
# cloud-init hat nur die erste Einrichtung gemacht; WLAN steht fest in NetworkManager
if [[ -d /etc/cloud ]]; then
  touch /etc/cloud/cloud-init.disabled
fi

# Benutzerdienste: für alle Benutzer (--global) und in der laufenden Sitzung
systemctl --global disable "${USER_DISABLE[@]}" 2>/dev/null || true
user_systemctl disable --now "${USER_DISABLE[@]}" 2>/dev/null || true
systemctl --global mask "${USER_MASK[@]}" 2>/dev/null || true
user_systemctl stop "${USER_MASK[@]}" 2>/dev/null || true

echo "Done. Running services now:"
systemctl list-units --type=service --state=running --no-legend --plain | awk '{print "  " $1}'
free -m
