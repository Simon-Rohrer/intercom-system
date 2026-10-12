#!/usr/bin/env bash
# Öffnet die Multiviews im Vollbild auf den Monitoren dieses Rechners (Chrome/Chromium im Kiosk-Modus).
# Die Fensterpositionen an die eigenen Monitore anpassen: x,y = linke obere Ecke des Monitors.
cd "$(dirname "$0")"

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "Chrome/Chromium nicht gefunden."
  exit 1
fi

open_monitor() { # $1 = Multiview-Nummer, $2 = Position "x,y"
  "$CHROME" --kiosk --new-window --window-position="$2" \
    --user-data-dir="/tmp/multiview-monitor-$1" \
    --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
    --no-first-run --disable-session-crashed-bubble \
    "http://localhost:8090/output.html?id=$1" >/dev/null 2>&1 &
}

open_monitor 1 "0,0"      # Multiview 1 auf dem ersten Monitor
open_monitor 2 "1920,0"   # Multiview 2 auf dem zweiten Monitor (rechts daneben)
