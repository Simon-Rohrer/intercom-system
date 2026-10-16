#!/usr/bin/env bash
# Richtet die wöchentliche Sicherung des JMS-Servers ein – auf einen USB-Datenträger oder Google Drive.
#
#   USB-Stick/-Platte (empfohlen, keine Anmeldung nötig):
#   cd ~/intercom-system/Kesher/deploy/server-backup && sudo ./install-backup.sh --usb
#     - zeigt die angeschlossenen Datenträger; der gewählte wird dauerhaft unter
#       /mnt/jms-backup eingebunden (fehlt er beim Start, startet der Server trotzdem)
#     - legt das verschlüsselte Backup-Repository an und schaltet montags 3:30 Uhr ein
#   sudo ./install-backup.sh --usb --format   vorher mit ext4 neu formatieren (löscht ihn!)
#
#   Google Drive:
#   - installiert restic und rclone
#   - installiert /usr/local/sbin/jms-backup (ersetzt die bisherige Fassung)
#   - verbindet Google Drive (Anmeldung einmalig über einen Rechner mit Browser)
#   - legt das verschlüsselte Backup-Repository an
#   - schaltet die wöchentliche Sicherung ein (montags 3:30 Uhr)
#
#   cd ~/intercom-system/Kesher/deploy/server-backup && sudo ./install-backup.sh
#
# Nochmal ausführen ist unschädlich: Vorhandene Einstellungen, Passwort und
# Google-Anmeldung bleiben erhalten.
#   sudo ./install-backup.sh --client-id <ID> --client-secret <SECRET>
#       eigener Google-Zugang (Google Cloud Console, siehe BETRIEB.md) – der
#       gemeinsame Zugang von rclone ist oft überlastet; danach neu anmelden
#   sudo ./install-backup.sh --uninstall   Timer abschalten (Daten in Drive bleiben)
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bitte mit sudo ausführen." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/jms-backup"
CONFIG_FILE="${CONFIG_DIR}/cloud.env"
PASSWORD_FILE="${CONFIG_DIR}/restic-password"
RCLONE_CONF="${CONFIG_DIR}/rclone.conf"
REMOTE="gdrive"
FOLDER="JMS-Backup"

CLIENT_ID=""
CLIENT_SECRET=""
USB="false"
FORMAT="false"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --usb) USB="true" ;;
    --format) FORMAT="true" ;;
    --client-id) CLIENT_ID="${2:-}"; shift ;;
    --client-secret) CLIENT_SECRET="${2:-}"; shift ;;
    --uninstall)
      systemctl disable --now jms-backup-cloud.timer 2>/dev/null || true
      rm -f /etc/systemd/system/jms-backup-cloud.timer /etc/systemd/system/jms-backup-cloud.service
      systemctl daemon-reload
      echo "Cloud-Sicherung abgeschaltet. ${CONFIG_DIR} und die Daten in Google Drive bleiben erhalten."
      exit 0
      ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
  shift
done
if [[ -n "${CLIENT_ID}" && -z "${CLIENT_SECRET}" ]] || [[ -z "${CLIENT_ID}" && -n "${CLIENT_SECRET}" ]]; then
  echo "--client-id und --client-secret gehören zusammen." >&2
  exit 1
fi

install_units() {
  install -m 0700 "${SCRIPT_DIR}/jms-backup" /usr/local/sbin/jms-backup
  install -m 0644 "${SCRIPT_DIR}/jms-backup-cloud.service" /etc/systemd/system/jms-backup-cloud.service
  install -m 0644 "${SCRIPT_DIR}/jms-backup-cloud.timer" /etc/systemd/system/jms-backup-cloud.timer
  systemctl daemon-reload
}

show_password() {
  cat <<EOF

=====================================================================
  BACKUP-PASSWORT – jetzt sicher aufbewahren (Passwort-Manager oder
  ausgedruckt im Büro). Ohne dieses Passwort lässt sich KEINE
  Sicherung wiederherstellen, auch nicht von euch:

      $(cat "${PASSWORD_FILE}")

  Es liegt auf dem Server unter ${PASSWORD_FILE}.
=====================================================================
EOF
}

