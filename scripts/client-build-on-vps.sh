#!/usr/bin/env bash
# Единственный правильный способ собрать клиент на VPS (права для nginx).
#   bash /opt/erm/scripts/client-build-on-vps.sh
set -eu

APP_ROOT="${APP_ROOT:-/opt/erm}"

cd "$APP_ROOT/client"
umask 022
npm run build
bash "$APP_ROOT/scripts/vps-fix-client-build-perms.sh"
