#!/usr/bin/env bash
# Installiert das Companion-Modul „JMS Control“ (Multiviews per Stream Deck umschalten)
# in Companions Developer-Modul-Ordner. Gegenstück zu deploy-companion-module.sh (Kesher).
#
# Aufruf auf dem Server:
#   sudo bash scripts/deploy-companion-jms-control.sh
#   sudo bash scripts/deploy-companion-jms-control.sh /tmp/jms-control-1.0.0.tgz
#
# Der Geräteschlüssel jms-device.key (festes Gerät „Companion-JMS-Control“, Dienst multiview,
# Recht „control“) gehört nicht ins Paket; er wird aus der vorherigen Installation übernommen.

set -euo pipefail

TARGET="${COMPANION_MODULE_TARGET:-/opt/companion-module-dev/companion-module-jms-control}"
BACKUP_ROOT="${COMPANION_MODULE_BACKUP_ROOT:-/opt/companion-module-backups}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)/companion-jms-control"
PACKAGE_PATH="${1:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Bitte mit sudo starten." >&2
  exit 1
fi

if [[ -z "$PACKAGE_PATH" ]]; then
  MODULE_VERSION="$(grep -o '"version": *"[^"]*"' "$MODULE_ROOT/package.json" | head -1 | cut -d'"' -f4)"
  PACKAGE_PATH="$MODULE_ROOT/jms-control-$MODULE_VERSION.tgz"
fi
if [[ ! -f "$PACKAGE_PATH" ]]; then
  echo "Paket nicht gefunden: $PACKAGE_PATH (vorher: cd companion-jms-control && npm install && npm run package)" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
tar -xzf "$PACKAGE_PATH" -C "$WORK_DIR"
PACKAGE_ROOT="$WORK_DIR/pkg"
if [[ ! -f "$PACKAGE_ROOT/companion/manifest.json" || ! -f "$PACKAGE_ROOT/main.js" || ! -f "$PACKAGE_ROOT/package.json" ]]; then
  echo "Ungültiges Companion-Paket: manifest.json, main.js oder package.json fehlt." >&2
  exit 1
fi

# Companion 5 behandelt Module im Developer-Ordner als ungepackt und liest dafür die Version von @companion-module/base
MODULE_API_VERSION="$(grep -o '"apiVersion":"[^"]*"' "$PACKAGE_ROOT/companion/manifest.json" | cut -d'"' -f4)"
mkdir -p "$PACKAGE_ROOT/node_modules/@companion-module/base"
printf '{"name":"@companion-module/base","version":"%s"}\n' "$MODULE_API_VERSION" \
  > "$PACKAGE_ROOT/node_modules/@companion-module/base/package.json"

mkdir -p "$(dirname "$TARGET")" "$BACKUP_ROOT"
BACKUP=""
if [[ -e "$TARGET" ]]; then
  BACKUP="$BACKUP_ROOT/companion-module-jms-control.backup.$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "Vorheriges Modul gesichert: $BACKUP"
fi

mv "$PACKAGE_ROOT" "$TARGET"
chown -R root:companion "$TARGET"
chmod -R u=rwX,g=rX,o= "$TARGET"

if [[ -n "$BACKUP" && -f "$BACKUP/jms-device.key" ]]; then
  install -m 0640 -o root -g companion "$BACKUP/jms-device.key" "$TARGET/jms-device.key"
  echo "Geräteschlüssel aus dem vorherigen Modul übernommen"
else
  echo "WARNUNG: kein jms-device.key – Gerät „Companion-JMS-Control“ unter Einstellungen → Anmeldung registrieren" >&2
  echo "         (Dienst Multiview, Recht Steuern) und den Schlüssel nach $TARGET/jms-device.key legen (0640 root:companion)." >&2
fi

if ! systemctl restart companion; then
  echo "Companion-Neustart fehlgeschlagen – stelle das vorherige Modul wieder her." >&2
  mv "$TARGET" "$BACKUP_ROOT/companion-module-jms-control.failed.$(date +%Y%m%d-%H%M%S)"
  [[ -n "$BACKUP" ]] && mv "$BACKUP" "$TARGET"
  systemctl restart companion || true
  exit 1
fi
sleep 2
echo "Companion-Modul JMS Control installiert aus $PACKAGE_PATH"
