@echo off
rem Richtet ein, dass der Multiview-Server und die Monitore bei der Anmeldung automatisch starten.
rem Rueckgaengig: schtasks /Delete /TN "Multiview Server" /F  und  schtasks /Delete /TN "Multiview Monitore" /F
cd /d "%~dp0"
schtasks /Create /F /TN "Multiview Server" /SC ONLOGON /TR "\"%~dp0start-windows.bat\""
schtasks /Create /F /TN "Multiview Monitore" /SC ONLOGON /DELAY 0000:30 /TR "\"%~dp0monitore-windows.bat\""
echo.
echo Autostart eingerichtet (Server sofort, Monitore 30 Sekunden spaeter).
pause
