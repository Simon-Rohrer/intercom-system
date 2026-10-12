@echo off
rem Gibt in der Windows-Firewall die Ports fuer den Multiview frei.
rem Rechtsklick -> "Als Administrator ausfuehren".
net session >nul 2>&1
if errorlevel 1 (
  echo Bitte mit Rechtsklick "Als Administrator ausfuehren".
  pause
  exit /b 1
)
netsh advfirewall firewall add rule name="Multiview Webseite (8090/TCP)" dir=in action=allow protocol=TCP localport=8090
netsh advfirewall firewall add rule name="Multiview RTMP (1935/TCP)" dir=in action=allow protocol=TCP localport=1935
netsh advfirewall firewall add rule name="Multiview RTSP (8554/TCP)" dir=in action=allow protocol=TCP localport=8554
netsh advfirewall firewall add rule name="Multiview SRT (8890/UDP)" dir=in action=allow protocol=UDP localport=8890
netsh advfirewall firewall add rule name="Multiview WebRTC (8189/UDP)" dir=in action=allow protocol=UDP localport=8189
echo.
echo Ports freigegeben.
pause
