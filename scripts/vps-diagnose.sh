#!/usr/bin/env bash
# Быстрая диагностика на VPS: PM2, порт API, health, .env, PostgreSQL
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
PM2_NAME="${PM2_NAME:-erm-api}"
PORT="${PORT:-3001}"

echo "==> PM2"
pm2 list 2>/dev/null || echo "pm2 not found"
echo ""
pm2 describe "$PM2_NAME" 2>/dev/null | head -40 || echo "process $PM2_NAME not in pm2"
echo ""

echo "==> .env (без паролей)"
for f in "$APP_ROOT/.env" "$APP_ROOT/server/.env"; do
  if [ -f "$f" ]; then
    echo "--- $f ---"
    grep -E '^USE_POSTGRESQL=|^DB_HOST=|^DB_PORT=|^DB_NAME=|^DB_USER=|^NODE_ENV=|^PORT=|^CLIENT_URL=' "$f" 2>/dev/null || true
  fi
done
echo ""

echo "==> port $PORT"
ss -ltnp 2>/dev/null | grep ":$PORT " || echo "nothing listening on $PORT"
echo ""

echo "==> health"
curl -sf "http://127.0.0.1:$PORT/health" && echo "" || echo "health FAILED"
echo ""

echo "==> last pm2 logs"
pm2 logs "$PM2_NAME" --lines 25 --nostream 2>/dev/null || true
