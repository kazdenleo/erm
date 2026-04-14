#!/usr/bin/env bash
# Импорт на VPS: PostgreSQL из erp_system.dump + распаковка server-uploads.tar.gz
#
#   cd /opt/erm
#   bash scripts/vps-migration/import-on-vps.sh /root/erm-migration/erp_system.dump /root/erm-migration/server-uploads.tar.gz

set -euo pipefail

read_env_val() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || { echo ""; return; }
  line="$(grep -E "^${key}=" "$ENV_FILE" | head -1 || true)"
  [[ -n "$line" ]] || { echo ""; return; }
  val="${line#*=}"
  val="${val%$'\r'}"
  val="${val#\"}"
  val="${val%\"}"
  printf '%s' "$val"
}

DUMP="${1:-}"
UPLOADS_TGZ="${2:-}"

if [[ ! -f "$DUMP" ]]; then
  echo "Usage: $0 /path/to/erp_system.dump [/path/to/server-uploads.tar.gz]"
  exit 1
fi

APP_ROOT="${APP_ROOT:-/opt/erm}"
ENV_FILE="$APP_ROOT/.env"

DB_NAME="$(read_env_val DB_NAME)"
DB_USER="$(read_env_val DB_USER)"
[[ -n "$DB_NAME" ]] || DB_NAME="erp_system"
[[ -n "$DB_USER" ]] || DB_USER="erm_user"

echo "[import] Останавливаем API..."
pm2 stop erm-api 2>/dev/null || true

# postgres не может читать файлы в /root (mode 700); копируем дамп в /tmp
DUMP_WORK="$(mktemp /tmp/erp-restore-XXXXXX.dump)"
cp "$DUMP" "$DUMP_WORK"
chmod 644 "$DUMP_WORK"
echo "[import] pg_restore в $DB_NAME (от пользователя postgres), временный файл: $DUMP_WORK"
# --no-owner --no-acl: дамп с ПК не тащит владельцев Windows; права дальше выдаём $DB_USER
sudo -u postgres pg_restore -d "$DB_NAME" --clean --if-exists --no-owner --no-acl -v "$DUMP_WORK" || {
  echo "[import] pg_restore вернул ненулевой код — просмотрите лог (часть WARNING допустима)."
}
rm -f "$DUMP_WORK"

echo "[import] Права для $DB_USER..."
sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA public TO \"$DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO \"$DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO \"$DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"$DB_USER\";"
sudo -u postgres psql -d "$DB_NAME" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO \"$DB_USER\";"

if [[ -n "${UPLOADS_TGZ}" && -f "$UPLOADS_TGZ" ]]; then
  echo "[import] Распаковка uploads в $APP_ROOT/server/..."
  mkdir -p "$APP_ROOT/server/uploads"
  tar -xzf "$UPLOADS_TGZ" -C "$APP_ROOT/server"
else
  echo "[import] Архив загрузок не указан или файл не найден — пропуск."
fi

echo "[import] Запуск API..."
cd "$APP_ROOT/server"
if pm2 describe erm-api >/dev/null 2>&1; then
  pm2 start erm-api
else
  pm2 start server.js --name erm-api
fi
pm2 save

echo "[import] Готово. Проверка: curl -s http://127.0.0.1:3001/health"
