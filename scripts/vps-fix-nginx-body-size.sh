#!/usr/bin/env bash
set -euo pipefail
CONF=/etc/nginx/sites-enabled/erm
BACKUP_DIR=/etc/nginx/backup
mkdir -p "$BACKUP_DIR"

# bak-файлы в sites-enabled ломают nginx (duplicate listen)
shopt -s nullglob
for f in /etc/nginx/sites-enabled/erm.bak.*; do
  mv "$f" "$BACKUP_DIR/"
  echo "moved $f -> $BACKUP_DIR/"
done
shopt -u nullglob

if [ ! -f "$CONF" ]; then
  echo "WARN: $CONF not found"
  exit 0
fi

cp -a "$CONF" "$BACKUP_DIR/erm.bak.$(date +%Y%m%d%H%M%S)"

python3 <<'PY'
from pathlib import Path
import re

p = Path('/etc/nginx/sites-enabled/erm')
text = p.read_text(encoding='utf-8')
nl = '\r\n' if '\r\n' in text else '\n'
if 'client_max_body_size' in text:
    text2 = re.sub(r'client_max_body_size\s+\S+;', 'client_max_body_size 25m;', text, count=1)
    if text2 != text:
        p.write_text(text2, encoding='utf-8', newline='')
        print('updated client_max_body_size to 25m')
    else:
        print('already has client_max_body_size 25m')
    text = text2
else:
    needle = f'server_name dttrade.ru www.dttrade.ru;{nl}'
    if needle not in text:
        m = re.search(r'(server_name[^\n]*;\r?\n)', text)
        if not m:
            raise SystemExit('server_name needle not found')
        needle = m.group(1)
        nl = '\r\n' if needle.endswith('\r\n') else '\n'
    insert = (
        needle
        + nl
        + f'    # erm-client-max-body-size{nl}'
        + f'    client_max_body_size 25m;{nl}'
    )
    text = text.replace(needle, insert, 1)
    p.write_text(text, encoding='utf-8', newline='')
    print('inserted client_max_body_size 25m')
print('--- head ---')
print('\n'.join(text.splitlines()[:12]))
PY

nginx -t
systemctl reload nginx
echo "nginx reloaded (client_max_body_size 25m)"
