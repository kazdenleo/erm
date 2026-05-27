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

echo "==> migrations"
npm run migrate

echo "==> client build"
cd "$APP_ROOT/client"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run build

echo "==> pm2 restart"
pm2 restart "$PM2_NAME"
pm2 save
pm2 list

echo "==> done"
