/**
 * После отказа / частичного приёма поставщика: какие позиции пробовать у следующего,
 * и когда заказ уже нечем закрыть.
 */

import { supplierSubmitNeedsRollback } from './supplierSubmitRollback.js';

/** Можно ли сразу пробовать другого поставщика (не таймаут «может уже в корзине»). */
export function shouldFailoverAfterSupplierSubmit(supplierSubmit, { apiSubmitRequired = true } = {}) {
  if (!apiSubmitRequired) return false;
  if (!supplierSubmit || supplierSubmit.skipped) return false;
  if (supplierSubmit.ambiguousSuccess) return false;
  if (supplierSubmit.reason === 'already_submitted') return false;
  return supplierSubmitNeedsRollback(supplierSubmit, { apiSubmitRequired: true });
}

/**
 * Позиции батча, которые нужно перезаказать у другого поставщика.
 * @param {Array<{ productId?: number, product_id?: number, quantity?: number, sourceOrders?: unknown[] }>} items
 * @param {object|null} supplierSubmit
 */
export function rollbackDemandItemsForFailover(items, supplierSubmit) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const failed = Array.isArray(supplierSubmit?.failedLines) ? supplierSubmit.failedLines : [];
  if (failed.length > 0) {
    const failedIds = new Set(
      failed.map((l) => Number(l.productId ?? l.product_id)).filter((id) => Number.isFinite(id) && id > 0)
    );
    return list.filter((it) => failedIds.has(Number(it.productId ?? it.product_id)));
  }

  if (Array.isArray(supplierSubmit?.lines) && supplierSubmit.lines.length > 0) {
    return [];
  }

  return list;
}

/** Уникальные ссылки на заказы из demand-линий. */
export function sourceOrderRefsFromDemandItems(items) {
  const map = new Map();
  for (const it of items || []) {
    for (const o of it?.sourceOrders || []) {
      const mp = String(o?.marketplace || '').toLowerCase();
      const marketplace =
        mp === 'wb' || mp === 'wildberries'
          ? 'wb'
          : mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket'
            ? 'ym'
            : mp === 'manual'
              ? 'manual'
              : 'ozon';
      const orderId = String(o?.orderId ?? o?.order_id ?? '').trim();
      if (!orderId) continue;
      map.set(`${marketplace}|${orderId}`, { marketplace, orderId });
    }
  }
  return [...map.values()];
}

/**
 * Заказы, у которых после исчерпания поставщиков не осталось ни одной закрытой позиции.
 * (Если по заказу часть позиций уже принята другим поставщиком — в список не попадает.)
 */
export function unfulfillableOrderRefs(failedItems, coveredOrderKeys = new Set()) {
  const refs = sourceOrderRefsFromDemandItems(failedItems);
  return refs.filter((r) => !coveredOrderKeys.has(`${r.marketplace}|${r.orderId}`));
}

export function orderRefKey(marketplace, orderId) {
  const mp = String(marketplace || '').toLowerCase();
  const normalized =
    mp === 'wb' || mp === 'wildberries'
      ? 'wb'
      : mp === 'ym' || mp === 'yandex' || mp === 'yandexmarket'
        ? 'ym'
        : mp === 'manual'
          ? 'manual'
          : 'ozon';
  return `${normalized}|${String(orderId || '').trim()}`;
}
