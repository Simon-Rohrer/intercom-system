#!/usr/bin/env bash
# Startet den Multiview-Server (Webseite auf Port 8090, anderer Port: PORT=9000 ./start-linux.sh)
cd "$(dirname "$0")"
exec node server.js
