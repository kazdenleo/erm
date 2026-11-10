import 'dotenv/config';
import pg from 'pg';
import { decryptConfigSecrets } from '../../src/utils/secretsCrypto.js';

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

function jwtExp(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload?.exp) return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

const { rows } = await pool.query(`
  SELECT c.id, c.organization_id, o.name AS org_name, c.marketplace_type, c.updated_at, c.config
  FROM marketplace_cabinets c
  JOIN organizations o ON o.id = c.organization_id
  WHERE c.marketplace_type IN ('wildberries','ozon','yandex')
  ORDER BY c.organization_id, c.marketplace_type
`);

for (const r of rows) {
  const raw = typeof r.config === 'string' ? JSON.parse(r.config) : r.config;
  const cfg = decryptConfigSecrets(raw || {});
  const key = cfg.api_key || cfg.apiKey || '';
  const expJwt = jwtExp(key);
  let http = null;
  let detail = null;
  if (r.marketplace_type === 'wildberries' && key) {
    const res = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/new', {
      headers: { Authorization: String(key), Accept: 'application/json' },
    });
    http = res.status;
    const t = await res.text();
    try {
      detail = JSON.parse(t)?.detail || t.slice(0, 120);
    } catch {
      detail = t.slice(0, 120);
    }
  }
  console.log({
    org: `${r.organization_id} ${r.org_name}`,
    mp: r.marketplace_type,
    updated_at: r.updated_at,
    stored_token_expires_at: cfg.token_expires_at || null,
    jwt_exp: expJwt,
    key_len: key.length,
    key_prefix: key ? `${String(key).slice(0, 12)}…` : '(empty)',
    wb_http: http,
    wb_detail: detail,
  });
}

await pool.end();
