@echo off
rem Installiert den Multiview-Server (Node-Pakete + MediaMTX). Doppelklick genuegt.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
echo.
pause
