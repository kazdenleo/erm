#!/usr/bin/env bash
# Обновление на VPS: фикс 504 «На сборку» + проверки nginx/HTTPS.
# Запуск на сервере: bash /opt/erm/scripts/vps-update-send-to-assembly.sh
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
PM2_NAME="${PM2_NAME:-erm-api}"
DOMAIN="${DOMAIN:-dttrade.ru}"

cd "$APP_ROOT"
echo "==> git pull"
git pull origin main

if ! grep -q 'shipmentsPending' "$APP_ROOT/server/src/controllers/orders.controller.js"; then
  echo "WARN: shipmentsPending не найден (старый send-to-assembly)"
fi
if ! grep -q 'lightReserveEnrich' "$APP_ROOT/server/src/services/orders.service.js"; then
  echo "ERROR: нет lightReserveEnrich — список заказов может отдавать 504. Сделайте git pull."
  exit 1
fi
if ! grep -q 'bulkReturnToNew' "$APP_ROOT/server/src/services/orders.service.js"; then
  echo "WARN: нет bulkReturnToNew — возврат в «Новый» может давать 504"
fi
if ! grep -q '_scheduleReapplyReserveAfterReturnToNew' "$APP_ROOT/server/src/services/orders.service.js"; then
  echo "ERROR: нет async return-to-new — сделайте git pull"
  exit 1
fi
if ! grep -q 'procureFromOrders' "$APP_ROOT/server/src/services/purchases.service.js"; then
  echo "WARN: нет procureFromOrders — «В закупку» может давать 504"
fi
echo "OK: фиксы orders/purchases найдены"

echo "==> server"
cd "$APP_ROOT/server"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run migrate

echo "==> client build"
cd "$APP_ROOT/client"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run build

echo "==> pm2"
pm2 restart "$PM2_NAME" --update-env || {
  pm2 start server.js --name "$PM2_NAME" --cwd "$APP_ROOT/server"
}
pm2 save

sleep 2
echo "==> проверки"
curl -sf -o /dev/null -w "Node :3001/health          → %{http_code}\n" "http://127.0.0.1:${PORT:-3001}/health"
curl -sf -o /dev/null -w "HTTPS /api/auth/me        → %{http_code} (ожидается 401)\n" \
  -k -H "Host: $DOMAIN" "https://127.0.0.1/api/auth/me"
curl -sf -o /dev/null -w "HTTPS /api/health         → %{http_code} (ожидается 200)\n" \
  -k -H "Host: $DOMAIN" "https://127.0.0.1/api/health" || echo "WARN: /api/health — проверьте pm2 logs"

echo ""
echo "Готово. В браузере снова отправьте заказы «На сборку»."
echo "Если 504 останется — в location /api/ добавьте proxy_read_timeout 300s; (см. docs/nginx-erm.example.conf)"
