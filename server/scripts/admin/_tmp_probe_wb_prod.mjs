import { query } from '../../src/config/database.js';

function expOf(cfg) {
  let c = cfg;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch {
      c = {};
    }
  }
  const k = String(c?.api_key || c?.apiKey || '').replace(/\s+/g, '').trim();
  if (k.startsWith('enc:v1:')) return { len: k.length, enc: true, exp: null };
  const p = k.split('.');
  if (p.length < 2) return { len: k.length, exp: null };
  try {
    const pad = '='.repeat((4 - (p[1].length % 4)) % 4);
    const o = JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString());
    return { len: k.length, exp: o.exp ? new Date(o.exp * 1000).toISOString() : null };
  } catch (e) {
    return { len: k.length, err: String(e.message || e) };
  }
}

const r = await query(
  'SELECT id, organization_id, updated_at, config FROM marketplace_cabinets WHERE marketplace_type=$1',
  ['wildberries']
);
for (const row of r.rows) {
  console.log(
    JSON.stringify({
      src: 'cabinet',
      id: row.id,
      org: row.organization_id,
      updated_at: row.updated_at,
      ...expOf(row.config),
    })
  );
}
const i = await query(
  'SELECT id, profile_id, organization_id, updated_at, config FROM integrations WHERE code=$1',
  ['wildberries']
);
for (const row of i.rows) {
  console.log(
    JSON.stringify({
      src: 'integrations',
      id: row.id,
      profile_id: row.profile_id,
      org: row.organization_id,
      updated_at: row.updated_at,
      ...expOf(row.config),
    })
  );
}
process.exit(0);
