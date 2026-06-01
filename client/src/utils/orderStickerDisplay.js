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

/**
 * Значение для колонки «Стикер» на сборке/собранных:
 * WB — номер стикера; Ozon и Я.Маркет — номер заказа (order_group_id или order_id).
 */
export function orderStickerCellValue(order, { groupOrders = null } = {}) {
  if (!order) return '—';
  if (!isAssemblyLikeStatus(order.status)) return '—';
  const mp = normalizeMarketplaceForUI(order.marketplace);
  if (mp === 'wildberries') {
    const list = Array.isArray(groupOrders) && groupOrders.length ? groupOrders : [order];
    const stickers = [
      ...new Set(
        list
          .map((o) => String(o.assemblyStickerNumber ?? o.assembly_sticker_number ?? '').trim())
          .filter(Boolean)
      ),
    ];
    return stickers.length ? stickers.join(', ') : '—';
  }
  const oid =
    order.orderGroupId ??
    order.order_group_id ??
    order.orderId ??
    order.order_id ??
    '';
  return String(oid).trim() || '—';
}
