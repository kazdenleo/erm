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
