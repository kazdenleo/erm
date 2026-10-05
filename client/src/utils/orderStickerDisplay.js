import { normalizeMarketplaceForUI } from './orderListGroupKey';

export function isAssemblyLikeStatus(status) {
  const s = String(status ?? '').trim();
  return s === 'in_assembly' || s === 'assembled' || s === 'wb_assembly';
}

/** Колонка «Стикер» в списке заказов — не на «Новый» и не в «В закупке». */
export function shouldShowOrdersStickerColumn(statusFilter) {
  const f = String(statusFilter ?? '').trim();
  return f === 'in_assembly' || f === 'assembled' || f === 'wb_assembly' || f === 'all';
}

function orderIdForSticker(order) {
  return String(
    order?.orderGroupId ??
      order?.order_group_id ??
      order?.orderId ??
      order?.order_id ??
      ''
  ).trim();
}

function stickerNumbersFromOrders(list) {
  return [
    ...new Set(
      list
        .map((o) => String(o.assemblyStickerNumber ?? o.assembly_sticker_number ?? '').trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Номер заказа Ozon (без суффикса отправления): `74369038-0308-1` → `74369038-0308`.
 * На этикетке Ozon обычно крупно этот номер, а в ERP в ID лежит posting_number.
 */
export function ozonOrderNumberFromPostingNumber(postingNumberRaw) {
  const s = String(postingNumberRaw ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(.*)-\d+$/);
  return m && m[1] ? m[1] : '';
}

/**
 * Значение для колонки «Стикер» на сборке/собранных:
 * WB — номер стикера;
 * Ozon — номер отправления + номер с этикетки (ШК) или номер заказа Ozon;
 * Я.Маркет — номер заказа (order_group_id или order_id).
 */
export function orderStickerCellValue(order, { groupOrders = null } = {}) {
  if (!order) return '—';
  if (!isAssemblyLikeStatus(order.status)) return '—';
  const mp = normalizeMarketplaceForUI(order.marketplace);
  const list = Array.isArray(groupOrders) && groupOrders.length ? groupOrders : [order];

  if (mp === 'wildberries') {
    const stickers = stickerNumbersFromOrders(list);
    return stickers.length ? stickers.join(', ') : '—';
  }

  const oid = orderIdForSticker(order);
  if (mp === 'ozon') {
    const stickers = stickerNumbersFromOrders(list).filter((s) => s !== oid);
    const orderNumber = ozonOrderNumberFromPostingNumber(oid);
    const second =
      stickers.length > 0
        ? stickers.join(', ')
        : orderNumber && orderNumber !== oid
          ? orderNumber
          : '';
    if (oid && second) return `${oid} · ${second}`;
    if (second) return second;
    return oid || '—';
  }

  return oid || '—';
}

/** Разбивает номер стикера WB: основная часть + последние 4 цифры (полужирные в UI). */
export function splitStickerEmphasis(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (s.length <= 4) return { prefix: '', suffix: s };
  return { prefix: s.slice(0, -4), suffix: s.slice(-4) };
}

/** Нужно ли выделять последние 4 цифры (только WB-стикеры). */
export function shouldEmphasizeStickerSuffix(order) {
  if (!order) return false;
  return normalizeMarketplaceForUI(order.marketplace) === 'wildberries';
}
