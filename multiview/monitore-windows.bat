@echo off
rem Oeffnet die Multiviews im Vollbild auf den Monitoren dieses Rechners (Chrome im Kiosk-Modus).
rem Fensterpositionen an die eigenen Monitore anpassen: x,y = linke obere Ecke des Monitors.
rem Beenden: Alt+F4 im jeweiligen Fenster.
setlocal
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Google Chrome wurde nicht gefunden.
  pause
  exit /b 1
)

set "FLAGS=--kiosk --new-window --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-first-run --disable-session-crashed-bubble"

rem Multiview 1 auf dem ersten Monitor
start "" "%CHROME%" %FLAGS% --window-position=0,0 --user-data-dir="%TEMP%\multiview-monitor-1" "http://localhost:8090/output.html?id=1"
rem Multiview 2 auf dem zweiten Monitor (rechts daneben)
start "" "%CHROME%" %FLAGS% --window-position=1920,0 --user-data-dir="%TEMP%\multiview-monitor-2" "http://localhost:8090/output.html?id=2"
