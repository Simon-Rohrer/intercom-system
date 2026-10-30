#!/bin/sh
set -eu
# Kept outside Companion/CompanionPi, which their updater replaces.
if ! ip -6 address show | grep -q inet6; then
    export DISABLE_IPV6=1
fi
cd /opt/companion
if [ -x node-runtimes/main/bin/node ]; then
    node_exe=/opt/companion/node-runtimes/main/bin/node
else
    node_exe=/opt/companion/node-runtime/bin/node
fi
exec "$node_exe" /opt/companion/main.js --admin-address 127.0.0.1 --extra-module-path /opt/companion-module-dev
