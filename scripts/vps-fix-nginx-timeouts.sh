#!/usr/bin/env bash
# Прописать / обновить proxy_*_timeout для /api/ (иначе nginx отдаёт 504 через ~60 с).
# Запуск на VPS: sudo bash /opt/erm/scripts/vps-fix-nginx-timeouts.sh
set -euo pipefail

TIMEOUT="${NGINX_API_TIMEOUT:-600s}"
MARKER="# erm-api-timeouts"

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not installed — skip"
  exit 0
fi

mapfile -t CONF_FILES < <(
  grep -Rl "location /api" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u || true
)

if [ "${#CONF_FILES[@]}" -eq 0 ]; then
  echo "WARN: no nginx config with location /api — copy docs/nginx-erm.example.conf"
  exit 0
fi

patch_file() {
  local f="$1"
  if ! grep -q "location /api" "$f"; then
    return 0
  fi
  local tmp
  tmp="$(mktemp)"

  if grep -q "$MARKER" "$f" 2>/dev/null; then
    # Уже помечено — обновить значения timeout до текущего TIMEOUT
    sed -E \
      -e "s/(proxy_read_timeout)[[:space:]]+[0-9]+s;/\1 ${TIMEOUT};/g" \
      -e "s/(proxy_connect_timeout)[[:space:]]+[0-9]+s;/\1 ${TIMEOUT};/g" \
      -e "s/(proxy_send_timeout)[[:space:]]+[0-9]+s;/\1 ${TIMEOUT};/g" \
      "$f" > "$tmp"
    if ! cmp -s "$f" "$tmp"; then
      cp "$tmp" "$f"
      echo "updated timeouts to ${TIMEOUT}: $f"
    else
      echo "already at ${TIMEOUT}: $f"
    fi
    rm -f "$tmp"
    return 0
  fi

  awk -v marker="$MARKER" -v t="$TIMEOUT" '
    /location[[:space:]]+\/api/ { in_api=1 }
    in_api && /proxy_pass/ && !added {
      print $0
      print "        " marker
      print "        proxy_read_timeout " t ";"
      print "        proxy_connect_timeout " t ";"
      print "        proxy_send_timeout " t ";"
      added=1
      next
    }
    in_api && /^[[:space:]]*}[[:space:]]*$/ { in_api=0 }
    { print }
  ' "$f" > "$tmp"
  if grep -q "$MARKER" "$tmp"; then
    cp "$tmp" "$f"
    echo "patched: $f"
  else
    echo "WARN: could not auto-patch $f — add proxy_read_timeout ${TIMEOUT} manually"
  fi
  rm -f "$tmp"
}

for f in "${CONF_FILES[@]}"; do
  patch_file "$f"
done

nginx -t
systemctl reload nginx
echo "nginx reloaded (API timeout ${TIMEOUT})"
