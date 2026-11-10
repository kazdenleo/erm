/**
 * Probe: which WB keys reviews sync would use vs cabinets (no secrets printed).
 */
import { query, closePool } from '../../src/config/database.js';
import integrationsService from '../../src/services/integrations.service.js';

function jwtMeta(token) {
  const t = integrationsService._normalizeWbToken(token);
  if (!t) return { has: false };
  const expYmd = integrationsService._extractJwtExpiryYmd(t);
  const expired = expYmd ? expYmd < new Date().toISOString().slice(0, 10) : null;
  let claims = null;
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const obj = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    claims = {
      exp: obj?.exp ? new Date(obj.exp * 1000).toISOString() : null,
      iat: obj?.iat ? new Date(obj.iat * 1000).toISOString() : null,
      id: obj?.id ?? obj?.sid ?? null,
      s: obj?.s ?? obj?.scope ?? null,
    };
  } catch {
    claims = { decode_error: true };
  }
  return {
    has: true,
    len: t.length,
    prefix: `${t.slice(0, 8)}…${t.slice(-6)}`,
    expYmd,
    expired,
    claims,
  };
}

async function pingFeedbacks(apiKey) {
  const key = integrationsService._normalizeWbToken(apiKey);
  const url = 'https://feedbacks-api.wildberries.ru/api/v1/feedbacks?take=1&skip=0&isAnswered=false';
  const variants = [
    { name: 'Bearer', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
    { name: 'raw', headers: { Authorization: key, Accept: 'application/json' } },
  ];
  const out = [];
  for (const v of variants) {
    try {
      const res = await fetch(url, { method: 'GET', headers: v.headers });
      const text = await res.text();
      out.push({
        auth: v.name,
        status: res.status,
        body: text.slice(0, 180).replace(/\s+/g, ' '),
      });
    } catch (e) {
      out.push({ auth: v.name, error: e?.message || String(e) });
    }
  }
  return out;
}

const profiles = (await query(`SELECT id, name FROM profiles ORDER BY id`)).rows;
console.log('profiles', profiles);

for (const p of profiles) {
  const pid = p.id;
  console.log('\n======== profile', pid, p.name);

  const viaService = await integrationsService.getMarketplaceConfig('wildberries', {
    profileId: pid,
    organizationId: null,
  });
  console.log('getMarketplaceConfig(org=null)', jwtMeta(viaService?.api_key ?? viaService?.apiKey));

  const integ = await query(
    `SELECT id, organization_id, is_active, updated_at,
            config->>'token_expires_at' AS token_expires_at,
            length(coalesce(config->>'api_key', config->>'apiKey', '')) AS key_len
     FROM integrations
     WHERE code = 'wildberries' AND profile_id = $1
     ORDER BY id`,
    [pid]
  );
  console.log('integrations rows', integ.rows);

  for (const row of integ.rows) {
    const full = await query(`SELECT config FROM integrations WHERE id = $1`, [row.id]);
    const cfg = full.rows[0]?.config || {};
    console.log('  integration', row.id, 'org', row.organization_id, jwtMeta(cfg.api_key ?? cfg.apiKey));
  }

  const cabs = await query(
    `SELECT mc.id, mc.organization_id, mc.name, mc.is_active, mc.updated_at,
            mc.config->>'token_expires_at' AS token_expires_at,
            o.name AS org_name
     FROM marketplace_cabinets mc
     LEFT JOIN organizations o ON o.id = mc.organization_id
     WHERE mc.marketplace_type = 'wildberries'
       AND mc.organization_id IN (SELECT id FROM organizations WHERE profile_id = $1)
     ORDER BY mc.organization_id, mc.id`,
    [pid]
  );
  console.log('cabinets', cabs.rows.map((r) => ({ ...r })));

  for (const cab of cabs.rows) {
    const full = await query(`SELECT config FROM marketplace_cabinets WHERE id = $1`, [cab.id]);
    const cfg = full.rows[0]?.config || {};
    const meta = jwtMeta(cfg.api_key ?? cfg.apiKey);
    console.log('  cabinet', cab.id, cab.name, 'org', cab.organization_id, meta);
    if (meta.has) {
      console.log('  ping feedbacks cabinet', cab.id, await pingFeedbacks(cfg.api_key ?? cfg.apiKey));
    }
  }

  const usedKey = viaService?.api_key ?? viaService?.apiKey;
  if (usedKey) {
    console.log('ping feedbacks getMarketplaceConfig', await pingFeedbacks(usedKey));
  }
}

await closePool().catch(() => {});
process.exit(0);
