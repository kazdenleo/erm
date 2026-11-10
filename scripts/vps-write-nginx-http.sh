#!/usr/bin/env bash
# Чистый HTTP-конфиг nginx для ERM (без дублей timeout).
# Запуск на VPS: bash /opt/erm/scripts/vps-write-nginx-http.sh
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
DOMAIN="${DOMAIN:-dttrade.ru}"
SITE="/etc/nginx/sites-available/erm"

cp -a "$SITE" "${SITE}.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true

cat > "$SITE" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN} _;

    # erm-gzip-static
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_types text/plain text/css application/json application/javascript application/xml text/xml image/svg+xml font/woff font/woff2;

    # erm-client-max-body-size
    client_max_body_size 25m;

    root ${APP_ROOT}/client/build;
    index index.html;

    location /uploads/ {
        root ${APP_ROOT}/server;
        access_log off;
        expires 7d;
        add_header Cache-Control "public";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        # erm-api-timeouts
        proxy_read_timeout 600s;
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_set_header Host \$host;
    }

    location / {
        # erm-spa-html-no-cache
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

ln -sfn "$SITE" /etc/nginx/sites-enabled/erm
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "NGINX_HTTP_OK"
curl -sS -o /dev/null -w "health=%{http_code}\n" "http://127.0.0.1/api/health"
