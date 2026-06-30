#!/usr/bin/env bash
# Включить gzip для статики и JSON (ускоряет загрузку SPA без смены логики приложения).
# Запуск на VPS: sudo bash /opt/erm/scripts/vps-fix-nginx-gzip.sh
set -euo pipefail

MARKER="# erm-gzip-static"

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not installed — skip"
  exit 0
fi

mapfile -t CONF_FILES < <(
  grep -Rl "root /opt/erm/client/build" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u || true
)

if [ "${#CONF_FILES[@]}" -eq 0 ]; then
  echo "WARN: no erm site config found"
  exit 0
fi

patch_file() {
  local f="$1"
  if grep -q "$MARKER" "$f" 2>/dev/null; then
    echo "already patched: $f"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  awk -v marker="$MARKER" '
    /server_name/ && !inserted {
      print $0
      print "    " marker
      print "    gzip on;"
      print "    gzip_vary on;"
      print "    gzip_min_length 1024;"
      print "    gzip_comp_level 5;"
      print "    gzip_types text/plain text/css application/json application/javascript application/xml text/xml image/svg+xml font/woff font/woff2;"
      inserted=1
      next
    }
    { print }
  ' "$f" > "$tmp"
  if grep -q "$MARKER" "$tmp"; then
    cp "$tmp" "$f"
    echo "patched: $f"
  else
    echo "WARN: could not auto-patch $f"
  fi
  rm -f "$tmp"
}

for f in "${CONF_FILES[@]}"; do
  patch_file "$f"
done

nginx -t
systemctl reload nginx
echo "nginx reloaded (gzip enabled)"
