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
 * WB / Ozon — только номер стикера (ШК этикетки), без номера заказа/отправления;
 * Я.Маркет — номер заказа (отдельного стикера нет).
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

  if (mp === 'ozon') {
    const oid = orderIdForSticker(order);
    const orderNumber = ozonOrderNumberFromPostingNumber(oid);
    // Не подставляем posting/order_number: колонка «Стикер» — только номер с этикетки (`ii…`).
    // Чисто цифровые значения — старый barcodes.lower_barcode, на этикетке его нет.
    const stickers = stickerNumbersFromOrders(list).filter(
      (s) => s && s !== oid && s !== orderNumber && !/^\d+$/.test(s)
    );
    return stickers.length ? stickers.join(', ') : '—';
  }

  return orderIdForSticker(order) || '—';
}

/** Заказ Ozon на сборке/собран, но номера с этикетки ещё нет — нужно догрузить через label/status. */
export function ozonStickerMissing(order) {
  if (!order || normalizeMarketplaceForUI(order.marketplace) !== 'ozon') return false;
  return orderStickerCellValue(order) === '—' && isAssemblyLikeStatus(order.status);
}

/**
 * Можно ли собирать заказ: у WB/Ozon должен быть номер стикера (как на сервере в assemblySticker.js).
 * Яндекс и ручные заказы стикера не требуют.
 */
export function orderHasAssemblySticker(order, { groupOrders = null } = {}) {
  if (!order) return false;
  const mp = normalizeMarketplaceForUI(order.marketplace);
  if (mp !== 'wildberries' && mp !== 'ozon') return true;
  return orderStickerCellValue({ ...order, status: 'in_assembly' }, { groupOrders }) !== '—';
}

/** Разбивает номер стикера WB/Ozon: основная часть + последние 4 цифры (полужирные в UI). */
export function splitStickerEmphasis(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (s.length <= 4) return { prefix: '', suffix: s };
  return { prefix: s.slice(0, -4), suffix: s.slice(-4) };
}

/** Нужно ли выделять последние 4 цифры (стикеры WB и Ozon — так же на этикетке). */
export function shouldEmphasizeStickerSuffix(order) {
  if (!order) return false;
  const mp = normalizeMarketplaceForUI(order.marketplace);
  return mp === 'wildberries' || mp === 'ozon';
}
