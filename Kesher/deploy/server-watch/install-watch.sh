#!/usr/bin/env bash
# Richtet die Störungsmeldungen per Telegram ein (eigener Bot, nur dafür):
#   - installiert /usr/local/sbin/jms-watch und den Minuten-Timer
#   - fragt nach dem Bot-Token und findet die Chat-ID selbst
#
#   cd ~/intercom-system/Kesher/deploy/server-watch && sudo ./install-watch.sh
#
# Nochmal ausführen ist unschädlich (z. B. nach einem Update): Token und Chat-ID bleiben.
#   sudo ./install-watch.sh --new-bot     anderen Bot / anderen Chat eintragen
#   sudo ./install-watch.sh --uninstall   Timer abschalten (Einstellungen bleiben)
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bitte mit sudo ausführen." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="/etc/jms-watch"
CONFIG_FILE="${CONFIG_DIR}/watch.env"

NEW_BOT="false"
case "${1:-}" in
  "") ;;
  --new-bot) NEW_BOT="true" ;;
  --uninstall)
    systemctl disable --now jms-watch.timer jms-watch-bot.service 2>/dev/null || true
    rm -f /etc/systemd/system/jms-watch.timer /etc/systemd/system/jms-watch.service /etc/systemd/system/jms-watch-bot.service
    systemctl daemon-reload
    echo "Störungsmeldungen abgeschaltet. ${CONFIG_DIR} bleibt erhalten."
    exit 0
    ;;
  *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
esac

command -v python3 >/dev/null || { apt-get update -q && apt-get install -y -q python3; }

echo "==> jms-watch installieren"
install -m 0755 "${SCRIPT_DIR}/jms-watch" /usr/local/sbin/jms-watch
install -m 0644 "${SCRIPT_DIR}/jms-watch.service" /etc/systemd/system/jms-watch.service
install -m 0644 "${SCRIPT_DIR}/jms-watch.timer" /etc/systemd/system/jms-watch.timer
install -m 0644 "${SCRIPT_DIR}/jms-watch-bot.service" /etc/systemd/system/jms-watch-bot.service
systemctl daemon-reload
# Der Bot-Dienst liest dieselben Nachrichten wie die Chat-ID-Suche – solange anhalten
systemctl stop jms-watch-bot.service 2>/dev/null || true

install -d -m 0700 "${CONFIG_DIR}"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  cat >"${CONFIG_FILE}" <<CONF
# Einstellungen für jms-watch (Störungsmeldungen per Telegram)
# Eigener Bot nur für Störungen – nicht der Kesher-Bot.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SERVER_NAME=JMS-Server

# Erst melden, wenn ein Problem so viele Minuten hintereinander besteht
FAIL_AFTER=3
INTERNET_FAIL_AFTER=2
# „Läuft wieder“ erst nach so vielen guten Runden
OK_AFTER=2

# Dienste, die laufen müssen (nur wenn vorhanden und beim Start eingeschaltet).
# Zusätzlich wird jede Unit gemeldet, die in systemd als „failed“ steht.
WATCH_UNITS=docker caddy tailscaled companion multiview kesher-chat-kiosk
# Units/Container, die nie gemeldet werden sollen (Leerzeichen-getrennt)
IGNORE_UNITS=
IGNORE_CONTAINERS=
# Weboberflächen ohne Docker-Healthcheck: Name=URL (Leerzeichen-getrennt)
HTTP_CHECKS=Companion=http://127.0.0.1:8000
# Warnung, wenn / so voll ist (Prozent)
DISK_WARN_PERCENT=90
CONF
  chmod 0600 "${CONFIG_FILE}"
fi

set_value() {
  local key="$1" value="$2"
  sed -i "s|^${key}=.*|${key}=${value}|" "${CONFIG_FILE}"
}
current() {
  sed -n "s/^$1=//p" "${CONFIG_FILE}" | tail -1
}

if [[ "${NEW_BOT}" == "true" || -z "$(current TELEGRAM_BOT_TOKEN)" ]]; then
  cat <<TXT

   Neuen Bot anlegen (in der Telegram-App):
   1. @BotFather öffnen und /newbot senden.
   2. Namen vergeben (z. B. "JMS Störungen") und einen Benutzernamen, der auf "bot" endet.
   3. Den Token kopieren, den BotFather schickt (sieht aus wie 123456789:AA...).

TXT
  read -r -s -p "   Bot-Token hier einfügen (wird nicht angezeigt): " TOKEN
  echo
  TOKEN="$(echo "${TOKEN}" | tr -d '[:space:]')"
  if ! curl -fsS --max-time 15 "https://api.telegram.org/bot${TOKEN}/getMe" >/dev/null; then
    echo "Telegram kennt diesen Token nicht (oder kein Internet). Skript einfach noch einmal starten." >&2
    exit 1
  fi
  set_value TELEGRAM_BOT_TOKEN "${TOKEN}"
  set_value TELEGRAM_CHAT_ID ""
fi

if [[ -z "$(current TELEGRAM_CHAT_ID)" ]]; then
  echo
  echo "   Jetzt in Telegram den neuen Bot öffnen und auf START tippen (oder /start senden)."
  if ! CHAT_ID="$(/usr/local/sbin/jms-watch --find-chat)"; then
    echo "Keine Nachricht an den Bot angekommen. Skript einfach noch einmal starten." >&2
    exit 1
  fi
  set_value TELEGRAM_CHAT_ID "${CHAT_ID}"
  echo "   Chat-ID ${CHAT_ID} eingetragen."
fi

# /status im Menü des Bots anzeigen
curl -fsS --max-time 15 "https://api.telegram.org/bot$(current TELEGRAM_BOT_TOKEN)/setMyCommands" \
  --data-urlencode 'commands=[{"command":"status","description":"Zustand des Servers"}]' >/dev/null || true

systemctl enable jms-watch.timer jms-watch-bot.service
systemctl restart jms-watch.timer jms-watch-bot.service
# Erste Runde sofort: schickt beim ersten Mal die Begrüßung an den Bot
systemctl start jms-watch.service || true

echo
echo "==> Eingerichtet. Aktueller Zustand:"
/usr/local/sbin/jms-watch --status
cat <<TXT

Im Bot zeigt /status jederzeit den Zustand. Testnachricht: sudo jms-watch --test
Einstellungen: ${CONFIG_FILE}  –  Protokoll: journalctl -u jms-watch -n 50
TXT
