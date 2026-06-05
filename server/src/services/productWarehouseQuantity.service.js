/**
 * Синхронизация products.quantity с суммой product_warehouse_stock (без зависимости от kitStock).
 */

import { query } from '../config/database.js';

export async function syncProductQuantityFromWarehouseStock(productId) {
  const pid = Number(productId);
  const r = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS total
     FROM product_warehouse_stock WHERE product_id = $1`,
    [pid]
  );
  const total = Math.max(0, Number(r.rows[0]?.total ?? 0) || 0);
  await query(
    `UPDATE products SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [total, pid]
  );
  return total;
}

/**
 * Если в products.quantity есть остаток, а в product_warehouse_stock сумма 0 — переносим в PWS.
 * Устраняет рассинхрон: в истории balance_after = products.quantity, в списке по складу — PWS.
 */
export async function reconcileLegacyProductQuantityToPws(productId, warehouseId = null) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return 0;

  const pr = await query(
    `SELECT COALESCE(quantity, 0)::int AS legacy FROM products WHERE id = $1`,
    [pid]
  );
  const legacy = Math.max(0, Number(pr.rows[0]?.legacy) || 0);
  if (legacy <= 0) return 0;

  const sumR = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS total
     FROM product_warehouse_stock WHERE product_id = $1`,
    [pid]
  );
  const pwsSum = Math.max(0, Number(sumR.rows[0]?.total) || 0);
  if (pwsSum > 0) {
    if (pwsSum !== legacy) {
      await syncProductQuantityFromWarehouseStock(pid);
    }
    return pwsSum;
  }

  let whId = warehouseId != null && String(warehouseId).trim() !== '' ? Number(warehouseId) : null;
  if (!Number.isFinite(whId) || whId < 1) {
    const whR = await query(
      `SELECT id FROM warehouses
       WHERE COALESCE(is_supplier, false) = false
         AND LOWER(TRIM(COALESCE(type::text, ''))) = 'warehouse'
       ORDER BY id ASC
       LIMIT 1`
    );
    whId = whR.rows[0]?.id != null ? Number(whR.rows[0].id) : null;
  }
  if (!Number.isFinite(whId) || whId < 1) return legacy;

  await query(
    `INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [pid, whId, legacy]
  );
  return legacy;
}