# ---------------------------------------------------------------------------
# USB-Platte
# ---------------------------------------------------------------------------
if [[ "${USB}" == "true" ]]; then
  MOUNT="/mnt/jms-backup"
  REPO="${MOUNT}/jms-restic"

  echo "==> Programme (restic)"
  command -v restic >/dev/null || { apt-get update -q && apt-get install -y -q restic; }
  install_units

  # Schon eingerichtet? Dann nur Programme aktualisieren und Timer einschalten.
  if grep -q " ${MOUNT} " /etc/fstab && [[ -f "${MOUNT}/.jms-backup-disk" && "${FORMAT}" != "true" ]]; then
    echo "   USB-Platte ist schon eingerichtet ($(findmnt -n -o SOURCE "${MOUNT}" | tail -1))"
  else
    # Platte, auf der das System liegt – die darf nie gewählt werden
    # (auch durch LVM/Verschlüsselung hindurch bis zur eigentlichen Platte)
    disk_of() { lsblk -srno NAME,TYPE "$1" 2>/dev/null | awk '$2=="disk"{print $1; exit}'; }
    ROOT_DISK="$(disk_of "$(findmnt -n -o SOURCE /)")"
    echo
    echo "   Angeschlossene Datenträger (die Systemplatte ${ROOT_DISK:-?} ist ausgenommen):"
    echo
    lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}' | while read -r disk; do
      [[ "${disk}" == "${ROOT_DISK}" ]] && continue
      lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MODEL,TRAN,MOUNTPOINTS "/dev/${disk}"
      echo
    done
    cat <<EOF

   USB-Stick/-Platte erkennt man an TRAN "usb". Gesichert wird auf eine Partition
   (z. B. sdb1); ein fabrikneuer Datenträger ohne Partition geht auch (z. B. sdb),
   er wird dann formatiert.

EOF
    read -r -p "   Name der Partition für die Sicherung (z. B. sdb1): " PART
    PART="${PART#/dev/}"
    DEV="/dev/${PART}"
    if [[ -z "${PART}" || ! -b "${DEV}" ]]; then
      echo "${DEV} gibt es nicht." >&2
      exit 1
    fi
    PARENT="$(disk_of "${DEV}")"
    if [[ -z "${PARENT}" || "${PARENT}" == "${ROOT_DISK}" ]]; then
      echo "${DEV} liegt auf der Systemplatte – abgebrochen." >&2
      exit 1
    fi
    FSTYPE="$(lsblk -no FSTYPE "${DEV}" | head -1)"
    echo "   ${DEV}: $(lsblk -dno SIZE,MODEL "/dev/${PARENT}" | xargs), Dateisystem: ${FSTYPE:-keins}"

    if [[ "${FORMAT}" == "true" || -z "${FSTYPE}" ]]; then
      echo
      echo "   ${DEV} wird mit ext4 formatiert. ALLE DATEN AUF ${DEV} GEHEN VERLOREN."
      read -r -p "   Zum Bestätigen JA eintippen: " CONFIRM
      [[ "${CONFIRM}" == "JA" ]] || { echo "Abgebrochen."; exit 1; }
      umount "${DEV}" 2>/dev/null || true
      mkfs.ext4 -F -L JMS-BACKUP "${DEV}"
      FSTYPE="ext4"
    fi
    case "${FSTYPE}" in
      ext4|ext3|btrfs|xfs|exfat|vfat) ;;
      ntfs) FSTYPE="ntfs3" ;;  # Kernel-Treiber, schreibt zuverlässig
      *) echo "Dateisystem ${FSTYPE} wird nicht unterstützt – mit --format neu formatieren." >&2; exit 1 ;;
    esac
    UUID="$(blkid -s UUID -o value "${DEV}")"
    [[ -n "${UUID}" ]] || { echo "Keine UUID für ${DEV} gefunden." >&2; exit 1; }

    # Vom Desktop automatisch eingebunden (/media/…)? Dann dort lösen.
    umount "${DEV}" 2>/dev/null || true

    echo "==> Dauerhaft einbinden unter ${MOUNT}"
    install -d -m 0700 "${MOUNT}"
    cp /etc/fstab "/etc/fstab.vor-jms-backup.$(date +%Y%m%d-%H%M%S)"
    sed -i "\| ${MOUNT} |d" /etc/fstab
    # nofail: Server startet auch ohne Platte. automount: wird bei Bedarf eingebunden,
    # auch wenn die Platte erst später (wieder) angesteckt wird.
    echo "UUID=${UUID} ${MOUNT} ${FSTYPE} nofail,noatime,x-systemd.automount,x-systemd.device-timeout=10s 0 0" >>/etc/fstab
    systemctl daemon-reload
    AUTOMOUNT_UNIT="$(systemd-escape -p --suffix=automount "${MOUNT}")"
    systemctl restart "${AUTOMOUNT_UNIT}"
    if ! ls "${MOUNT}" >/dev/null 2>&1 || [[ "$(findmnt -n -o FSTYPE "${MOUNT}" | tail -1)" == "autofs" ]]; then
      echo "Platte lässt sich nicht einbinden – Ausgabe von 'journalctl -n 30' prüfen." >&2
      exit 1
    fi
    # Kennung: Nur wenn diese Datei da ist, sichert jms-backup (sonst ist die Platte nicht dran)
    echo "JMS-Server-Sicherungsplatte, eingerichtet $(date '+%d.%m.%Y')" >"${MOUNT}/.jms-backup-disk"
    echo "   eingebunden: ${DEV} (${FSTYPE}), $(df -h --output=avail "${MOUNT}" | tail -1 | xargs) frei"
  fi

  install -d -m 0700 "${CONFIG_DIR}"
  [[ -f "${CONFIG_FILE}" ]] || cat >"${CONFIG_FILE}" <<EOF
