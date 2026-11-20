#!/usr/bin/env bash
# Ежедневный бэкап PostgreSQL + uploads на VPS.
# Рекомендуемый cron (на сервере):
#   15 3 * * * /opt/erm/scripts/backup-vps.sh >> /var/log/erm-backup.log 2>&1
#
# Переменные (можно в /opt/erm/server/.env или окружении cron):
#   APP_ROOT=/opt/erm
#   BACKUP_DIR=/var/backups/erm          — локальная папка (по умолчанию)
#   BACKUP_REMOTE_DIR=                  — если задан, rsync/scp сюда (пример: user@host:/backups/erm)
#   BACKUP_KEEP_DAYS=14
#   DB_* из server/.env
#
# Проверка restore (на копии БД, не на проде):
#   gunzip -c /var/backups/erm/STAMP/db.sql.gz | psql -h ... -U ... -d erp_restore
#   tar -C /tmp/erm-restore -xzf /var/backups/erm/STAMP/uploads.tar.gz
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/erm}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
DEST="${BACKUP_DIR}/${STAMP}"

if [ -f "$APP_ROOT/server/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_ROOT/server/.env"
  set +a
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-erp_system}"
DB_USER="${DB_USER:-admin}"

mkdir -p "$DEST"

echo "==> pg_dump ${DB_NAME} → ${DEST}/db.sql.gz"
export PGPASSWORD="${DB_PASSWORD:-}"
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --format=plain \
  | gzip -c > "${DEST}/db.sql.gz"
unset PGPASSWORD

UPLOADS="$APP_ROOT/server/uploads"
if [ -d "$UPLOADS" ]; then
  echo "==> tar uploads → ${DEST}/uploads.tar.gz"
  tar -C "$APP_ROOT/server" -czf "${DEST}/uploads.tar.gz" uploads
else
  echo "==> uploads отсутствует, пропускаем"
fi

DATA_DIR="$APP_ROOT/server/data"
if [ -d "$DATA_DIR" ]; then
  echo "==> tar data → ${DEST}/data.tar.gz"
  tar -C "$APP_ROOT/server" -czf "${DEST}/data.tar.gz" data
fi

echo "$STAMP" > "${DEST}/OK"
echo "==> готово: $DEST"

if [ -n "${BACKUP_REMOTE_DIR:-}" ]; then
  echo "==> копирование на ${BACKUP_REMOTE_DIR}"
  rsync -a --partial "$DEST" "${BACKUP_REMOTE_DIR}/" || \
    scp -r "$DEST" "${BACKUP_REMOTE_DIR}/"
fi

echo "==> удаление бэкапов старше ${BACKUP_KEEP_DAYS} дней в ${BACKUP_DIR}"
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${BACKUP_KEEP_DAYS}" -exec rm -rf {} +

echo "==> backup OK"
