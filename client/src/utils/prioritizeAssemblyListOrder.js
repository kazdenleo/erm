/**
 * Первый скан без сессии: заказ с левой карточки («Следующий») идёт первым в listOrder,
 * иначе общий SKU (A в A+B и A+C) может открыть следующий комплект из таблицы.
 */

function listOrderKey(marketplace, orderId) {
  const mp = String(marketplace ?? '').trim().toLowerCase();
  const oid = String(orderId ?? '').trim();
  if (!mp || !oid) return '';
  return `${mp}|${oid}`;
}

/**
 * @param {Array<{ marketplace?: string, orderId?: string, order_id?: string }>|null|undefined} listOrder
 * @param {{ rows?: object[] }|null|undefined} headGroup — stage.currentGroup с левой карточки
 * @returns {Array<{ marketplace: string, orderId: string }>}
 */
export function prioritizeAssemblyListOrder(listOrder, headGroup) {
  const base = Array.isArray(listOrder) ? listOrder : [];
  if (!headGroup?.rows?.length) return base;
  const headEntries = [];
  const headKeys = new Set();
  for (const o of headGroup.rows) {
    const orderId = String(o.orderId ?? o.order_id ?? '').trim();
    const marketplace = o.marketplace;
    const key = listOrderKey(marketplace, orderId);
    if (!key || headKeys.has(key)) continue;
    headKeys.add(key);
    headEntries.push({ marketplace, orderId });
  }
  if (!headEntries.length) return base;
  const rest = base.filter((e) => {
    const key = listOrderKey(e?.marketplace, e?.orderId ?? e?.order_id);
    return !key || !headKeys.has(key);
  });
  return [...headEntries, ...rest];
}
