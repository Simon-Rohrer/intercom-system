#!/usr/bin/env bash
# Richtet die stündliche Sicherung des Server-Stands ein (als root auf dem JMS-Server).
#   sudo bash scripts/server-stand/install.sh
# Legt bei Bedarf den Deploy-Schlüssel /home/master/.ssh/jms-server-stand an und zeigt den
# öffentlichen Teil – den muss ein Admin des GitHub-Repositorys als Deploy-Key MIT Schreibrecht eintragen.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo starten." >&2; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -d -m 755 /usr/local/lib/jms-server-stand
install -m 755 "$DIR/jms-server-stand.sh" /usr/local/lib/jms-server-stand/jms-server-stand.sh
install -m 644 "$DIR/jms-server-stand.service" /etc/systemd/system/jms-server-stand.service
install -m 644 "$DIR/jms-server-stand.timer" /etc/systemd/system/jms-server-stand.timer

KEY=/home/master/.ssh/jms-server-stand
if [[ ! -f "$KEY" ]]; then
  sudo -u master ssh-keygen -q -t ed25519 -N '' -C 'jms-server-stand (Deploy-Key, nur intercom-system)' -f "$KEY"
fi
# GitHub-Hostschlüssel (ed25519, von GitHub veröffentlicht) bekannt machen
GH='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
sudo -u master grep -qF "$GH" /home/master/.ssh/known_hosts 2>/dev/null || echo "$GH" | sudo -u master tee -a /home/master/.ssh/known_hosts >/dev/null

systemctl daemon-reload
systemctl enable --now jms-server-stand.timer
echo
echo "Deploy-Key (öffentlich) – in GitHub unter Settings → Deploy keys → Add deploy key eintragen, „Allow write access“ anhaken:"
cat "$KEY.pub"
