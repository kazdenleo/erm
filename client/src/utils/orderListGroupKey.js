/**
 * Ключ группы строки заказа в списке (как на странице «Заказы»).
 * Вынесено из Orders.jsx для переиспользования (дашборд и т.п.).
 */

export function normalizeMarketplaceForUI(marketplace) {
  let mp = String(marketplace || '').toLowerCase();
  if (mp === 'wb') mp = 'wildberries';
  if (mp === 'ym' || mp === 'yandexmarket') mp = 'yandex';
  return mp;
}

/**
 * Ключ группы заказа (Яндекс, ручные, WB по orderUid): всегда строка.
 */
export function orderGroupKey(o) {
  if (!o) return '';
  const raw = o.orderGroupId ?? o.order_group_id;
  if (raw == null) return '';
  const s = String(raw).trim();
  if (s === '') return '';

  const mp = normalizeMarketplaceForUI(o.marketplace);
  if (mp === 'wildberries') {
    const unreliableWbGroupUid =
      /^[a-f0-9]{24,}$/i.test(s) ||
      /^r[a-f0-9]{24,}$/i.test(s) ||
      /^[a-z]{3}[a-f0-9]{24,}$/i.test(s) ||
      /^\d{15,}$/.test(s);
    if (unreliableWbGroupUid) {
      return '';
    }
  }

  return s;
}

/**
 * Ключ строки списка без order_group_id: для Яндекса позиции одного заказа — id и «id:offerId».
 */
export function singleOrderListGroupKey(o) {
  const mp = normalizeMarketplaceForUI(o.marketplace);
  const oid = String(o.orderId ?? '').trim();
  if (!oid) return `single-${mp}-`;
  if (mp === 'yandex') {
    const i = oid.indexOf(':');
    const base = i >= 0 ? oid.slice(0, i) : oid;
    return `single-${mp}-${base}`;
  }
  return `single-${mp}-${oid}`;
}

/**
 * ID заказа для API (детали, резерв): у Яндекса в БД позиции — «номер:offerId», в запрос нужен базовый номер.
 */
export function marketplaceOrderIdForApi(ordersOrId, marketplace) {
  if (ordersOrId != null && typeof ordersOrId === 'object' && !Array.isArray(ordersOrId)) {
    return marketplaceOrderIdForApi(
      ordersOrId.orderId ?? ordersOrId.order_id,
      marketplace ?? ordersOrId.marketplace
    );
  }
  const list = Array.isArray(ordersOrId) ? ordersOrId : null;
  if (list?.length) {
    for (const o of list) {
      const id = marketplaceOrderIdForApi(o?.orderId ?? o?.order_id, marketplace ?? o?.marketplace);
      if (id) return id;
    }
    return '';
  }
  const mp = normalizeMarketplaceForUI(marketplace);
  const oid = String(ordersOrId ?? '').trim();
  if (!oid) return oid;
  if (mp === 'yandex') {
    const i = oid.indexOf(':');
    if (i >= 0) return oid.slice(0, i);
  }
  return oid;
}

/**
 * Сколько заказов (групп списка) в заданных статусах: одна строка таблицы «Заказы» = один счётчик.
 */
export function countOrderGroupsWithStatuses(orders, statuses) {
  const list = Array.isArray(orders) ? orders : [];
  const stSet = statuses instanceof Set ? statuses : new Set(statuses);
  const keys = new Set();
  for (const o of list) {
    const st = String(o?.status ?? '');
    if (!stSet.has(st)) continue;
    const ogk = orderGroupKey(o);
    const gid = ogk || singleOrderListGroupKey(o);
    keys.add(gid);
  }
  return keys.size;
}
