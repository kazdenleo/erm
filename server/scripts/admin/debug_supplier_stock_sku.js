/**
 * Debug supplier stocks for SKU (usage: node scripts/admin/debug_supplier_stock_sku.js E500108)
 */
import { query, closePool } from '../../src/config/database.js';

const sku = process.argv[2] || 'E500108';

async function main() {
  const prod = await query('SELECT id, sku, name FROM products WHERE sku = $1 LIMIT 1', [sku]);
  console.log('product:', prod.rows[0] || null);
  if (!prod.rows[0]) return;

  const pid = prod.rows[0].id;

  const stocks = await query(
    `SELECT ss.stock, ss.cached_at, s.id AS supplier_id, s.code, s.name
     FROM supplier_stocks ss
     JOIN suppliers s ON ss.supplier_id = s.id
     WHERE ss.product_id = $1
     ORDER BY s.code`,
    [pid]
  );
  console.log('\nsupplier_stocks:', stocks.rows);

  const wh = await query(
    `SELECT w.id, w.address, w.supplier_id, w.main_warehouse_id, w.profile_id, s.code, s.name
     FROM warehouses w
     LEFT JOIN suppliers s ON w.supplier_id = s.id
     WHERE w.type = 'supplier'
     ORDER BY s.code NULLS LAST`
  );
  console.log('\nsupplier warehouses:', wh.rows);

  const breakdownAll = await query(
    `SELECT ss.stock, s.id AS supplier_id, s.code
     FROM supplier_stocks ss
     JOIN suppliers s ON ss.supplier_id = s.id
     WHERE ss.product_id = $1 AND COALESCE(ss.stock, 0) > 0
       AND EXISTS (
         SELECT 1 FROM warehouses w
         WHERE w.supplier_id = s.id
           AND w.type = 'supplier'
           AND w.main_warehouse_id IS NOT NULL
       )`,
    [pid]
  );
  console.log('\nbreakdown (any main warehouse):', breakdownAll.rows);

  for (const row of wh.rows) {
    if (!row.main_warehouse_id) continue;
    const mw = row.main_warehouse_id;
    const b = await query(
      `SELECT ss.stock, s.code
       FROM supplier_stocks ss
       JOIN suppliers s ON ss.supplier_id = s.id
       WHERE ss.product_id = $1 AND COALESCE(ss.stock, 0) > 0
         AND EXISTS (
           SELECT 1 FROM warehouses w
           WHERE w.supplier_id = s.id
             AND w.type = 'supplier'
             AND w.main_warehouse_id = $2
         )`,
      [pid, mw]
    );
    console.log(`\nbreakdown main_warehouse_id=${mw} (${row.address}):`, b.rows);
  }

  const integ = await query(
    `SELECT id, code, type, name, config, is_active
     FROM integrations
     WHERE LOWER(code) IN ('moskvorechie', 'mikado', 'москворечье')
        OR LOWER(name) LIKE '%mosk%' OR LOWER(name) LIKE '%mikado%'`
  );
  console.log('\nintegrations:', integ.rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    hasUserId: Boolean(r.config?.user_id),
    keys: r.config ? Object.keys(r.config) : []
  })));

  const sup = await query(`SELECT id, code, name, api_config FROM suppliers WHERE id IN (1, 2)`);
  console.log('\nsuppliers api_config keys:', sup.rows.map((r) => ({
    code: r.code,
    keys: r.api_config ? Object.keys(r.api_config) : []
  })));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
