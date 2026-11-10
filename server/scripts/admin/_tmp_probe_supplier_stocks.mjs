import { query, closePool } from '../../src/config/database.js';

console.log('=== suppliers ===');
const suppliers = await query(`SELECT id, code, name, is_active, updated_at, api_config FROM suppliers ORDER BY id`);
for (const s of suppliers.rows) {
  const cfg = s.api_config && typeof s.api_config === 'object' ? Object.keys(s.api_config) : [];
  console.log({
    id: s.id,
    code: s.code,
    name: s.name,
    active: s.is_active,
    updated: s.updated_at,
    apiConfigKeys: cfg
  });
}

console.log('=== supplier_stocks columns ===');
console.log(
  (
    await query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'supplier_stocks'
  ORDER BY ordinal_position
`)
  ).rows
);

console.log('=== stock stats ===');
console.log(
  (
    await query(`
  SELECT s.id, s.code,
         count(ss.*)::int AS rows,
         count(*) FILTER (WHERE COALESCE(ss.stock,0) > 0)::int AS with_stock,
         max(ss.updated_at) AS last_upd
  FROM suppliers s
  LEFT JOIN supplier_stocks ss ON ss.supplier_id = s.id
  GROUP BY s.id, s.code
  ORDER BY s.id
`)
  ).rows
);

console.log('=== updated last 30m ===');
console.log(
  (
    await query(`
  SELECT count(*)::int AS n, max(updated_at) AS max_u
  FROM supplier_stocks
  WHERE updated_at > now() - interval '30 minutes'
`)
  ).rows
);

console.log('=== recent rows ===');
console.log(
  (
    await query(`
  SELECT s.id AS supplier_id, s.code, ss.sku, ss.stock, ss.updated_at
  FROM supplier_stocks ss
  JOIN suppliers s ON s.id = ss.supplier_id
  ORDER BY ss.updated_at DESC NULLS LAST
  LIMIT 20
`)
  ).rows
);

console.log('=== profiles supplier sync flags ===');
try {
  console.log(
    (
      await query(`
    SELECT id, name, timezone,
           supplier_sync_enabled, supplier_stocks_sync_enabled,
           integrations_enabled, is_active
    FROM profiles
    ORDER BY id
  `)
    ).rows
  );
} catch (e) {
  console.log('profiles flags query:', e.message);
  console.log(
    (
      await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='profiles' AND column_name ILIKE '%supplier%' OR (table_name='profiles' AND column_name ILIKE '%sync%')
    ORDER BY column_name
  `)
    ).rows
  );
  console.log((await query(`SELECT id, name FROM profiles ORDER BY id`)).rows);
}

await closePool();
