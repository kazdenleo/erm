#!/usr/bin/env bash
# Деплой на VPS: git pull, зависимости, сборка клиента, миграции, pm2.
# Запуск на сервере: bash /opt/erm/scripts/deploy-vps.sh
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
PM2_NAME="${PM2_NAME:-erm-api}"

cd "$APP_ROOT"
echo "==> git pull"
git pull origin main

echo "==> server dependencies"
cd "$APP_ROOT/server"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

if [ -f "$APP_ROOT/server/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_ROOT/server/.env"
  set +a
fi
if [ "${USE_POSTGRESQL:-true}" != "true" ]; then
  echo "ERROR: USE_POSTGRESQL must be true on VPS (current: ${USE_POSTGRESQL:-unset})"
  echo "Fix: echo USE_POSTGRESQL=true >> $APP_ROOT/server/.env"
  exit 1
fi

echo "==> migrations"
npm run migrate

echo "==> client build"
cd "$APP_ROOT/client"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
umask 022
npm run build
# postbuild в package.json тоже выставляет права; дублируем на случай старого package.json
bash "$APP_ROOT/scripts/vps-fix-client-build-perms.sh" 2>/dev/null \
  || { chmod 755 "$APP_ROOT/client"; chmod -R a+rX "$APP_ROOT/client/build"; } 2>/dev/null \
  || true

echo "==> pm2 restart (cwd=$APP_ROOT/server)"
cd "$APP_ROOT/server"
NODE_HEAP_MB="${NODE_HEAP_MB:-3072}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=${NODE_HEAP_MB}}"
echo "    NODE_OPTIONS=$NODE_OPTIONS"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start server.js --name "$PM2_NAME" --cwd "$APP_ROOT/server"
fi
pm2 save
pm2 list

echo "==> health check"
sleep 2
curl -sf "http://127.0.0.1:${PORT:-3001}/health" | head -c 400 || echo "WARN: /health failed — см. pm2 logs $PM2_NAME"
DOMAIN="${DOMAIN:-dttrade.ru}"
curl -sf -o /dev/null -w "HTTPS /api/auth/me → %{http_code}\n" -k -H "Host: $DOMAIN" "https://127.0.0.1/api/auth/me" 2>/dev/null \
  || echo "WARN: nginx HTTPS check skipped"

echo "==> nginx API timeouts (504 fix)"
if [ -f "$APP_ROOT/scripts/vps-fix-nginx-timeouts.sh" ]; then
  bash "$APP_ROOT/scripts/vps-fix-nginx-timeouts.sh" || echo "WARN: nginx timeout patch skipped (run with sudo if needed)"
fi

echo "==> nginx gzip (static assets)"
if [ -f "$APP_ROOT/scripts/vps-fix-nginx-gzip.sh" ]; then
  bash "$APP_ROOT/scripts/vps-fix-nginx-gzip.sh" || echo "WARN: nginx gzip patch skipped"
fi

echo "==> done"
