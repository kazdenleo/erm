/**
 * Проставить orders.warehouse_id из warehouse_mappings для FBS без склада.
 * Usage: node scripts/admin/tmp_backfill_order_warehouse_ids.mjs [profileId]
 */
import { query, closePool } from '../../src/config/database.js';
import ordersService from '../../src/services/orders.service.js';

const profileIdArg = process.argv[2] != null ? Number(process.argv[2]) : null;

async function main() {
  const params = [];
  let sql = `
    SELECT id, marketplace, order_id, delivery_address, profile_id, warehouse_id
    FROM orders
    WHERE archived_at IS NULL
      AND marketplace <> 'manual'
      AND warehouse_id IS NULL
  `;
  if (Number.isFinite(profileIdArg) && profileIdArg > 0) {
    params.push(profileIdArg);
    sql += ` AND profile_id = $1`;
  }
  sql += ` ORDER BY id DESC`;

  const res = await query(sql, params);
  const rows = res.rows || [];
  console.log('CANDIDATES', rows.length);

  let updated = 0;
  let unresolved = 0;
  for (const row of rows) {
    try {
      const wid = await ordersService._resolveOwnWarehouseIdForOrder(row);
      const n = Number(wid);
      if (!Number.isFinite(n) || n < 1) {
        unresolved += 1;
        continue;
      }
      await query(`UPDATE orders SET warehouse_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND warehouse_id IS NULL`, [
        n,
        row.id,
      ]);
      updated += 1;
    } catch (e) {
      console.warn('FAIL', row.id, e?.message || e);
    }
  }
  console.log('UPDATED', updated, 'UNRESOLVED', unresolved);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
