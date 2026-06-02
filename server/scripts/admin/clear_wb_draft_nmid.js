#!/usr/bin/env node
/**
 * Удалить устаревший nmId из wb_draft (после смены логики хранения).
 * node scripts/admin/clear_wb_draft_nmid.js [productId]
 */
import { query } from '../../src/config/database.js';

const productId = process.argv[2] ? Number(process.argv[2]) : null;

let sql = `
  UPDATE products
  SET wb_draft = (wb_draft - 'nmId' - 'nmID' - 'nm_id'),
      updated_at = CURRENT_TIMESTAMP
  WHERE wb_draft IS NOT NULL
    AND (
      wb_draft ? 'nmId' OR wb_draft ? 'nmID' OR wb_draft ? 'nm_id'
    )
`;
const params = [];
if (productId && Number.isFinite(productId)) {
  sql += ' AND id = $1';
  params.push(productId);
}
sql += ' RETURNING id, sku, wb_draft';

const res = await query(sql, params);
console.log(`Обновлено товаров: ${res.rowCount}`);
for (const row of res.rows) {
  console.log(JSON.stringify({ id: row.id, sku: row.sku, wb_draft: row.wb_draft }));
}
process.exit(0);
