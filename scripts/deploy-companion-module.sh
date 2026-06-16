#!/bin/bash
# =============================================================
# deploy-companion-module.sh
# Kopiert das Kesher-Companion-Modul aus dem Repo nach
# /opt/companion-module-dev und startet Companion neu.
#
# Ausführen: sudo bash deploy-companion-module.sh
# =============================================================

set -e

REPO_MODULE="/home/master/intercom-system/companion"
TARGET="/opt/companion-module-dev/companion-module-kesher"

echo "▶ Synchronisiere Modul von $REPO_MODULE nach $TARGET ..."
mkdir -p "$TARGET"

# dist/ und companion/ (Manifest) kopieren
rsync -av --delete \
  "$REPO_MODULE/dist/" \
  "$TARGET/dist/"

rsync -av --delete \
  "$REPO_MODULE/companion/" \
  "$TARGET/companion/"

rsync -av \
  "$REPO_MODULE/package.json" \
  "$TARGET/package.json"

# node_modules installieren falls noch nicht vorhanden
if [ ! -d "$TARGET/node_modules" ]; then
  echo "▶ Installiere node_modules in $TARGET ..."
  cd "$TARGET"
  # .yarnrc.yml mit node-modules linker anlegen
  echo "nodeLinker: node-modules" > .yarnrc.yml
  yarn install --no-immutable || npm install --omit=dev
fi

# Berechtigungen setzen
chown -R companion:companion "$TARGET"

echo ""
echo "▶ Starte Companion neu ..."
systemctl restart companion

echo ""
echo "✅ Fertig! Das Kesher-Modul ist installiert und Companion läuft neu."
echo "   Prüfe den Status mit: systemctl status companion"
