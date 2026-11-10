#!/bin/bash
set -euo pipefail
cd /opt/erm/server
# invalidate hung lock via API after restart
pm2 restart erm-api --update-env
sleep 4
curl -s http://127.0.0.1:3001/api/health | head -c 400
echo
node scripts/admin/_tmp_reset_sync_only.mjs
