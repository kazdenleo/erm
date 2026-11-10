#!/bin/bash
cd /opt/erm/server || exit 1
node --input-type=module <<'EOF'
import { query } from './src/config/database.js';
import { decryptConfigSecrets } from './src/utils/secretsCrypto.js';

function expOf(cfg) {
  const u = decryptConfigSecrets(cfg || {});
  const k = String(u.api_key || u.apiKey || '').replace(/\s+/g, '').trim();
  const p = k.split('.');
  if (p.length < 2) return { len: k.length, exp: null };
  try {
    const pad = '='.repeat((4 - (p[1].length % 4)) % 4);
    const o = JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString());
    return { len: k.length, exp: o.exp ? new Date(o.exp * 1000).toISOString() : null };
  } catch (e) {
    return { len: k.length, err: e.message };
  }
}

const r = await query(
  `SELECT id, organization_id, updated_at, config FROM marketplace_cabinets WHERE marketplace_type='wildberries'`
);
for (const row of r.rows) {
  console.log(JSON.stringify({ id: row.id, org: row.organization_id, updated_at: row.updated_at, ...expOf(row.config) }));
}
process.exit(0);
EOF
