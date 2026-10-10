/**
 * Рекомендация текущего / следующего заказа для FBS.
 */

import { getAssemblyOrderCompositionLines, orderLineArticle } from './assemblyOrderComposition.js';

/**
 * Слева — следующий заказ из очереди; как только по нему начат скан, он становится текущим.
 * Справа — последний собранный. После сборки текущий уходит вправо, слева — новый следующий.
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
  lastCollectedKey = '',
  canAssembleGroup = null,
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

  const sessionGroup = currentOrderKey ? findByKey(currentOrderKey) : null;
  const inProgress = sessionGroup && !currentOrderAssembled ? sessionGroup : null;

  // Только что собранный может ещё висеть в очереди до перезагрузки списков.
  const previous =
    (sessionGroup && currentOrderAssembled ? sessionGroup : null) ||
    findByKey(lastCollectedKey) ||
    collected[0] ||
    null;

  // Следующим предлагаем только заказ, который можно собрать (например, есть стикер).
  const canAssemble = typeof canAssembleGroup === 'function' ? canAssembleGroup : () => true;
  const mainGroup =
    inProgress || queue.find((g) => g.key !== previous?.key && canAssemble(g)) || null;
  const sideGroup = previous && previous.key !== mainGroup?.key ? previous : null;

  return {
    currentGroup: mainGroup,
    currentRole: inProgress ? 'current' : mainGroup ? 'next' : 'empty',
    sideGroup,
    sideRole: sideGroup ? 'previous' : 'empty',
  };
}

export function assemblyStageLabel(role) {
  if (role === 'previous') return 'Последний собранный';
  if (role === 'next' || role === 'empty') return 'Следующий';
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

function rowComponents(o) {
  const acl = o?.assemblyCompositionLines ?? o?.assembly_composition_lines;
  if (!Array.isArray(acl) || !acl.length) return [];
  const out = [];
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
    out.push({
      article: String(art).trim() || '—',
      quantity: qty,
      productId: Number(line.productId ?? line.product_id) || null,
      name: String(line.name ?? line.productName ?? line.product_name ?? '').trim(),
      displayAttributeValue: String(
        line.displayAttributeValue ?? line.display_attribute_value ?? ''
      ).trim(),
    });
  }
  return out;
}

function packingFromComponents(components) {
  const values = [];
  for (const c of components) {
    const v = String(c.displayAttributeValue ?? '').trim();
    if (v && !values.includes(v)) values.push(v);
  }
  return values.join(', ');
}

function rowPacking(row, components) {
  const own = String(
    row.packingDisplayValue ??
      row.packing_display_value ??
      row.displayAttributeValue ??
      row.display_attribute_value ??
      ''
  ).trim();
  return own || packingFromComponents(components);
}

function addComponents(target, list) {
  for (const c of list) {
    const same = target.find(
      (x) => (c.productId && x.productId === c.productId) || (!c.productId && x.article === c.article)
    );
    if (same) same.quantity += c.quantity;
    else target.push({ ...c });
  }
  return target;
}

/**
 * Позиции заказа (строки группы), одинаковые товары/комплекты склеены.
 * В заказе может быть несколько разных комплектов — у каждого своя упаковка и состав.
 */
function buildAssemblyItems(rows) {
  const items = [];
  for (const r of rows) {
    const productId = orderProductId(r);
    const article = orderLineArticle(r);
    const key = productId != null ? `p:${productId}` : `a:${article}`;
    const comps = rowComponents(r);
    const qty = Math.max(1, Number(r.quantity) || 1);
    const existing = items.find((i) => i.key === key);
    if (existing) {
      existing.quantity += qty;
      addComponents(existing.components, comps);
      continue;
    }
    const isKit = r.isKit === true || r.is_kit === true || comps.length > 1;
    items.push({
      key,
      productId,
      article,
      productName: String(r.productName ?? r.product_name ?? '').trim() || '—',
      quantity: qty,
      isKit,
      packingDisplayValue: rowPacking(r, comps),
      components: addComponents([], comps),
    });
  }
  return items;
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

  const components = rows.flatMap(rowComponents);
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

  if (!packingDisplayValue) packingDisplayValue = packingFromComponents(components);

  const items = buildAssemblyItems(rows);
  const packingValues = [...new Set(items.map((i) => i.packingDisplayValue).filter(Boolean))];

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
    items,
    packingValues,
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
