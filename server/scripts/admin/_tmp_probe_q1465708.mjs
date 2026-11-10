import { query } from '../../src/config/database.js';

const r = await query(
  `SELECT id, marketplace, external_id, sku_or_offer, subject, left(coalesce(body,''), 80) as body,
          answer_text, status, raw_payload
   FROM marketplace_questions
   WHERE id::text = $1 OR external_id = $2`,
  ['1465708', '01a18826-a2f8-7791-aebb-b89eae83da87']
);
console.log('rows', r.rows.length);
for (const row of r.rows) {
  const raw = typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload;
  console.log(
    JSON.stringify({
      id: row.id,
      mp: row.marketplace,
      ext: row.external_id,
      sku: row.sku_or_offer,
      status: row.status,
      hasAnswer: !!row.answer_text,
      rawSku: raw?.sku,
      rawProductSku: raw?.product_sku,
      rawId: raw?.id,
      answersLen: Array.isArray(raw?.answers) ? raw.answers.length : null,
    })
  );
}

const deleted = await query(
  `SELECT to_regclass('marketplace_questions') IS NOT NULL AS ok`
);
console.log('table ok', deleted.rows[0]);

// Check ozon cabinets for org 3 / profile 6
const cabs = await query(
  `SELECT id, organization_id, name, is_active, updated_at,
          left(coalesce(config->>'client_id', config->>'clientId', ''), 20) AS client_id_prefix,
          CASE
            WHEN coalesce(config->>'api_key', config->>'apiKey', '') LIKE 'enc:%' THEN 'enc'
            WHEN length(coalesce(config->>'api_key', config->>'apiKey', '')) > 0 THEN 'plain'
            ELSE 'empty'
          END AS key_kind
   FROM marketplace_cabinets
   WHERE marketplace_type = 'ozon'
   ORDER BY id`
);
console.log('ozon cabinets', JSON.stringify(cabs.rows, null, 2));

process.exit(0);
