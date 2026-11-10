/**
 * Исправление себестоимости в закупках/приёмках Москворечья по фактическим ценам отгрузки.
 *
 * USAGE (prod):
 *   node scripts/admin/fix_moskv_receipt_costs.js
 *   APPLY=1 node scripts/admin/fix_moskv_receipt_costs.js
 */
import { query, closePool } from '../../src/config/database.js';

/** purchase_id → sku → фактическая цена из кабинета поставщика */
const FIXES = [
  { purchaseId: 486, sku: 'E410021', price: 840 },
  { purchaseId: 479, sku: 'E410057', price: 935 },
  { purchaseId: 478, sku: 'E500053', price: 1427 },
  { purchaseId: 354, sku: 'E410057', price: 935 },
];

const APPLY = String(process.env.APPLY || '').trim() === '1';

async function main() {
  console.log(APPLY ? '=== APPLY mode ===' : '=== DRY-RUN (set APPLY=1 to write) ===');

  for (const fix of FIXES) {
    const sku = fix.sku.toUpperCase();
    const product = await query(
      `SELECT id, sku, cost FROM products WHERE UPPER(TRIM(sku)) = $1 LIMIT 1`,
      [sku]
    );
    const productId = product.rows?.[0]?.id;
    if (!productId) {
      console.log(`SKIP purchase #${fix.purchaseId} ${sku}: product not found`);
      continue;
    }

    const pi = await query(
      `SELECT id, purchase_price
       FROM purchase_items
       WHERE purchase_id = $1 AND product_id = $2`,
      [fix.purchaseId, productId]
    );
    const item = pi.rows?.[0];
    if (!item) {
      console.log(`SKIP purchase #${fix.purchaseId} ${sku}: purchase_item not found`);
      continue;
    }

    const oldPrice = item.purchase_price != null ? Number(item.purchase_price) : null;
    console.log(
      `purchase #${fix.purchaseId} ${sku}: purchase_price ${oldPrice} → ${fix.price}` +
        (oldPrice === fix.price ? ' (already ok)' : '')
    );

    const receiptLines = await query(
      `
      SELECT wrl.id AS line_id, wr.id AS receipt_id, wrl.cost, wrl.quantity,
             pr.status AS receipt_status, wr.created_at
      FROM warehouse_receipt_lines wrl
      JOIN warehouse_receipts wr ON wr.id = wrl.receipt_id
      JOIN purchase_receipts pr ON pr.warehouse_receipt_id = wr.id
      WHERE pr.purchase_id = $1 AND wrl.product_id = $2
      ORDER BY wr.created_at DESC NULLS LAST
      `,
      [fix.purchaseId, productId]
    );
    for (const rl of receiptLines.rows || []) {
      const oldCost = rl.cost != null ? Number(rl.cost) : null;
      console.log(
        `  receipt #${rl.receipt_id} line #${rl.line_id}: cost ${oldCost} → ${fix.price}` +
          (oldCost === fix.price ? ' (already ok)' : '')
      );
    }

    if (!APPLY) continue;

    await query(
      `UPDATE purchase_items
       SET purchase_price = $3, updated_at = CURRENT_TIMESTAMP
       WHERE purchase_id = $1 AND product_id = $2`,
      [fix.purchaseId, productId, fix.price]
    );

    if ((receiptLines.rows || []).length) {
      await query(
        `
        UPDATE warehouse_receipt_lines wrl
        SET cost = $3
        FROM purchase_receipts pr
        WHERE pr.warehouse_receipt_id = wrl.receipt_id
          AND pr.purchase_id = $1
          AND wrl.product_id = $2
        `,
        [fix.purchaseId, productId, fix.price]
      );
    }

    // Карточка: правим cost только если он совпадал со старой (ошибочной) закупочной ценой.
    if (oldPrice != null && Number.isFinite(oldPrice) && oldPrice !== fix.price) {
      await query(
        `UPDATE products
         SET cost = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND cost IS NOT DISTINCT FROM $3::numeric`,
        [productId, fix.price, oldPrice]
      );
    }
  }

  console.log('done');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    try {
      await closePool();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
