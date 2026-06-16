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
REPO_MODULE="$REPO_ROOT/companion"
TARGET="/opt/companion-module-dev/companion-module-kesher"

echo "▶ Synchronisiere Modul von $REPO_MODULE nach $TARGET ..."
mkdir -p "$TARGET/companion"
mkdir -p "$TARGET/dist"

# Manifest direkt aus Git holen (unabhängig vom Working Tree)
echo "  → companion/manifest.json (aus Git)"
git -C "$REPO_ROOT" show HEAD:companion/companion/manifest.json > "$TARGET/companion/manifest.json"

# Kompilierte dist-Dateien kopieren
echo "  → dist/"
rsync -av "$REPO_MODULE/dist/" "$TARGET/dist/"

# package.json kopieren (wird für node_modules benötigt)
echo "  → package.json"
cp -f "$REPO_MODULE/package.json" "$TARGET/package.json"

# .yarnrc.yml mit node-modules linker (benötigt für Companion-Kompatibilität)
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
systemctl status companion --no-pager | head -20

