/**
 * Участие товара в операциях ERP (документы, движения, остатки).
 *
 * Правила удаления:
 * - Обычный товар нельзя удалить, если он комплектующее в чужом комплекте (kit_components.component_product_id).
 * - Собственный состав комплекта (kit_components.kit_product_id) удалению не мешает — строки удалятся каскадом.
 * - Комплект можно удалить, если нет заказов, складских движений (кроме пар reserve/unreserve с нулевым итогом),
 *   приёмок, закупок, инвентаризаций, ненулевых остатков на SKU комплекта и активного резерва по журналу.
 * - При блокировке — только архив.
 */

import { query } from '../config/database.js';
import { NET_RESERVED_SUM_EXPR_SQL } from './sellableQuantity.service.js';

/** @typedef {{ key: string, label: string }} ParticipationCheck */

/** @type {ParticipationCheck[]} */
export const PRODUCT_PARTICIPATION_CHECKS = [
  { key: 'orders', label: 'заказы' },
  { key: 'stock_movements', label: 'движения остатков' },
  { key: 'warehouse_receipts', label: 'приёмки на склад' },
  { key: 'purchases', label: 'закупки' },
  { key: 'purchase_receipts', label: 'приёмки по закупке' },
  { key: 'inventory', label: 'инвентаризации' },
  { key: 'kit_component', label: 'входит в состав другого комплекта' },
  { key: 'supplier_returns', label: 'возвраты поставщику' },
  { key: 'warehouse_stock', label: 'остатки на складах' },
  { key: 'reserved', label: 'резерв по заказам' },
  { key: 'incoming', label: 'ожидается на склад' },
];

/** Резерв/unreserve учитываются отдельно; «движения» — только складские операции. */
const STOCK_MOVEMENT_KIND_FILTER = `type NOT IN ('reserve', 'unreserve')`;

const PARTICIPATION_UNION_SQL = `
  SELECT 'orders' AS kind
  WHERE EXISTS (SELECT 1 FROM orders WHERE product_id = $1)
  UNION ALL
  SELECT 'stock_movements' AS kind
  WHERE EXISTS (
    SELECT 1 FROM stock_movements
    WHERE product_id = $1 AND ${STOCK_MOVEMENT_KIND_FILTER}
  )
  UNION ALL
  SELECT 'warehouse_receipts' AS kind
  WHERE EXISTS (SELECT 1 FROM warehouse_receipt_lines WHERE product_id = $1)
  UNION ALL
  SELECT 'purchases' AS kind
  WHERE EXISTS (SELECT 1 FROM purchase_items WHERE product_id = $1)
  UNION ALL
  SELECT 'purchase_receipts' AS kind
  WHERE EXISTS (SELECT 1 FROM purchase_receipt_items WHERE product_id = $1)
  UNION ALL
  SELECT 'inventory' AS kind
  WHERE EXISTS (SELECT 1 FROM inventory_session_lines WHERE product_id = $1)
  UNION ALL
  SELECT 'kit_component' AS kind
  WHERE EXISTS (
    SELECT 1 FROM kit_components WHERE component_product_id = $1
  )
  UNION ALL
  SELECT 'supplier_returns' AS kind
  WHERE EXISTS (SELECT 1 FROM supplier_return_items WHERE product_id = $1)
  UNION ALL
  SELECT 'warehouse_stock' AS kind
  WHERE EXISTS (
    SELECT 1 FROM product_warehouse_stock
    WHERE product_id = $1 AND COALESCE(quantity, 0) <> 0
  )
  UNION ALL
  SELECT 'reserved' AS kind
  WHERE EXISTS (
    SELECT 1
    FROM (
      SELECT ${NET_RESERVED_SUM_EXPR_SQL}::int AS net
      FROM stock_movements
      WHERE product_id = $1 AND type IN ('reserve', 'unreserve')
    ) r
    WHERE net > 0
  )
  UNION ALL
  SELECT 'incoming' AS kind
  WHERE EXISTS (
    SELECT 1 FROM products
    WHERE id = $1 AND COALESCE(incoming_quantity, 0) > 0
  )
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
 * @returns {Promise<Map<string, { hasParticipation: boolean, reasons: string[], kinds: string[] }>>}
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
    SELECT product_id, 'stock_movements' AS kind FROM stock_movements
      WHERE product_id = ANY($1::bigint[]) AND ${STOCK_MOVEMENT_KIND_FILTER}
    UNION ALL
    SELECT product_id, 'warehouse_receipts' AS kind FROM warehouse_receipt_lines WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'purchases' AS kind FROM purchase_items WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'purchase_receipts' AS kind FROM purchase_receipt_items WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'inventory' AS kind FROM inventory_session_lines WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT component_product_id AS product_id, 'kit_component' AS kind FROM kit_components
      WHERE component_product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'supplier_returns' AS kind FROM supplier_return_items WHERE product_id = ANY($1::bigint[])
    UNION ALL
    SELECT product_id, 'warehouse_stock' AS kind FROM product_warehouse_stock
      WHERE product_id = ANY($1::bigint[]) AND COALESCE(quantity, 0) <> 0
    UNION ALL
    SELECT product_id, 'reserved' AS kind FROM (
      SELECT product_id,
        ${NET_RESERVED_SUM_EXPR_SQL}::int AS net
      FROM stock_movements
      WHERE product_id = ANY($1::bigint[]) AND type IN ('reserve', 'unreserve')
      GROUP BY product_id
    ) r WHERE net > 0
    UNION ALL
    SELECT id AS product_id, 'incoming' AS kind FROM products
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
    out.set(key, { hasParticipation: kinds.length > 0, reasons, kinds });
  }

  return out;
}

export const PRODUCT_DELETE_BLOCKED_MESSAGE =
  'Товар участвует в документах или операциях ERP, удаление невозможно. Отправьте в архив.';

export const PRODUCT_DELETE_BLOCKED_KIT_COMPONENT_MESSAGE =
  'Товар входит в состав комплекта — удаление невозможно. Уберите его из состава других комплектов или отправьте в архив.';

/**
 * @param {{ kinds?: string[], reasons?: string[] }} participation
 */
export function buildProductDeleteBlockedMessage(participation = {}) {
  const kinds = participation.kinds || [];
  const reasons = participation.reasons || [];
  if (kinds.includes('kit_component')) {
    return PRODUCT_DELETE_BLOCKED_KIT_COMPONENT_MESSAGE;
  }
  if (reasons.length > 0) {
    return `Удаление невозможно (${reasons.join(', ')}). Отправьте товар в архив.`;
  }
  return PRODUCT_DELETE_BLOCKED_MESSAGE;
}

