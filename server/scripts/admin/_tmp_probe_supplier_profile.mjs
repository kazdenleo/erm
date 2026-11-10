import fs from 'fs';

for (const line of fs.readFileSync('/opt/erm/server/.env', 'utf8').split(/\n/)) {
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i);
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const { query, closePool } = await import('../../src/config/database.js');

console.log(
  'products by profile',
  (
    await query(
      `SELECT COALESCE(profile_id::text,'(null)') AS profile_id, COUNT(*)::int n FROM products GROUP BY 1 ORDER BY 1`
    )
  ).rows
);

console.log(
  'positive supplier stocks by product profile',
  (
    await query(
      `SELECT COALESCE(p.profile_id::text,'(null)') AS product_profile, ss.supplier_id, COUNT(*)::int rows, SUM(ss.stock)::int qty
       FROM supplier_stocks ss
       JOIN products p ON p.id = ss.product_id
       WHERE COALESCE(ss.stock,0) > 0
       GROUP BY 1,2 ORDER BY 1,2`
    )
  ).rows
);

console.log(
  'profile1 products with any supplier row',
  (
    await query(
      `SELECT COUNT(DISTINCT p.id)::int products,
              COUNT(*) FILTER (WHERE COALESCE(ss.stock,0)>0)::int positive_rows,
              COALESCE(SUM(ss.stock),0)::int qty
       FROM products p
       LEFT JOIN supplier_stocks ss ON ss.product_id = p.id
       WHERE p.profile_id = 1`
    )
  ).rows
);

console.log(
  'sample profile1 with positive',
  (
    await query(
      `SELECT p.sku, ss.supplier_id, ss.stock
       FROM products p
       JOIN supplier_stocks ss ON ss.product_id = p.id
       WHERE p.profile_id = 1 AND COALESCE(ss.stock,0) > 0
       ORDER BY ss.stock DESC LIMIT 20`
    )
  ).rows
);

console.log(
  'integrations for suppliers',
  (
    await query(
      `SELECT id, profile_id, type, code, name,
              CASE WHEN config::text ILIKE '%enc:v1:%' THEN 'has_enc' ELSE 'no_enc' END AS enc
       FROM integrations
       WHERE type ILIKE '%supplier%' OR code ILIKE '%mikado%' OR code ILIKE '%moskv%' OR name ILIKE '%mikado%' OR name ILIKE '%москв%'
       ORDER BY id`
    )
  ).rows
);

// where credentials live
const integ = await query(
  `SELECT id, profile_id, code, jsonb_object_keys(config) AS k
   FROM integrations, LATERAL jsonb_object_keys(config) AS jsonb_object_keys
   WHERE code ILIKE '%mikado%' OR code ILIKE '%moskv%'
   ORDER BY id, k`
);
console.log('integration config keys', integ.rows);

await closePool();
