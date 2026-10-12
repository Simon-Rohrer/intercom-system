@echo off
rem Startet den Multiview-Server. Das Fenster offen lassen, solange der Multiview laufen soll.
rem Webseite: http://localhost:8090  (anderer Port: vorher "set PORT=9000")
title Multiview-Server
cd /d "%~dp0"
node server.js
echo.
echo Der Server wurde beendet.
pause
