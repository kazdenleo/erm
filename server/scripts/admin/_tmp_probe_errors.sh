#!/bin/bash
set -e
echo "=== decrypt sample ==="
grep -i decrypt /root/.pm2/logs/erm-api-error.log | head -30 || true
echo "=== decrypt count ==="
grep -ci decrypt /root/.pm2/logs/erm-api-error.log || true
echo "=== unique error prefixes ==="
grep -E '^\[' /root/.pm2/logs/erm-api-error.log | sed -E 's/^(\[[^]]+\]).*/\1/' | sort | uniq -c | sort -nr | head -30
echo "=== oauth/token/crypto env keys present ==="
grep -E '^(CLIENT_URL|CORS|JWT|SECRETS|ENCRYPTION|AUTH|COOKIE|PUBLIC|APP_URL|HTTPS)=' /opt/erm/server/.env | cut -d= -f1
echo "=== CLIENT_URL raw ==="
grep '^CLIENT_URL=' /opt/erm/server/.env
echo "=== build age ==="
ls -la /opt/erm/client/build/index.html 2>/dev/null || true
echo "=== nginx -t ==="
nginx -t 2>&1 || true
echo "=== listen ==="
ss -ltnp | grep -E ':80|:443|:3001' || true
