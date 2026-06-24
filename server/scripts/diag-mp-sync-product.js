#!/usr/bin/env node
/** Диагностика выгрузки остатков на МП: node scripts/diag-mp-sync-product.js <productId|sku> [warehouseId] */
import '../src/load-env.js';
import { query } from '../src/config/database.js';
import { computeAvailableQuantity } from '../src/services/sellableQuantity.service.js';
import { syncWarehouseStockToMarketplaces } from '../src/services/marketplaceWarehouseStockSync.service.js';
import { assertMarketplaceStockPushAllowed } from '../src/utils/organizationMarketplaceStockSyncPolicy.js';

const arg = process.argv[2];
const whArg = process.argv[3] || null;
if (!arg) {
  console.error('Usage: node scripts/diag-mp-sync-product.js <productId|sku> [warehouseId]');
  process.exit(1);
}

let pid = Number(arg);
if (!Number.isFinite(pid) || pid < 1) {
  const pr = await query(
    `SELECT id, sku, profile_id, organization_id, user_category_id FROM products WHERE UPPER(TRIM(sku)) = UPPER(TRIM($1)) LIMIT 1`,
    [arg]
  );
  if (!pr.rows[0]) {
    console.log('product not found for', arg);
    process.exit(0);
  }
  pid = Number(pr.rows[0].id);
}

const prof = await query(
  `SELECT id, sku, profile_id, organization_id, user_category_id FROM products WHERE id = $1`,
  [pid]
);
const p = prof.rows[0];
console.log('product', p);

if (p?.user_category_id) {
  const cat = await query(
    `SELECT id, name, skip_marketplace_stock_sync FROM user_categories WHERE id = $1`,
    [p.user_category_id]
  );
  console.log('category', cat.rows[0]);
}

const gate = await assertMarketplaceStockPushAllowed({
  productId: pid,
  organizationId: p?.organization_id
});
console.log('push_gate', gate);

const skus = await query(
  `SELECT marketplace, sku, marketplace_product_id FROM product_skus WHERE product_id = $1`,
  [pid]
);
console.log('product_skus', skus.rows);

const pws = await query(`SELECT warehouse_id, quantity FROM product_warehouse_stock WHERE product_id = $1`, [pid]);
console.log('pws', pws.rows);

const whs = await query(
  `SELECT w.id, w.address, wm.marketplace, wm.marketplace_warehouse_id
   FROM warehouses w
   LEFT JOIN warehouse_mappings wm ON wm.warehouse_id = w.id
   WHERE w.profile_id = $1
   ORDER BY w.id`,
  [p.profile_id]
);
console.log('warehouses_mappings', whs.rows);

const whIds = whArg ? [whArg] : [...new Set(pws.rows.map((r) => String(r.warehouse_id)))];
for (const wh of whIds) {
  const q = await computeAvailableQuantity(pid, {
    warehouseId: wh,
    profileId: p.profile_id,
    forMarketplace: true
  });
  console.log('available_for_mp wh', wh, q);
}

const syncWh = whArg || whs.rows.find((r) => r.marketplace === 'ozon')?.id || whIds[0];
if (syncWh) {
  const snap = await import('../src/services/sellableQuantity.service.js').then((m) =>
    m.getProductSupplySnapshotWithClient(null, pid, { warehouseId: syncWh })
  );
  console.log('ui_supply_snapshot wh', syncWh, snap);
  const sync = await syncWarehouseStockToMarketplaces(pid, {
    source: 'diag_script',
    warehouseId: syncWh,
    profileId: p.profile_id,
    organizationId: p.organization_id
  });
  console.log('sync_result wh', syncWh, JSON.stringify(sync, null, 2));
}

process.exit(0);
