#!/bin/bash
# =============================================================
# deploy-companion-module.sh
# Kopiert das Kesher-Companion-Modul aus dem Repo nach
# /opt/companion-module-dev und startet Companion neu.
#
# Ausführen: cd ~/intercom-system && sudo bash scripts/deploy-companion-module.sh
# =============================================================

set -e

REPO_ROOT="/home/master/intercom-system"
TARGET="/opt/companion-module-dev/companion-module-kesher"

# Alle benötigten Dateien aus Git direkt extrahieren (unabhängig vom Working Tree)
DIST_FILES="actions config feedbacks imageBridge imageRenderer main presets types upgrades variables"

echo "▶ Extrahiere Modul-Dateien direkt aus Git nach $TARGET ..."
mkdir -p "$TARGET/companion"
mkdir -p "$TARGET/dist"

# manifest.json aus Git
echo "  → companion/manifest.json"
git -C "$REPO_ROOT" show HEAD:companion/companion/manifest.json > "$TARGET/companion/manifest.json"

# dist/*.js aus Git
echo "  → dist/*.js"
for f in $DIST_FILES; do
  git -C "$REPO_ROOT" show HEAD:companion/dist/${f}.js > "$TARGET/dist/${f}.js"
  echo "      ${f}.js"
done

# package.json aus Git
echo "  → package.json"
git -C "$REPO_ROOT" show HEAD:companion/package.json > "$TARGET/package.json"

# .yarnrc.yml mit node-modules linker
echo "nodeLinker: node-modules" > "$TARGET/.yarnrc.yml"

# node_modules installieren
echo ""
echo "▶ Installiere node_modules in $TARGET ..."
cd "$TARGET"
yarn install --no-immutable 2>/dev/null || npm install --omit=dev

# Berechtigungen setzen
echo ""
echo "▶ Setze Berechtigungen ..."
chown -R companion:companion "$TARGET"

echo ""
echo "▶ Starte Companion neu ..."
systemctl restart companion

echo ""
echo "✅ Fertig! Das Kesher-Modul ist installiert."
sleep 2
echo ""
echo "--- Companion Status ---"
systemctl status companion --no-pager | head -25
