#!/usr/bin/env bash
# Ждёт, пока DNS dttrade.ru укажет на этот сервер, затем выпускает SSL.
# nohup: bash /opt/erm/scripts/vps-wait-dns-then-ssl.sh >/tmp/erm-ssl-wait.log 2>&1 &
set -uo pipefail

APP_ROOT="${APP_ROOT:-/opt/erm}"
DOMAIN="${DOMAIN:-dttrade.ru}"
LOG="${SSL_WAIT_LOG:-/tmp/erm-ssl-wait.log}"
MAX_HOURS="${SSL_WAIT_HOURS:-48}"
SLEEP_SEC="${SSL_WAIT_SLEEP:-60}"

NEW_IP="$(curl -4 -sS --max-time 10 https://ifconfig.me || curl -4 -sS --max-time 10 https://api.ipify.org || true)"
if [ -z "$NEW_IP" ]; then
  echo "$(date -u +%FT%TZ) ERROR: cannot detect public IP" | tee -a "$LOG"
  exit 1
fi

deadline=$(( $(date +%s) + MAX_HOURS * 3600 ))
echo "$(date -u +%FT%TZ) waiting DNS $DOMAIN → $NEW_IP (max ${MAX_HOURS}h)" | tee -a "$LOG"

while [ "$(date +%s)" -lt "$deadline" ]; do
  DNS_IP="$(dig +short A "$DOMAIN" @8.8.8.8 | tail -n1 || true)"
  WWW_IP="$(dig +short A "www.$DOMAIN" @8.8.8.8 | tail -n1 || true)"
  echo "$(date -u +%FT%TZ) dns=$DNS_IP www=$WWW_IP need=$NEW_IP" | tee -a "$LOG"
  if [ "$DNS_IP" = "$NEW_IP" ] && { [ -z "$WWW_IP" ] || [ "$WWW_IP" = "$NEW_IP" ]; }; then
    echo "$(date -u +%FT%TZ) DNS ready — enabling SSL" | tee -a "$LOG"
    if bash "$APP_ROOT/scripts/vps-enable-ssl.sh" >>"$LOG" 2>&1; then
      echo "$(date -u +%FT%TZ) SSL_OK" | tee -a "$LOG"
      exit 0
    fi
    echo "$(date -u +%FT%TZ) SSL attempt failed, will retry" | tee -a "$LOG"
  fi
  sleep "$SLEEP_SEC"
done

echo "$(date -u +%FT%TZ) TIMEOUT waiting for DNS" | tee -a "$LOG"
exit 3
