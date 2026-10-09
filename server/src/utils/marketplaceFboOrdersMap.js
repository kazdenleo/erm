/**
 * Разбор ответов API маркетплейсов в строки marketplace_fbo_orders (одна строка — позиция заказа).
 */

export const WB_FBO_WAREHOUSE_TYPE = 'Склад WB';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v, max = 255) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function qty(v) {
  return Math.max(1, Math.round(num(v)) || 1);
}

/** Разбивает период YYYY-MM-DD..YYYY-MM-DD (включительно) на куски по `days` дней. */
export function ymdChunks(fromYmd, toYmd, days) {
  const out = [];
  let a = fromYmd;
  while (a <= toYmd) {
    const end = new Date(`${a}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + days - 1);
    const endYmd = end.toISOString().slice(0, 10);
    const b = endYmd < toYmd ? endYmd : toYmd;
    out.push([a, b]);
    const next = new Date(`${b}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    a = next.toISOString().slice(0, 10);
  }
  return out;
}

/** Схлопывает повторяющиеся позиции заказа (одинаковый line_key): qty суммируется, цена — средневзвешенная. */
export function mergeLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const k = `${l.order_id}\u0001${l.line_key}`;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, { ...l });
      continue;
    }
    const total = prev.quantity + l.quantity;
    prev.price = total > 0 ? (prev.price * prev.quantity + l.price * l.quantity) / total : l.price;
    prev.quantity = total;
  }
  return [...map.values()];
}

/** Ozon /v2/posting/fbo/list → строки; цена — products[].price (цена продавца после его скидки). */
export function mapOzonPostings(postings) {
  const lines = [];
  for (const p of postings || []) {
    const orderId = str(p?.posting_number, 128);
    const orderedAt = p?.created_at || p?.in_process_at;
    if (!orderId || !orderedAt) continue;
    const status = str(p.status, 64);
    (p.products || []).forEach((pr, i) => {
      lines.push({
        order_id: orderId,
        line_key: str(pr?.sku ?? pr?.offer_id ?? i, 128),
        offer_id: str(pr?.offer_id),
        sku: str(pr?.sku, 64),
        product_name: str(pr?.name, 2000),
        quantity: qty(pr?.quantity),
        price: num(pr?.price),
        status,
        is_cancelled: status === 'cancelled',
        ordered_at: orderedAt,
        warehouse_name: str(p?.analytics_data?.warehouse_name),
      });
    });
  }
  return mergeLines(lines);
}

/**
 * WB Statistics /api/v1/supplier/orders → строки только со склада WB (FBO).
 * Одна строка ответа — одна штука; при повторе srid берётся последнее изменение.
 */
export function mapWbOrders(rows) {
  const byId = new Map();
  for (const o of rows || []) {
    if (o?.warehouseType !== WB_FBO_WAREHOUSE_TYPE || !o?.date) continue;
    const orderId = str(o.srid, 128) || str(`${o.gNumber}:${o.nmId}:${o.date}`, 128);
    if (!orderId) continue;
    const cancelled = o.isCancel === true;
    byId.set(orderId, {
      order_id: orderId,
      line_key: '1',
      offer_id: str(o.supplierArticle),
      sku: str(o.nmId, 64),
      product_name: str([o.subject, o.brand].filter(Boolean).join(' '), 2000),
      quantity: 1,
      price: num(o.priceWithDisc),
      status: cancelled ? 'cancelled' : 'ordered',
      is_cancelled: cancelled,
      ordered_at: `${String(o.date).slice(0, 19)}+03:00`,
      warehouse_name: str(o.warehouseName),
    });
  }
  return [...byId.values()];
}

/** Цена позиции Яндекса до скидок: то, что платит покупатель, + компенсация Маркета. */
export function ymItemUnitPrice(item) {
  const prices = Array.isArray(item?.prices) ? item.prices : [];
  return prices
    .filter((p) => p?.type === 'BUYER' || p?.type === 'MARKETPLACE')
    .reduce((s, p) => s + num(p.costPerItem), 0);
}

/** Яндекс /v2/campaigns/{id}/stats/orders → строки. creationDate — дата по МСК без времени. */
export function mapYmOrders(orders) {
  const lines = [];
  for (const o of orders || []) {
    const orderId = str(o?.id, 128);
    const day = str(o?.creationDate, 10);
    if (!orderId || !day) continue;
    const status = str(o.status, 64);
    const cancelled = /^CANCELLED/i.test(status || '') || status === 'REJECTED';
    (o.items || []).forEach((it, i) => {
      lines.push({
        order_id: orderId,
        line_key: str(it?.shopSku ?? it?.marketSku ?? i, 128),
        offer_id: str(it?.shopSku),
        sku: str(it?.marketSku, 64),
        product_name: str(it?.offerName, 2000),
        quantity: qty(it?.count),
        price: ymItemUnitPrice(it),
        status,
        is_cancelled: cancelled,
        ordered_at: `${day}T12:00:00+03:00`,
        warehouse_name: str(it?.warehouse?.name),
      });
    });
  }
  return mergeLines(lines);
}
