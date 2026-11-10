#!/bin/bash
echo '=== hosts ==='
grep -n dttrade /etc/hosts || true
echo '=== resolv ==='
cat /etc/resolv.conf
echo '=== getent ==='
getent hosts dttrade.ru || true
echo '=== nslookup google dns ==='
nslookup dttrade.ru 8.8.8.8 || true
echo '=== CLIENT_URL ==='
grep '^CLIENT_URL=' /opt/erm/server/.env || true
echo '=== public curls ==='
curl -sS -o /dev/null -w 'via_dns_http=%{http_code} ip=%{remote_ip}\n' --max-time 10 http://dttrade.ru/api/health || true
curl -sS -o /dev/null -w 'via_new_ip=%{http_code}\n' --max-time 10 -H 'Host: dttrade.ru' http://137.22.146.136/api/health || true
curl -sS -o /dev/null -w 'via_old_ip=%{http_code}\n' --max-time 8 -H 'Host: dttrade.ru' http://45.80.68.230/api/health || true
echo '=== error counters last 4000 err lines ==='
python3 - <<'PY'
from collections import Counter
c=Counter()
path='/root/.pm2/logs/erm-api-error.log'
lines=open(path,'rb').read().splitlines()[-4000:]
for b in lines:
  s=b.decode('utf-8','replace')
  if 'secretsCrypto' in s: c['secretsCrypto_decrypt']+=1
  elif 'WB Orders' in s and '401' in s: c['WB_Orders_401']+=1
  elif 'WB tariffs' in s and '401' in s: c['WB_tariffs_401']+=1
  elif 'Api-key is deactivated' in s: c['Ozon_deactivated']+=1
  elif 'Invalid Api-Key' in s: c['Ozon_invalid']+=1
  elif 'dismissedNotifications' in s: c['dismissedNotifications']+=1
  elif 'ERROR' in s or 'Error' in s: c['other_error']+=1
print(dict(c))
PY
echo '=== API smokes ==='
curl -sS -o /dev/null -w 'prices=%{http_code}\n' http://127.0.0.1:3001/api/prices
curl -sS -o /dev/null -w 'strategies=%{http_code}\n' http://127.0.0.1:3001/api/pricing-strategies
curl -sS -o /dev/null -w 'integrations=%{http_code}\n' http://127.0.0.1:3001/api/integrations
