#!/usr/bin/env bash
# Richtet das Aufräumen der Notion-ToDos ein (als root auf dem JMS-Server): sudo bash scripts/notion-archiv/install.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo starten." >&2; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d -m 755 /usr/local/lib/jms-notion-archiv
install -m 755 "$DIR/notion-archiv.py" /usr/local/lib/jms-notion-archiv/notion-archiv.py
install -m 644 "$DIR/jms-notion-archiv.service" /etc/systemd/system/jms-notion-archiv.service
install -m 644 "$DIR/jms-notion-archiv.timer" /etc/systemd/system/jms-notion-archiv.timer
systemctl daemon-reload
systemctl enable --now jms-notion-archiv.timer
echo "Eingerichtet. Probelauf: sudo python3 /usr/local/lib/jms-notion-archiv/notion-archiv.py --dry-run"
