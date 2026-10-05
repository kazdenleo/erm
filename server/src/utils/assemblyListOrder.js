/**
 * Порядок заказов в таблице «Сборка» (как видит сборщик) — для выбора заказа при скане.
 */

const MP_ALIASES = {
  wildberries: 'wb',
  yandex: 'ym',
  yandexmarket: 'ym',
};

export function assemblyListOrderKey(marketplace, orderId) {
  const raw = String(marketplace ?? '').trim().toLowerCase();
  const mp = MP_ALIASES[raw] || raw;
  const oid = String(orderId ?? '').trim();
  if (!mp || !oid) return '';
  return `${mp}|${oid}`;
}

/** listOrder: [{ marketplace, orderId }] → Map(key → позиция в списке). */
export function assemblyListOrderIndex(listOrder) {
  const index = new Map();
  if (!Array.isArray(listOrder)) return index;
  listOrder.forEach((entry, pos) => {
    const key = assemblyListOrderKey(entry?.marketplace, entry?.orderId ?? entry?.order_id);
    if (key && !index.has(key)) index.set(key, pos);
  });
  return index;
}

/**
 * Первый кандидат по порядку списка. Заказы, которых нет в списке (список устарел),
 * идут после всех перечисленных в исходном порядке кандидатов.
 */
export function pickFirstByAssemblyListOrder(candidates, index) {
  let best = null;
  let bestPos = Infinity;
  for (const order of candidates || []) {
    if (!order) continue;
    const key = assemblyListOrderKey(order.marketplace, order.orderId ?? order.order_id);
    const pos = index.has(key) ? index.get(key) : Infinity;
    if (best == null || pos < bestPos) {
      best = order;
      bestPos = pos;
    }
  }
  return best;
}
