/**
 * Проверка участия товара в операциях ERP (заказы, приёмки, закупки, движения и т.д.).
 * Такие товары нельзя удалять физически — только отправить в архив.
 */

import { query } from '../config/database.js';

/** @typedef {{ key: string, label: string }} ParticipationCheck */

/** @type {ParticipationCheck[]} */
export const PRODUCT_PARTICIPATION_CHECKS = [
  { key: 'orders', label: 'заказы' },
  { key: 'stock_movements', label: 'движения остатков' },
  { key: 'warehouse_receipts', label: 'приёмки на склад' },
  { key: 'purchases', label: 'закупки' },
  { key: 'purchase_receipts', label: 'приёмки по закупке' },
  { key: 'inventory', label: 'инвентаризации' },
  { key: 'kits', label: 'комплекты' },
  { key: 'supplier_returns', label: 'возвраты поставщику' },
  { key: 'warehouse_stock', label: 'остатки на складах' },
];

const PARTICIPATION_UNION_SQL = `
  SELECT 'orders' AS kind FROM orders WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'stock_movements' FROM stock_movements WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'warehouse_receipts' FROM warehouse_receipt_lines WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'purchases' FROM purchase_items WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'purchase_receipts' FROM purchase_receipt_items WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'inventory' FROM inventory_session_lines WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'kits' FROM kit_components
    WHERE kit_product_id = $1 OR component_product_id = $1
  LIMIT 1
  UNION ALL
  SELECT 'supplier_returns' FROM supplier_return_items WHERE product_id = $1 LIMIT 1
  UNION ALL
  SELECT 'warehouse_stock' FROM product_warehouse_stock
    WHERE product_id = $1 AND COALESCE(quantity, 0) <> 0
  LIMIT 1
  UNION ALL
  SELECT 'reserved' FROM products
    WHERE id = $1 AND COALESCE(reserved_quantity, 0) > 0
  LIMIT 1
  UNION ALL
  SELECT 'incoming' FROM products
    WHERE id = $1 AND COALESCE(incoming_quantity, 0) > 0
  LIMIT 1
`;

const LABEL_BY_KEY = Object.fromEntries(PRODUCT_PARTICIPATION_CHECKS.map((c) => [c.key, c.label]));

function normalizeProductId(productId) {
  const n = typeof productId === 'string' ? parseInt(productId, 10) : Number(productId);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {number|string} productId
 * @returns {Promise<{ hasParticipation: boolean, reasons: string[], kinds: string[] }>}
 */
export async function getProductParticipation(productId) {
  const pid = normalizeProductId(productId);
  if (!pid) {
    return { hasParticipation: false, reasons: [], kinds: [] };
  }

  const result = await query(`SELECT kind FROM (${PARTICIPATION_UNION_SQL}) AS hits`, [pid]);
  const kinds = [...new Set((result.rows || []).map((r) => String(r.kind)))];
  const reasons = kinds.map((k) => LABEL_BY_KEY[k] || k).filter(Boolean);

  return {
    hasParticipation: kinds.length > 0,
    reasons,
    kinds,
  };
}

/**
 * @param {Array<number|string>} productIds
 * @returns {Promise<Map<string, { hasParticipation: boolean, reasons: string[] }>>}
 */
export async function getProductParticipationBatch(productIds) {
  const ids = [
    ...new Set(
      (productIds || [])
        .map(normalizeProductId)
        .filter((id) => id != null)
    ),
  ];
  const out = new Map();
  if (ids.length === 0) return out;

  const batchUnionSql = `
    SELECT product_id, 'orders' AS kind FROM orders WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'stock_movements' FROM stock_movements WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'warehouse_receipts' FROM warehouse_receipt_lines WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'purchases' FROM purchase_items WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'purchase_receipts' FROM purchase_receipt_items WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'inventory' FROM inventory_session_lines WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT kit_product_id, 'kits' FROM kit_components WHERE kit_product_id = ANY($1::bigint[])
    UNION ALL
    SELECT component_product_id, 'kits' FROM kit_components WHERE component_product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'supplier_returns' FROM supplier_return_items WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'warehouse_stock' FROM product_warehouse_stock
      WHERE product_id = ANY($1::bigint[]) AND COALESCE(quantity, 0) <> 0
    UNION ALL
    SELECT id, 'reserved' FROM products
      WHERE id = ANY($1::bigint[]) AND COALESCE(reserved_quantity, 0) > 0
    UNION ALL
    SELECT id, 'incoming' FROM products
      WHERE id = ANY($1::bigint[]) AND COALESCE(incoming_quantity, 0) > 0
  `;

  const result = await query(batchUnionSql, [ids]);
  const byProduct = new Map();
  for (const row of result.rows || []) {
    const key = String(row.product_id);
    if (!byProduct.has(key)) byProduct.set(key, new Set());
    byProduct.get(key).add(String(row.kind));
  }

  for (const id of ids) {
    const key = String(id);
    const kinds = [...(byProduct.get(key) || [])];
    const reasons = kinds.map((k) => LABEL_BY_KEY[k] || k).filter(Boolean);
    out.set(key, { hasParticipation: kinds.length > 0, reasons });
  }

  return out;
}

export const PRODUCT_DELETE_BLOCKED_MESSAGE =
  'Товар участвовал в движениях и заказах, удаление невозможно. Отправьте в архив.';
