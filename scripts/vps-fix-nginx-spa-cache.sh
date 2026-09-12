#!/usr/bin/env bash
# HTML SPA (/products/123 и т.п.) не должен кэшироваться: иначе после деплоя открывается старый JS.
# Запуск на VPS: sudo bash /opt/erm/scripts/vps-fix-nginx-spa-cache.sh
set -euo pipefail

MARKER="# erm-spa-html-no-cache"

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
  python3 - "$f" "$tmp" "$MARKER" <<'PY'
import sys
path, out, marker = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8", errors="replace").read()
needle = "location / {\n        try_files $uri $uri/ /index.html;"
insert = (
    "location / {\n"
    f"        {marker}\n"
    '        add_header Cache-Control "no-cache, no-store, must-revalidate";\n'
    "        try_files $uri $uri/ /index.html;"
)
if needle not in text:
    sys.exit(2)
open(out, "w", encoding="utf-8").write(text.replace(needle, insert, 1))
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "WARN: could not auto-patch $f"
    rm -f "$tmp"
    return 0
  fi
  cp "$tmp" "$f"
  rm -f "$tmp"
  echo "patched: $f"
}

for f in "${CONF_FILES[@]}"; do
  patch_file "$f"
done

nginx -t
systemctl reload nginx
echo "nginx reloaded (SPA HTML no-cache)"
