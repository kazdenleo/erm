#!/usr/bin/env bash
# Первичная установка ERP на чистый Ubuntu 24.04 (AdminVPS).
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
REPO_URL="${REPO_URL:-https://github.com/kazdenleo/erm.git}"
DOMAIN="${DOMAIN:-dttrade.ru}"
PM2_NAME="${PM2_NAME:-erm-api}"

export DEBIAN_FRONTEND=noninteractive

echo "==> apt update / packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw nginx postgresql postgresql-contrib git build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "==> Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> pm2"
  npm install -g pm2
fi

echo "==> PostgreSQL role/db"
systemctl enable --now postgresql
DB_PASS="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"
SECRETS_KEY="$(openssl rand -hex 32)"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erm') THEN
    CREATE ROLE erm LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE erm WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE erp_system OWNER erm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erp_system')\gexec
GRANT ALL PRIVILEGES ON DATABASE erp_system TO erm;
SQL

# для pg 15+: права на schema public
sudo -u postgres psql -d erp_system -v ON_ERROR_STOP=1 <<SQL
GRANT ALL ON SCHEMA public TO erm;
ALTER DATABASE erp_system OWNER TO erm;
SQL

echo "==> clone/pull repo"
mkdir -p "$(dirname "$APP_ROOT")"
if [ -d "$APP_ROOT/.git" ]; then
  cd "$APP_ROOT"
  git fetch origin
  git checkout main
  git pull origin main
else
  rm -rf "$APP_ROOT"
  git clone --branch main --depth 1 "$REPO_URL" "$APP_ROOT"
fi

echo "==> .env"
ENV_FILE="$APP_ROOT/server/.env"
if [ -f "$ENV_FILE" ]; then
  echo "    .env already exists — not overwriting"
else
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3001
CLIENT_URL=https://${DOMAIN}
USE_POSTGRESQL=true
DB_HOST=localhost
DB_PORT=5432
DB_NAME=erp_system
DB_USER=erm
DB_PASSWORD=${DB_PASS}
JWT_SECRET=${JWT_SECRET}
SECRETS_ENCRYPTION_KEY=${SECRETS_KEY}
JWT_EXPIRES_IN=24h
DOMAIN=${DOMAIN}
LEGAL_DOMAIN=${DOMAIN}
NODE_HEAP_MB=3072
PRINT_HELPER_URL=http://127.0.0.1:9100
EOF
  chmod 600 "$ENV_FILE"
  echo "    wrote $ENV_FILE"
fi

echo "==> server npm ci + migrate"
cd "$APP_ROOT/server"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run migrate

echo "==> client build"
cd "$APP_ROOT/client"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
umask 022
export BUILD_PATH=build
npm run build
chmod -R a+rX "$APP_ROOT/client/build" || true

echo "==> pm2"
cd "$APP_ROOT/server"
# shellcheck disable=SC1091
set -a; source "$ENV_FILE"; set +a
export NODE_OPTIONS="--max-old-space-size=${NODE_HEAP_MB:-3072}"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start server.js --name "$PM2_NAME" --cwd "$APP_ROOT/server"
fi
pm2 save
pm2 startup systemd -u root --hp /root | tail -n 1 | bash || true
pm2 save

echo "==> nginx"
SITE="/etc/nginx/sites-available/erm"
cat > "$SITE" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN} _;

    client_max_body_size 50m;

    root ${APP_ROOT}/client/build;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_set_header Host \$host;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX
ln -sfn "$SITE" /etc/nginx/sites-enabled/erm
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

echo "==> health"
sleep 2
curl -sf "http://127.0.0.1:3001/health" | head -c 400 || echo "WARN: /health failed"
curl -sf -o /dev/null -w "HTTP / → %{http_code}\n" "http://127.0.0.1/" || true

echo "BOOTSTRAP_OK domain=${DOMAIN} app=${APP_ROOT}"
echo "NOTE: SSL (certbot) — после указания DNS на этот IP"
echo "NOTE: БД пока пустая — импорт с Beget позже"
