#!/usr/bin/env bash
# Выпуск Let's Encrypt и HTTPS для dttrade.ru.
# Требование: A-записи dttrade.ru / www → IP этого сервера.
# Запуск: bash /opt/erm/scripts/vps-enable-ssl.sh
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
DOMAIN="${DOMAIN:-dttrade.ru}"
EMAIL="${CERTBOT_EMAIL:-admin@${DOMAIN}}"
NEW_IP="$(curl -4 -sS --max-time 10 https://ifconfig.me || curl -4 -sS --max-time 10 https://api.ipify.org || true)"

echo "==> server public IP: ${NEW_IP:-unknown}"
DNS_IP="$(dig +short A "$DOMAIN" @8.8.8.8 | tail -n1 || true)"
WWW_IP="$(dig +short A "www.$DOMAIN" @8.8.8.8 | tail -n1 || true)"
echo "==> DNS $DOMAIN → ${DNS_IP:-none}"
echo "==> DNS www.$DOMAIN → ${WWW_IP:-none}"

if [ -z "${NEW_IP}" ] || [ -z "${DNS_IP}" ] || [ "$DNS_IP" != "$NEW_IP" ]; then
  echo "ERROR: DNS ещё не указывает на этот сервер (${NEW_IP})."
  echo "В панели Beget смените A-записи $DOMAIN и www.$DOMAIN на ${NEW_IP:-<IP сервера>}."
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
if ! command -v certbot >/dev/null 2>&1; then
  echo "==> install certbot"
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

# Чистый HTTP-конфиг перед certbot (certbot сам добавит SSL server)
bash "$APP_ROOT/scripts/vps-write-nginx-http.sh"

echo "==> certbot"
certbot --nginx \
  -d "$DOMAIN" \
  -d "www.$DOMAIN" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect \
  --keep-until-expiring

nginx -t
systemctl reload nginx

ENV_FILE="$APP_ROOT/server/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -q '^CLIENT_URL=' "$ENV_FILE"; then
    sed -i "s|^CLIENT_URL=.*|CLIENT_URL=https://${DOMAIN}|" "$ENV_FILE"
  else
    echo "CLIENT_URL=https://${DOMAIN}" >> "$ENV_FILE"
  fi
  echo "==> CLIENT_URL=https://${DOMAIN}"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart erm-api --update-env || true
  fi
fi

echo "==> verify"
curl -sS -o /dev/null -w "https_health=%{http_code}\n" "https://${DOMAIN}/api/health"
curl -sS -o /dev/null -w "http_redirect=%{http_code} url=%{redirect_url}\n" "http://${DOMAIN}/api/health"
echo "SSL_OK"
