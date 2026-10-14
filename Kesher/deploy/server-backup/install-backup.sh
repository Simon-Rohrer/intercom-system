#!/usr/bin/env bash
# Richtet die Sicherung des JMS-Servers ein:
#   - installiert restic und rclone
#   - installiert /usr/local/sbin/jms-backup (ersetzt die bisherige Fassung)
#   - verbindet Google Drive (Anmeldung einmalig über einen Rechner mit Browser)
#   - legt das verschlüsselte Backup-Repository an
#   - schaltet die nächtliche Sicherung um 3:30 Uhr ein
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
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --client-id) CLIENT_ID="${2:-}"; shift ;;
    --client-secret) CLIENT_SECRET="${2:-}"; shift ;;
    --uninstall)
      systemctl disable --now jms-backup-cloud.timer 2>/dev/null || true
      rm -f /etc/systemd/system/jms-backup-cloud.timer /etc/systemd/system/jms-backup-cloud.service
      systemctl daemon-reload
      echo "Nächtliche Cloud-Sicherung abgeschaltet. ${CONFIG_DIR} und die Daten in Google Drive bleiben erhalten."
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
install -m 0700 "${SCRIPT_DIR}/jms-backup" /usr/local/sbin/jms-backup
install -m 0644 "${SCRIPT_DIR}/jms-backup-cloud.service" /etc/systemd/system/jms-backup-cloud.service
install -m 0644 "${SCRIPT_DIR}/jms-backup-cloud.timer" /etc/systemd/system/jms-backup-cloud.timer
systemctl daemon-reload

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

if [[ "${NEW_PASSWORD}" == "true" ]]; then
  cat <<EOF

=====================================================================
  BACKUP-PASSWORT – jetzt sicher aufbewahren (Passwort-Manager oder
  ausgedruckt im Büro). Ohne dieses Passwort lässt sich KEINE
  Sicherung wiederherstellen, auch nicht von euch:

      $(cat "${PASSWORD_FILE}")

  Es liegt auf dem Server unter ${PASSWORD_FILE}.
=====================================================================
EOF
fi
echo
echo "Ersten Durchlauf jetzt starten (Kesher ist ca. 1 Minute aus):"
echo "  sudo systemctl start jms-backup-cloud && journalctl -u jms-backup-cloud -f"
