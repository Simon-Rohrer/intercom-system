#!/usr/bin/env bash
# Installs a packaged Kesher Companion module into Companion's developer-module
# directory. Packaged modules are self-contained and do not need node_modules on
# the Companion server.
#
# Usage:
#   sudo bash scripts/deploy-companion-module.sh
#   sudo bash scripts/deploy-companion-module.sh /tmp/kesher-0.2.4.tgz

set -euo pipefail

TARGET="${COMPANION_MODULE_TARGET:-/opt/companion-module-dev/companion-module-kesher}"
BACKUP_ROOT="${COMPANION_MODULE_BACKUP_ROOT:-/opt/companion-module-backups}"
PACKAGE_PATH="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODULE_ROOT="$REPO_ROOT/companion"

if [[ $EUID -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

run_as_repo_owner() {
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    sudo -u "$SUDO_USER" -- "$@"
  else
    "$@"
  fi
}

if [[ -z "$PACKAGE_PATH" ]]; then
  mapfile -t PREBUILT_PACKAGES < <(find "$MODULE_ROOT" -maxdepth 1 -type f -name 'kesher-*.tgz' -print | sort)
  if [[ ${#PREBUILT_PACKAGES[@]} -gt 0 ]]; then
    PACKAGE_PATH="${PREBUILT_PACKAGES[${#PREBUILT_PACKAGES[@]}-1]}"
    echo "No package supplied; using repository package $PACKAGE_PATH"
  else
    echo "No package supplied; building the Companion package from $MODULE_ROOT"
  fi
fi

if [[ -z "$PACKAGE_PATH" ]]; then
  if command -v yarn >/dev/null 2>&1; then
    pushd "$MODULE_ROOT" >/dev/null
    YARN_MAJOR="$(yarn --version | cut -d. -f1)"
    if [[ "$YARN_MAJOR" -ge 2 ]]; then
      run_as_repo_owner yarn install --immutable
    else
      run_as_repo_owner yarn install --frozen-lockfile
    fi
    run_as_repo_owner yarn package
    popd >/dev/null
  else
    NODE="$(find /opt/companion/node-runtimes -name node -type f -print -quit 2>/dev/null || true)"
    NPM_CLI="$(find /opt/companion -name npm-cli.js -type f -print -quit 2>/dev/null || true)"
    if [[ -n "$NODE" && -n "$NPM_CLI" ]]; then
      NODE_DIR="$(dirname "$NODE")"
      run_as_repo_owner env PATH="$NODE_DIR:$PATH" "$NODE" "$NPM_CLI" --prefix "$MODULE_ROOT" install --include=dev
      run_as_repo_owner env PATH="$NODE_DIR:$PATH" "$NODE" "$NPM_CLI" --prefix "$MODULE_ROOT" run package
    elif command -v npm >/dev/null 2>&1; then
      run_as_repo_owner npm --prefix "$MODULE_ROOT" install --include=dev
      run_as_repo_owner npm --prefix "$MODULE_ROOT" run package
    else
      echo "Neither yarn/npm nor Companion's bundled Node/npm runtime was found." >&2
      exit 1
    fi
  fi

  mapfile -t BUILT_PACKAGES < <(find "$MODULE_ROOT" -maxdepth 1 -type f -name 'kesher-*.tgz' -print | sort)
  if [[ ${#BUILT_PACKAGES[@]} -eq 0 ]]; then
    echo "Companion package build completed without producing kesher-*.tgz." >&2
    exit 1
  fi
  PACKAGE_PATH="${BUILT_PACKAGES[${#BUILT_PACKAGES[@]}-1]}"
fi

if [[ ! -f "$PACKAGE_PATH" ]]; then
  echo "Package not found: $PACKAGE_PATH" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

tar -xzf "$PACKAGE_PATH" -C "$WORK_DIR"
PACKAGE_ROOT="$WORK_DIR/pkg"
if [[ ! -f "$PACKAGE_ROOT/companion/manifest.json" || ! -f "$PACKAGE_ROOT/main.js" || ! -f "$PACKAGE_ROOT/package.json" ]]; then
  echo "Invalid Companion package: manifest.json, main.js or package.json is missing." >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")" "$BACKUP_ROOT"

# Companion scans every direct child of the developer-module directory. Move
# backups created by older installer versions out of that directory before the
# service restarts, otherwise Companion tries to launch them as duplicate modules.
for STALE_MODULE in "${TARGET}.backup."* "${TARGET}.failed."*; do
  if [[ -e "$STALE_MODULE" ]]; then
    mv "$STALE_MODULE" "$BACKUP_ROOT/$(basename "$STALE_MODULE")"
    echo "Moved stale module backup out of the developer directory: $STALE_MODULE"
  fi
done

BACKUP=""
if [[ -e "$TARGET" ]]; then
  BACKUP="$BACKUP_ROOT/companion-module-kesher.backup.$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$BACKUP"
  echo "Previous module saved as $BACKUP"
fi

mv "$PACKAGE_ROOT" "$TARGET"
chown -R companion:companion "$TARGET"

if ! systemctl restart companion; then
  echo "Companion restart failed. Restoring the previous module." >&2
  mv "$TARGET" "$BACKUP_ROOT/companion-module-kesher.failed.$(date +%Y%m%d-%H%M%S)"
  if [[ -n "$BACKUP" ]]; then
    mv "$BACKUP" "$TARGET"
    systemctl restart companion || true
  fi
  exit 1
fi

sleep 2
echo "Kesher Companion module installed from $PACKAGE_PATH"
systemctl status companion --no-pager --lines=25
