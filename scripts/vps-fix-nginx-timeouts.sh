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
    # Уже помечено — оставить один набор timeout после маркера, убрать дубли.
    awk -v marker="$MARKER" -v t="$TIMEOUT" '
      BEGIN { in_api=0; after_marker=0; seen_read=0; seen_connect=0; seen_send=0 }
      /location[[:space:]]+\/api/ { in_api=1; after_marker=0; seen_read=0; seen_connect=0; seen_send=0 }
      in_api && index($0, marker) {
        print
        after_marker=1
        next
      }
      in_api && after_marker && $0 ~ /proxy_read_timeout/ {
        if (!seen_read) { print "        proxy_read_timeout " t ";"; seen_read=1 }
        next
      }
      in_api && after_marker && $0 ~ /proxy_connect_timeout/ {
        if (!seen_connect) { print "        proxy_connect_timeout " t ";"; seen_connect=1 }
        next
      }
      in_api && after_marker && $0 ~ /proxy_send_timeout/ {
        if (!seen_send) { print "        proxy_send_timeout " t ";"; seen_send=1 }
        next
      }
      in_api && !after_marker && $0 ~ /proxy_(read|connect|send)_timeout/ { next }
      in_api && /^[[:space:]]*}[[:space:]]*$/ {
        if (after_marker) {
          if (!seen_read) print "        proxy_read_timeout " t ";"
          if (!seen_connect) print "        proxy_connect_timeout " t ";"
          if (!seen_send) print "        proxy_send_timeout " t ";"
        }
        in_api=0; after_marker=0
      }
      { print }
    ' "$f" > "$tmp"
    if ! cmp -s "$f" "$tmp"; then
      cp "$tmp" "$f"
      echo "normalized timeouts to ${TIMEOUT}: $f"
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
