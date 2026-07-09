#!/usr/bin/env bash
# Права на client/build для nginx (www-data). Запуск на VPS после любой ручной сборки:
#   bash /opt/erm/scripts/vps-fix-client-build-perms.sh
set -eu

APP_ROOT="${APP_ROOT:-/opt/erm}"
BUILD="$APP_ROOT/client/build"

if [ ! -d "$BUILD" ]; then
  echo "ERROR: $BUILD not found"
  exit 1
fi

chmod -R a+rX "$BUILD"
echo "OK: $BUILD → a+rX"
