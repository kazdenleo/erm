#!/usr/bin/env bash
set -euo pipefail
cd /opt/erm/server
echo "== flags =="
node --input-type=module <<'EOF'
import fs from 'fs';
import pg from 'pg';
for (const line of fs.readFileSync('.env','utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  let v = line.slice(i+1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
  if (!(line.slice(0,i) in process.env)) process.env[line.slice(0,i)] = v;
}
const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const r = await pool.query(
  `SELECT id, name, push_marketplace_stock, push_stock_ozon FROM warehouses WHERE id IN (1,4) ORDER BY id`
);
console.log(r.rows);
await pool.end();
EOF

echo "== recent push logs =="
grep -E 'Background bulk|bulk sync done|warehouse_master_off|Ozon OK|qtyPolicyReason|MP Stock Push\] bulk' /root/.pm2/logs/erm-api-out.log | tail -30

echo "== sellable purchasable deployed? =="
grep -n "availabilityMode: 'purchasable'" /opt/erm/server/src/services/sellableQuantity.service.js | head -3
