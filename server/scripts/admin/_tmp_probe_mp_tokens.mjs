import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

function mask(s) {
  const t = String(s || '');
  if (!t) return '(empty)';
  if (t.length <= 10) return `${t.slice(0, 2)}…(len=${t.length})`;
  return `${t.slice(0, 8)}…${t.slice(-4)} (len=${t.length})`;
}

function pickKey(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  return cfg.api_key || cfg.apiKey || '';
}

function parseCfg(cfg) {
  if (cfg == null) return {};
  if (typeof cfg === 'string') {
    try {
      return JSON.parse(cfg);
    } catch {
      return {};
    }
  }
  return cfg;
}

const { rows: cabs } = await pool.query(`
  SELECT c.id, c.organization_id, o.name AS org_name, o.profile_id,
         c.marketplace_type, c.name, c.is_active, c.updated_at, c.config
  FROM marketplace_cabinets c
  JOIN organizations o ON o.id = c.organization_id
  ORDER BY o.profile_id, c.organization_id, c.marketplace_type, c.id
`);
console.log('=== marketplace_cabinets ===');
for (const r of cabs) {
  const cfg = parseCfg(r.config);
  console.log({
    id: r.id,
    profile_id: r.profile_id,
    organization_id: r.organization_id,
    org: r.org_name,
    marketplace: r.marketplace_type,
    name: r.name,
    is_active: r.is_active,
    updated_at: r.updated_at,
    key: mask(pickKey(cfg)),
    client_id: cfg.client_id || null,
    token_expires_at: cfg.token_expires_at || cfg.tokenExpiresAt || null,
  });
}

const { rows: ints } = await pool.query(`
  SELECT id, profile_id, organization_id, type, code, name, is_active, updated_at, config
  FROM integrations
  WHERE type = 'marketplace'
  ORDER BY profile_id NULLS LAST, organization_id NULLS LAST, code, id
`);
console.log('\n=== integrations marketplace ===');
for (const r of ints) {
  const cfg = parseCfg(r.config);
  console.log({
    id: r.id,
    profile_id: r.profile_id,
    organization_id: r.organization_id,
    code: r.code,
    is_active: r.is_active,
    updated_at: r.updated_at,
    key: mask(pickKey(cfg)),
    client_id: cfg.client_id || null,
    token_expires_at: cfg.token_expires_at || cfg.tokenExpiresAt || null,
  });
}

// Live ping WB /orders/new for each cabinet key
console.log('\n=== live WB /orders/new ===');
for (const r of cabs.filter((x) => String(x.marketplace_type).toLowerCase().includes('wild'))) {
  const cfg = parseCfg(r.config);
  const key = pickKey(cfg);
  if (!key) {
    console.log(r.organization_id, r.name, 'no key');
    continue;
  }
  const res = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/new', {
    headers: { Authorization: String(key), Accept: 'application/json' },
  });
  const text = await res.text();
  console.log({
    org: r.organization_id,
    cabinet: r.name,
    updated_at: r.updated_at,
    key: mask(key),
    http: res.status,
    body: text.slice(0, 180),
  });
}

console.log('\n=== live WB via integrations rows ===');
for (const r of ints.filter((x) => /wild|wb/i.test(String(x.code)))) {
  const cfg = parseCfg(r.config);
  const key = pickKey(cfg);
  if (!key) continue;
  const res = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/new', {
    headers: { Authorization: String(key), Accept: 'application/json' },
  });
  const text = await res.text();
  console.log({
    id: r.id,
    profile_id: r.profile_id,
    organization_id: r.organization_id,
    updated_at: r.updated_at,
    key: mask(key),
    http: res.status,
    body: text.slice(0, 180),
  });
}

await pool.end();
