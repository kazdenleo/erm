#!/usr/bin/env bash
# Права на client/ и client/build для nginx (www-data).
# Режим 700 на /opt/erm/client блокирует traverse → SPA 404 даже при открытом build/.
# Запуск на VPS после любой ручной сборки:
#   bash /opt/erm/scripts/vps-fix-client-build-perms.sh
set -eu

APP_ROOT="${APP_ROOT:-/opt/erm}"
CLIENT="$APP_ROOT/client"
BUILD="$CLIENT/build"

if [ ! -d "$CLIENT" ]; then
  echo "ERROR: $CLIENT not found"
  exit 1
fi

# Родительский каталог: иначе www-data не может пройти к build/ (Permission denied).
chmod 755 "$CLIENT"

if [ ! -d "$BUILD" ]; then
  echo "WARN: $BUILD not found (client dir set to 755)"
  exit 0
fi

chmod -R a+rX "$BUILD"
echo "OK: $CLIENT → 755; $BUILD → a+rX"
