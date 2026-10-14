#!/usr/bin/env bash
# Runs inside the sway session of the kiosk (KIOSK_URL="screens", started by
# kesher-chat-kiosk-launch.sh): opens one browser window per connected monitor
# (HDMI, DisplayPort, VGA ...) with the multiview page for that connector. sway
# moves each window to its output by title. Which multiview a monitor shows is
# chosen in the multiview editor and switches live, without touching this session.
# When a monitor is plugged in or removed, or the browser is gone, the session
# ends and systemd starts it fresh.
set -u

BROWSER="${KIOSK_BROWSER:?}"
read -r -a BROWSER_FLAGS <<<"${KIOSK_BROWSER_FLAGS:-}"
BASE_URL="${MULTIVIEW_URL%/}"
PAGE="${BASE_URL}/output.html?screen="

connected_outputs() {
  local status name
  for status in /sys/class/drm/card*-*/status; do
    [[ "$(cat "${status}" 2>/dev/null)" == "connected" ]] || continue
    name="${status%/status}"
    name="${name##*/}"
    echo "${name#card*-}"
  done | sort
}

browser_running() {
  pgrep -u "$(id -u)" -f -- "output.html[?]screen=" >/dev/null
}

outputs="$(connected_outputs)"
first="true"
for name in ${outputs}; do
  # One browser for all windows: so several monitors can share a capture card.
  "${BROWSER}" "${BROWSER_FLAGS[@]}" --app="${PAGE}${name}" >/dev/null 2>&1 &
  if [[ "${first}" == "true" ]]; then
    first="false"
    sleep 5 # the first call starts the browser, the next ones open windows in it
  else
    sleep 1
  fi
done

# The onboard VGA (a DisplayPort-to-VGA bridge, shows up as DP-1/DP-2) can stay
# black after the first mode set although the monitor reports a signal. Turning
# every output off and on once more sets the mode again and brings up the picture.
sleep 3
for name in ${outputs}; do
  swaymsg "output ${name} power off" >/dev/null 2>&1
  sleep 1
  swaymsg "output ${name} power on" >/dev/null 2>&1
done

while sleep 5; do
  if [[ "$(connected_outputs)" != "${outputs}" ]] || { [[ -n "${outputs}" ]] && ! browser_running; }; then
    swaymsg exit >/dev/null 2>&1
    exit 0
  fi
done
