import { query, closePool } from "./src/config/database.js";
const r = await query(`
  SELECT 'integrations' AS src, i.id::text, i.profile_id::text, i.organization_id::text, i.updated_at,
         i.config->>'token_expires_at' AS token_expires_at
  FROM integrations i WHERE i.code='wildberries'
  UNION ALL
  SELECT 'cabinet', mc.id::text, o.profile_id::text, mc.organization_id::text, mc.updated_at,
         mc.config->>'token_expires_at'
  FROM marketplace_cabinets mc
  JOIN organizations o ON o.id=mc.organization_id
  WHERE mc.marketplace_type='wildberries'
`);
console.log(JSON.stringify(r.rows, null, 2));
await closePool();
