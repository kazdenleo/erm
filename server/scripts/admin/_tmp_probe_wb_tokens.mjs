import { query } from '../../src/config/database.js';
import { decryptConfigSecrets } from '../../src/utils/secretsCrypto.js';
import integrationsService from '../../src/services/integrations.service.js';

function meta(cfg) {
  const unlocked = decryptConfigSecrets(cfg || {});
  const key = integrationsService._normalizeWbToken(unlocked?.api_key ?? unlocked?.apiKey);
  const exp = integrationsService._extractJwtExpiryYmd(key);
  const prefix = key ? `${key.slice(0, 12)}…${key.slice(-8)}` : null;
  return { hasKey: !!key, len: key.length, exp, expired: exp ? exp < '2026-10-30' : null, prefix };
}

const ints = await query(
  `SELECT id, profile_id, organization_id, code, is_active, updated_at, config
   FROM integrations WHERE code = 'wildberries' ORDER BY profile_id, id`
);
console.log('=== integrations wildberries ===');
for (const r of ints.rows) {
  console.log({
    id: r.id,
    profile_id: r.profile_id,
    org: r.organization_id,
    updated_at: r.updated_at,
    ...meta(r.config),
  });
}

const cols = await query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name = 'marketplace_cabinets' ORDER BY ordinal_position`
);
console.log('cabinet columns:', cols.rows.map((x) => x.column_name).join(', '));

const cabs = await query(
  `SELECT * FROM marketplace_cabinets WHERE marketplace_type = 'wildberries' ORDER BY id`
);
console.log('=== marketplace_cabinets wildberries ===');
for (const r of cabs.rows) {
  console.log({
    id: r.id,
    organization_id: r.organization_id,
    name: r.name,
    is_active: r.is_active,
    updated_at: r.updated_at,
    ...meta(r.config),
  });
}

process.exit(0);
