/**
 * Run ON VPS: node /tmp/_tmp_probe_wb_prod_keys.mjs
 * Prints JWT expiry + feedbacks ping (no full secrets).
 */
import fs from 'fs';
import pg from 'pg';

function loadEnv(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function jwtExp(token) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!t || t.split('.').length < 2) return { ok: false };
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const obj = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    const expIso = obj?.exp ? new Date(obj.exp * 1000).toISOString() : null;
    const expired = obj?.exp ? obj.exp * 1000 < Date.now() : null;
    return {
      ok: true,
      expIso,
      expired,
      s: obj?.s ?? null,
      id: obj?.id ?? null,
      prefix: `${t.slice(0, 10)}…${t.slice(-6)}`,
      len: t.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ping(url, token) {
  const variants = [
    ['Bearer', `Bearer ${token}`],
    ['raw', token],
  ];
  const out = [];
  for (const [name, auth] of variants) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      const text = await res.text();
      out.push({ auth: name, status: res.status, body: text.slice(0, 160).replace(/\s+/g, ' ') });
    } catch (e) {
      out.push({ auth: name, error: e.message });
    }
  }
  return out;
}

const env = loadEnv('/opt/erm/server/.env');
const pool = new pg.Pool({
  host: env.DB_HOST || '127.0.0.1',
  port: Number(env.DB_PORT || 5432),
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
});

const cabs = await pool.query(`
  SELECT mc.id, mc.name, mc.organization_id, mc.updated_at,
         mc.config->>'token_expires_at' AS token_expires_at,
         mc.config->>'api_key' AS api_key,
         o.profile_id, o.name AS org_name
  FROM marketplace_cabinets mc
  JOIN organizations o ON o.id = mc.organization_id
  WHERE mc.marketplace_type = 'wildberries'
  ORDER BY o.profile_id, mc.id
`);

console.log('=== marketplace_cabinets WB ===');
for (const row of cabs.rows) {
  const meta = jwtExp(row.api_key);
  console.log({
    id: row.id,
    profile_id: row.profile_id,
    org: row.org_name,
    updated_at: row.updated_at,
    token_expires_at: row.token_expires_at,
    jwt: meta,
  });
  if (meta.ok) {
    console.log(
      '  feedbacks',
      await ping(
        'https://feedbacks-api.wildberries.ru/api/v1/feedbacks?take=1&skip=0&isAnswered=false',
        String(row.api_key).replace(/\s+/g, '')
      )
    );
    console.log(
      '  content ping',
      await ping('https://content-api.wildberries.ru/ping', String(row.api_key).replace(/\s+/g, ''))
    );
  }
}

const ints = await pool.query(`
  SELECT id, profile_id, organization_id, updated_at,
         config->>'token_expires_at' AS token_expires_at,
         config->>'api_key' AS api_key
  FROM integrations
  WHERE code = 'wildberries'
  ORDER BY profile_id, id
`);
console.log('=== integrations WB ===');
for (const row of ints.rows) {
  console.log({
    id: row.id,
    profile_id: row.profile_id,
    organization_id: row.organization_id,
    updated_at: row.updated_at,
    token_expires_at: row.token_expires_at,
    jwt: jwtExp(row.api_key),
  });
}

await pool.end();
