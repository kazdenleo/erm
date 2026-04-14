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
      /^[a-z]{3}[a-f0-9]{24,}$/i.test(s);
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
