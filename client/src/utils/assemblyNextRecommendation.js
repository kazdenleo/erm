/**
 * Рекомендация «следующий к сборке» для FBS: первый заказ из отфильтрованного списка.
 */

import { getAssemblyOrderCompositionLines, orderLineArticle } from './assemblyOrderComposition.js';

function orderProductId(order) {
  const raw = order?.productId ?? order?.product_id;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function orderWarehouseId(order) {
  const raw = order?.warehouseId ?? order?.warehouse_id;
  const n = raw != null && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * @param {{ key: string, rows: object[], primary: object } | null | undefined} group
 * @returns {null | {
 *   groupKey: string,
 *   order: object,
 *   rows: object[],
 *   productId: number|null,
 *   warehouseId: number|null,
 *   productName: string,
 *   article: string,
 *   quantity: number,
 *   isKit: boolean,
 *   packingDisplayValue: string,
 *   components: { article: string, quantity: number, name?: string, displayAttributeValue?: string }[],
 * }}
 */
export function buildAssemblyNextRecommendation(group) {
  if (!group?.primary) return null;
  const order = group.primary;
  const rows = Array.isArray(group.rows) && group.rows.length ? group.rows : [order];
  const composition = getAssemblyOrderCompositionLines(rows);
  const productId = orderProductId(order);
  const warehouseId = orderWarehouseId(order);
  const productName = String(order.productName ?? order.product_name ?? '').trim() || '—';
  const article = orderLineArticle(order);
  const quantity = Math.max(
    1,
    rows.reduce((sum, r) => sum + (Math.max(1, Number(r.quantity) || 1)), 0)
  );
  const isKit =
    order.isKit === true ||
    order.is_kit === true ||
    composition.length > 1;
  const packingDisplayValue = String(
    order.packingDisplayValue ??
      order.packing_display_value ??
      order.displayAttributeValue ??
      order.display_attribute_value ??
      ''
  ).trim();

  const components = [];
  for (const o of rows) {
    const acl = o.assemblyCompositionLines ?? o.assembly_composition_lines;
    if (!Array.isArray(acl) || !acl.length) continue;
    for (const line of acl) {
      const art =
        line.article ??
        line.sku ??
        line.productSku ??
        line.product_sku ??
        line.offerId ??
        line.offer_id ??
        '—';
      const qty = Math.max(0, Number(line.quantity ?? line.qty ?? line.needQty ?? line.need_qty) || 0);
      if (qty <= 0) continue;
      components.push({
        article: String(art).trim() || '—',
        quantity: qty,
        name: String(line.name ?? line.productName ?? line.product_name ?? '').trim(),
        displayAttributeValue: String(
          line.displayAttributeValue ?? line.display_attribute_value ?? ''
        ).trim(),
      });
    }
  }
  if (!components.length && composition.length) {
    for (const line of composition) {
      const m = String(line).match(/^(.*?)\s+-\s+(\d+)\s*$/);
      if (m) {
        components.push({ article: m[1], quantity: Number(m[2]) || 1, name: '', displayAttributeValue: '' });
      } else {
        components.push({ article: String(line), quantity: 1, name: '', displayAttributeValue: '' });
      }
    }
  }

  return {
    groupKey: group.key,
    order,
    rows,
    productId,
    warehouseId,
    productName,
    article,
    quantity,
    isKit,
    packingDisplayValue,
    components,
  };
}
