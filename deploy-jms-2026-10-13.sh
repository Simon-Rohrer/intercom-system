#!/usr/bin/env bash
# Deploy auf den JMS-Server (192.168.0.21): Kesher-Embed im Multiview,
# Chat-Blinken (nur gelber Rahmen, bei jeder Nachricht), zusammengeführt mit
# dem Stand des Kollegen. Die Compose-Datei (Port-Bindung 127.0.0.1) und das
# Kiosk-Skript auf dem Server bleiben unangetastet.
#
# Auf dem Mac im Repo-Ordner ausführen, nachdem `git pull` den Stand von
# main geholt hat:
#   cd ~/Webseiten/jms-intercom && git pull && bash deploy-jms-2026-10-13.sh
#
# Ablauf:
#   1. prüft per md5, ob die Dateien auf dem Server noch dem Stand
#      entsprechen, den der Kollege dort hatte (Commit 78a0f3a, inzwischen
#      in main zusammengeführt) – sonst Abbruch, damit nichts überschrieben
#      wird, was danach noch auf dem Server geändert wurde
#   2. sichert die Kesher-Datenbank
#   3. kopiert die geänderten Dateien
#   4. baut Multiview und Kesher neu und prüft beide
# Das SSH-Passwort wird nur einmal abgefragt.
set -euo pipefail

HOST=master@192.168.0.21
REMOTE=/home/master/intercom-system
BASE=78a0f3a # Stand des Kollegen auf dem Server (Branch server-stand-kollege)
FILES=(
  Dokumentationen/COMPANION-STREAM-DECK.md
  Kesher/packages/client-core/src/App.tsx
  Kesher/packages/client-core/src/components/StationIntercomView.tsx
  Kesher/packages/client-core/src/components/panels/ChatSignalPanel.test.tsx
  Kesher/packages/client-core/src/components/panels/ChatSignalPanel.tsx
  Kesher/packages/client-core/src/hooks/useIntercomSession.chat.test.tsx
  Kesher/packages/client-core/src/hooks/useIntercomSession.ts
  Kesher/packages/client-core/src/lib/keyGridFit.test.ts
  Kesher/packages/client-core/src/lib/keyGridFit.ts
  Kesher/packages/client-core/src/lib/runtimeMode.test.ts
  Kesher/packages/client-core/src/lib/runtimeMode.ts
  Kesher/packages/client-core/src/styles/app.css
  Kesher/packages/client-core/src/styles/chat-display.css
  Kesher/packages/client-core/src/styles/chat.css
  Kesher/packages/client-core/src/styles/station.css
  multiview/kesher-chat.js
  multiview/public/admin.js
  multiview/public/chat.css
  multiview/public/chat.js
  multiview/public/output.js
  multiview/server.js
)

cd "$(git rev-parse --show-toplevel)"
git cat-file -e "$BASE^{commit}" || { echo "Commit $BASE fehlt – erst git pull"; exit 1; }

# Eine SSH-Verbindung für alle Schritte (Passwort nur einmal)
SOCK=$(mktemp -u /tmp/jms-ssh-XXXXXX)
SSH=(ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=10m)
"${SSH[@]}" -fN "$HOST"
trap '"${SSH[@]}" -O exit "$HOST" 2>/dev/null || true' EXIT

echo "==> 1. Server-Stand prüfen"
conflicts=0
for f in "${FILES[@]}"; do
  if git cat-file -e "$BASE:$f" 2>/dev/null; then
    expected=$(git show "$BASE:$f" | md5 -q 2>/dev/null || git show "$BASE:$f" | md5sum | cut -d' ' -f1)
  else
    expected=missing
  fi
  actual=$("${SSH[@]}" "$HOST" "md5sum '$REMOTE/$f' 2>/dev/null | cut -d' ' -f1 || true")
  [ -z "$actual" ] && actual=missing
  if [ "$actual" != "$expected" ]; then
    # schon der neue Stand? dann ist es kein Konflikt
    new=$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)
    if [ "$actual" != "$new" ]; then
      echo "   ABWEICHUNG auf dem Server: $f"
      conflicts=$((conflicts + 1))
    fi
  fi
done
if [ "$conflicts" -gt 0 ]; then
  echo "Abbruch: $conflicts Datei(en) wurden auf dem Server geändert. Erst mit dem Kollegen abgleichen."
  exit 1
fi
echo "   ok – keine fremden Änderungen"

echo "==> 2. Sicherung (Kesher-Datenbank + betroffene Dateien)"
B=/home/master/backups/$(date +%Y%m%d-%H%M%S)-embed-chatflash
"${SSH[@]}" "$HOST" "mkdir -p $B && cd $REMOTE && tar czf $B/dateien.tgz --ignore-failed-read ${FILES[*]} 2>/dev/null; \
  docker run --rm -v compose_intercom_data:/data:ro -v $B:/backup alpine:3.21 tar czf /backup/intercom_data.tgz -C /data . && echo '   '$B"

echo "==> 3. Dateien kopieren"
tar czf - "${FILES[@]}" | "${SSH[@]}" "$HOST" "tar xzf - -C $REMOTE"

echo "==> 4a. Multiview neu bauen"
"${SSH[@]}" "$HOST" "cd $REMOTE/multiview && docker compose up -d --build >/dev/null && sleep 5 && \
  curl -fsS localhost:8090/api/chat | head -c 200; echo"

echo "==> 4b. Kesher neu bauen (läuft während des Builds weiter)"
"${SSH[@]}" "$HOST" "cd $REMOTE/Kesher && \
  docker compose -f deploy/compose/docker-compose.yml build --build-arg VERSION=\$(git rev-parse --short HEAD)-embed --build-arg BUILD_TIMESTAMP=\$(date -u +%Y-%m-%dT%H:%M:%SZ) && \
  docker compose -f deploy/compose/docker-compose.yml up -d && sleep 8 && curl -fsS http://127.0.0.1:8080/api/healthz; echo"

echo "Fertig. Sicherung: $B"