# Einstellungen für die wöchentliche Sicherung (jms-backup --cloud)
RESTIC_REPOSITORY=${REPO}
RESTIC_PASSWORD_FILE=${PASSWORD_FILE}
USB_MOUNT=${MOUNT}

# Telegram-Meldung, wenn eine Sicherung fehlschlägt (leer = keine Meldung).
# Nicht nötig, wenn jms-watch eingerichtet ist: der Störungs-Bot meldet das ohnehin.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# true = auch bei Erfolg eine Meldung
NOTIFY_SUCCESS=false
EOF
  chmod 0600 "${CONFIG_FILE}"
  # Vorhandene Datei (z. B. vom Google-Versuch) auf die USB-Platte umstellen
  sed -i "s|^RESTIC_REPOSITORY=.*|RESTIC_REPOSITORY=${REPO}|; /^RCLONE_CONFIG=/d" "${CONFIG_FILE}"
  if grep -q '^USB_MOUNT=' "${CONFIG_FILE}"; then
    sed -i "s|^USB_MOUNT=.*|USB_MOUNT=${MOUNT}|" "${CONFIG_FILE}"
  else
    echo "USB_MOUNT=${MOUNT}" >>"${CONFIG_FILE}"
  fi

  NEW_PASSWORD="false"
  if [[ ! -s "${PASSWORD_FILE}" ]]; then
    (umask 077 && head -c 32 /dev/urandom | base64 | tr -d '\n=' >"${PASSWORD_FILE}")
  fi
  echo "==> Backup-Repository auf der Platte"
  export RESTIC_REPOSITORY="${REPO}" RESTIC_PASSWORD_FILE="${PASSWORD_FILE}"
  if restic cat config >/dev/null 2>&1; then
    echo "   vorhanden"
  else
    restic init
    NEW_PASSWORD="true"
  fi

  systemctl enable jms-backup-cloud.timer
  systemctl restart jms-backup-cloud.timer
  systemctl reset-failed jms-backup-cloud.service 2>/dev/null || true
  echo
  echo "==> Eingerichtet. Nächste Sicherung:"
  systemctl list-timers jms-backup-cloud.timer --no-pager | sed -n 2p
  if [[ "${NEW_PASSWORD}" == "true" ]]; then show_password; fi
  cat <<EOF

Ersten Durchlauf jetzt starten (Kesher und Companion sind ca. 1 Minute aus):
  sudo systemctl start jms-backup-cloud && journalctl -u jms-backup-cloud -f

Der Datenträger bleibt dauerhaft angeschlossen. Sicherungen anzeigen: sudo jms-backup --list
EOF
  exit 0
fi

echo "==> Programme (restic, rclone)"
missing=()
command -v restic >/dev/null || missing+=(restic)
command -v rclone >/dev/null || missing+=(rclone)
command -v curl >/dev/null || missing+=(curl)
if [[ "${#missing[@]}" -gt 0 ]]; then
  apt-get update -q
  apt-get install -y -q "${missing[@]}"
fi

echo "==> jms-backup installieren"
install_units

