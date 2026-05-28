#!/usr/bin/env bash
# Проверка, что на VPS задеплоена актуальная версия API (без 504 на orders).
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
DOMAIN="${DOMAIN:-dttrade.ru}"

cd "$APP_ROOT"

echo "==> git"
git log -1 --oneline
echo ""

echo "==> маркеры в коде"
grep -n "build: '2026-05-28-orders-fast'" server/src/controllers/healthController.js && echo "OK health build tag" || echo "MISSING health build tag"
grep -n "_scheduleReapplyReserveAfterReturnToNew" server/src/services/orders.service.js && echo "OK return-to-new async" || echo "MISSING return-to-new async"
grep -n "findByMarketplaceAndOrderIdLite" server/src/repositories/orders.repository.pg.js && echo "OK lite order lookup" || echo "MISSING lite lookup"
grep -n "lightReserveEnrich" server/src/services/orders.service.js && echo "OK orders list fast" || echo "MISSING orders list fast"
echo ""

echo "==> health JSON (через HTTPS)"
curl -sk -H "Host: $DOMAIN" "https://127.0.0.1/api/health" | head -c 500
echo ""
echo ""

echo "Если build НЕ содержит 2026-05-28-orders-fast — выполните:"
echo "  cd $APP_ROOT && git pull origin main && bash scripts/vps-update-send-to-assembly.sh"
