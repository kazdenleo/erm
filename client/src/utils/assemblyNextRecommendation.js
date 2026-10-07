/**
 * Рекомендация текущего / следующего заказа для FBS.
 */

import { getAssemblyOrderCompositionLines, orderLineArticle } from './assemblyOrderComposition.js';

/**
 * Слева — следующий заказ (после скана становится текущим).
 * Справа — всегда последний собранный.
 * После сборки заказ уходит вправо, слева появляется следующий из очереди.
 *
 * @returns {{
 *   currentGroup: object|null,
 *   currentRole: 'current'|'next'|'empty',
 *   sideGroup: object|null,
 *   sideRole: 'previous'|'empty',
 * }}
 */
export function pickAssemblyStageGroups({
  assemblyGroups = [],
  collectedGroups = [],
  currentOrderKey = '',
  lastAssembledGroup = null,
  currentOrderAssembled = false,
} = {}) {
  const queue = Array.isArray(assemblyGroups) ? assemblyGroups : [];
  const collected = Array.isArray(collectedGroups) ? collectedGroups : [];

  const findByKey = (key) => {
    if (!key) return null;
    return (
      queue.find((g) => g.key === key) ||
      collected.find((g) => g.key === key) ||
      (lastAssembledGroup?.key === key ? lastAssembledGroup : null) ||
      null
    );
  };

  const lastAssembled = (skipKey = '') => {
    const fromCollected = collected.find((g) => !skipKey || g.key !== skipKey);
    if (fromCollected) return fromCollected;
    if (lastAssembledGroup && (!skipKey || lastAssembledGroup.key !== skipKey)) {
      return lastAssembledGroup;
    }
    return null;
  };

  const sessionGroup = currentOrderKey ? findByKey(currentOrderKey) : null;

  /** Идёт сканирование: слева текущий, справа последний ранее собранный. */
  if (sessionGroup && !currentOrderAssembled) {
    const prev = lastAssembled(sessionGroup.key);
    return {
      currentGroup: sessionGroup,
      currentRole: 'current',
      sideGroup: prev,
      sideRole: prev ? 'previous' : 'empty',
    };
  }

  /** Только что собрали: справа этот заказ, слева следующий из очереди. */
  if (sessionGroup && currentOrderAssembled) {
    const nextGroup = queue.find((g) => g.key !== sessionGroup.key) || null;
    return {
      currentGroup: nextGroup,
      currentRole: nextGroup ? 'next' : 'empty',
      sideGroup: sessionGroup,
      sideRole: 'previous',
    };
  }

  /** Нет активной сессии: слева следующий из очереди, справа последний собранный. */
  const prev = lastAssembled();
  if (queue.length > 0) {
    return {
      currentGroup: queue[0],
      currentRole: 'next',
      sideGroup: prev,
      sideRole: prev ? 'previous' : 'empty',
    };
  }

  return {
    currentGroup: null,
    currentRole: 'empty',
    sideGroup: prev,
    sideRole: prev ? 'previous' : 'empty',
  };
}

export function assemblyStageLabel(role) {
  if (role === 'previous') return 'Последний собранный';
  if (role === 'next') return 'Следующий к сборке';
  if (role === 'empty') return 'Следующий к сборке';
  return 'Текущий заказ';
}

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
  let packingDisplayValue = String(
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
        productId: Number(line.productId ?? line.product_id) || null,
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
        components.push({ article: m[1], quantity: Number(m[2]) || 1, productId: null, name: '', displayAttributeValue: '' });
      } else {
        components.push({ article: String(line), quantity: 1, productId: null, name: '', displayAttributeValue: '' });
      }
    }
  }

  if (!packingDisplayValue) {
    const fromComps = [];
    for (const c of components) {
      const v = String(c.displayAttributeValue ?? '').trim();
      if (v && !fromComps.includes(v)) fromComps.push(v);
    }
    packingDisplayValue = fromComps.join(', ');
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
    orderDbId: Number(order.id) || null,
    orderDbIds: [
      ...new Set(
        rows
          .map((r) => Number(r.id))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ],
    marketplaceOrderId: String(order.orderId ?? order.order_id ?? '').trim() || null,
  };
}
