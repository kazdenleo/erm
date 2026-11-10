#!/bin/bash
set -e
cd /opt/erm/server
sed -i 's/\r$//' scripts/admin/_tmp_probe_live_decrypt.mjs || true
echo '===== DECRYPT DEEP ====='
node scripts/admin/_tmp_probe_live_decrypt.mjs
echo '===== PRICE ROUTES ====='
curl -sS -o /dev/null -w 'prices_ozon=%{http_code}\n' http://127.0.0.1:3001/api/product/prices/ozon
curl -sS -o /dev/null -w 'prices_wb=%{http_code}\n' http://127.0.0.1:3001/api/product/prices/wb
curl -sS -o /dev/null -w 'prices_ym=%{http_code}\n' http://127.0.0.1:3001/api/product/prices/ym
echo '===== LIVE ERR ====='
ERR_BEFORE=$(wc -l < /root/.pm2/logs/erm-api-error.log)
sleep 15
ERR_AFTER=$(wc -l < /root/.pm2/logs/erm-api-error.log)
echo "lines_before=$ERR_BEFORE after=$ERR_AFTER delta=$((ERR_AFTER-ERR_BEFORE))"
tail -n 40 /root/.pm2/logs/erm-api-error.log