install -d -m 0700 "${CONFIG_DIR}"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  cat >"${CONFIG_FILE}" <<EOF
# Einstellungen für jms-backup --cloud
RESTIC_REPOSITORY=rclone:${REMOTE}:${FOLDER}
RESTIC_PASSWORD_FILE=${PASSWORD_FILE}
RCLONE_CONFIG=${RCLONE_CONF}

# Telegram-Meldung, wenn eine Sicherung fehlschlägt (leer = keine Meldung).
# Token: der Kesher-Bot (siehe Dokumentationen/TELEGRAM-BOT.md),
# Chat-ID: z. B. aus Kesher-Admin → Telegram-Benutzer.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# true = auch bei Erfolg eine Meldung
NOTIFY_SUCCESS=false
EOF
  chmod 0600 "${CONFIG_FILE}"
fi

NEW_PASSWORD="false"
if [[ ! -s "${PASSWORD_FILE}" ]]; then
  (umask 077 && head -c 32 /dev/urandom | base64 | tr -d '\n=' >"${PASSWORD_FILE}")
  NEW_PASSWORD="true"
fi

echo "==> Google Drive verbinden"
export RCLONE_CONFIG="${RCLONE_CONF}"
FORCE_LOGIN="false"
if [[ -n "${CLIENT_ID}" ]]; then
  # Eigener Google-Zugang: die alte Anmeldung gehört zum alten Zugang und gilt nicht mehr
  if rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
    rclone config update "${REMOTE}" client_id="${CLIENT_ID}" client_secret="${CLIENT_SECRET}" token= --non-interactive >/dev/null
  else
    rclone config create "${REMOTE}" drive client_id="${CLIENT_ID}" client_secret="${CLIENT_SECRET}" \
      scope=drive.file use_trash=false --non-interactive >/dev/null
  fi
  FORCE_LOGIN="true"
  echo "   eigener Google-Zugang eingetragen"
fi
# Verbunden heißt: Drive antwortet. Nur angelegt, aber ohne Anmeldung, zählt nicht.
if [[ "${FORCE_LOGIN}" != "true" ]] && rclone lsd "${REMOTE}:" >/dev/null 2>&1; then
  echo "   schon verbunden"
else
  if ! rclone listremotes 2>/dev/null | grep -qx "${REMOTE}:"; then
    # drive.file: Der Server sieht nur die Dateien, die er selbst hochgeladen hat.
    # use_trash=false: Gelöschtes belegt keinen Speicher im Papierkorb.
    rclone config create "${REMOTE}" drive scope=drive.file use_trash=false --non-interactive >/dev/null
  fi
  chmod 0600 "${RCLONE_CONF}"
  cat <<EOF

   Jetzt bei Google anmelden:
   1. Die Frage "Use auto config?" mit n beantworten (Server ohne Browser).
   2. Den Befehl "rclone authorize ..." auf dem Mac im Terminal ausführen
      (vorher einmalig: brew install rclone), im Browser mit dem Google-Konto
      für die Technik anmelden und den Zugriff erlauben.
   3. Den Text, den der Mac danach zwischen den Pfeilen ausgibt, hier bei
      "config_token>" einfügen.

EOF
  rclone config reconnect "${REMOTE}:"
  if ! rclone lsd "${REMOTE}:" >/dev/null 2>&1; then
    echo "Google Drive antwortet nicht – Anmeldung fehlgeschlagen. Skript einfach noch einmal starten." >&2
    exit 1
  fi
  echo "   verbunden"
fi

echo "==> Backup-Repository in Google Drive"
set -a
# shellcheck source=/dev/null
source "${CONFIG_FILE}"
set +a
if restic cat config >/dev/null 2>&1; then
  echo "   vorhanden"
else
  restic init
  # Das Passwort zeigen, sobald es wirklich gebraucht wird – auch wenn es aus einem
  # früheren, abgebrochenen Lauf stammt
  NEW_PASSWORD="true"
fi

systemctl enable jms-backup-cloud.timer
systemctl restart jms-backup-cloud.timer
echo
echo "==> Eingerichtet. Nächste Sicherung:"
systemctl list-timers jms-backup-cloud.timer --no-pager | sed -n 2p

if [[ "${NEW_PASSWORD}" == "true" ]]; then show_password; fi
echo
echo "Ersten Durchlauf jetzt starten (Kesher ist ca. 1 Minute aus):"
echo "  sudo systemctl start jms-backup-cloud && journalctl -u jms-backup-cloud -f"
