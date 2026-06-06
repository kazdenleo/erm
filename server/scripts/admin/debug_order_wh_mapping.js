import { query, closePool } from '../../src/config/database.js';

async function main() {
  const wh = await query(`SELECT id, address, type FROM warehouses ORDER BY id`);
  console.log('WAREHOUSES', wh.rows);

  const maps = await query(
    `SELECT wm.id, wm.warehouse_id, wm.marketplace, wm.marketplace_warehouse_id, w.address AS wh_address
     FROM warehouse_mappings wm
     JOIN warehouses w ON w.id = wm.warehouse_id
     WHERE wm.marketplace IN ('wb', 'wildberries', 'ozon', 'ym')
     ORDER BY wm.marketplace, wm.id`
  );
  console.log('\nMAPPINGS', maps.rows);

  for (const oid of ['5143153826', '5146823721']) {
    const o = await query(
      `SELECT id, order_id, marketplace, delivery_address, status, profile_id
       FROM orders WHERE order_id::text = $1`,
      [oid]
    );
    console.log('\nORDER', oid, o.rows[0]);
    const dbId = o.rows[0]?.id;
    if (dbId) {
      const firstReserve = await query(
        `SELECT warehouse_id, meta, created_at FROM stock_movements
         WHERE (meta->>'order_id')::bigint = $1 AND type = 'reserve'
         ORDER BY id ASC LIMIT 1`,
        [dbId]
      );
      console.log('first reserve', firstReserve.rows[0]);
    }
  }
}

main().finally(() => closePool());
