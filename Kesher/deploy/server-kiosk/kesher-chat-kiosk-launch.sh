#!/usr/bin/env bash
# Starts the Kesher chat display full-screen on the local monitor.
# Run by kesher-chat-kiosk.service (cage as Wayland kiosk compositor on tty1).
set -euo pipefail

CONFIG_FILE="/etc/kesher/chat-kiosk.env"
if [[ -f "${CONFIG_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
fi

KESHER_URL="${KESHER_URL:-http://127.0.0.1:8080}"
KESHER_USERNAME="${KESHER_USERNAME:-Chat-Monitor}"
KESHER_ROLE_ID="${KESHER_ROLE_ID:-chat-monitor}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"

urlencode() {
  local raw="$1" out="" ch i
  for ((i = 0; i < ${#raw}; i++)); do
    ch="${raw:i:1}"
    case "${ch}" in
      [a-zA-Z0-9.~_-]) out+="${ch}" ;;
      *) out+="$(printf '%%%02X' "'${ch}")" ;;
    esac
  done
  printf '%s' "${out}"
}

# Wait for Kesher instead of showing a browser error page after boot.
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until curl -fsS --max-time 3 "${KESHER_URL}/api/healthz" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo "Kesher not reachable at ${KESHER_URL} after ${HEALTH_TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  sleep 3
done

BROWSER=""
for candidate in /snap/bin/chromium /usr/bin/chromium /usr/bin/chromium-browser; do
  if [[ -x "${candidate}" ]]; then
    BROWSER="${candidate}"
    break
  fi
done
if [[ -z "${BROWSER}" ]]; then
  echo "Chromium not found." >&2
  exit 1
fi

DISPLAY_URL="${KESHER_URL}/?autoLogin=1&autoTakeover=1&viewMode=chat&username=$(urlencode "${KESHER_USERNAME}")&roleId=$(urlencode "${KESHER_ROLE_ID}")"

# -s keeps Ctrl+Alt+F2..F6 working for a console login on the server.
exec /usr/bin/cage -s -- "${BROWSER}" \
  --kiosk \
  --incognito \
  --ozone-platform=wayland \
  --no-first-run \
  --no-default-browser-check \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,MediaRouter \
  --disable-sync \
  --disable-extensions \
  --password-store=basic \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --mute-audio \
  "${DISPLAY_URL}"
