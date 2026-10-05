/**
 * Номер отправления Ozon для вызовов Seller API: в БД у многопозиционных заказов
 * order_id = "{posting}~{idx}", а posting_number в API — без суффикса.
 */
export function ozonPostingNumberFromOrderId(orderIdRaw) {
  const s = decodeURIComponent(String(orderIdRaw ?? '').trim());
  if (!s) return '';
  const idx = s.indexOf('~');
  return idx > 0 ? s.slice(0, idx) : s;
}

/**
 * Номер заказа Ozon (order_number) из номера отправления:
 * `74369038-0308-1` → `74369038-0308`.
 */
export function ozonOrderNumberFromPostingNumber(postingNumberRaw) {
  const s = String(postingNumberRaw ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(.*)-\d+$/);
  return m && m[1] ? m[1] : '';
}

/**
 * Номер с этикетки Ozon FBS (нижний ШК отправления) — аналог стикера WB.
 * Берём lower_barcode, иначе upper_barcode.
 */
export function ozonStickerNumberFromPosting(posting) {
  if (!posting || typeof posting !== 'object') return null;
  const barcodes = posting.barcodes && typeof posting.barcodes === 'object' ? posting.barcodes : null;
  const lower = barcodes?.lower_barcode ?? barcodes?.lowerBarcode ?? posting.lower_barcode ?? posting.lowerBarcode;
  const upper = barcodes?.upper_barcode ?? barcodes?.upperBarcode ?? posting.upper_barcode ?? posting.upperBarcode;
  const raw = lower != null && String(lower).trim() !== '' ? lower : upper;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

/**
 * Что сохранить в assembly_sticker_number для Ozon:
 * приоритет — ШК этикетки, иначе order_number из ответа API.
 */
export function ozonAssemblyStickerFromPosting(posting) {
  const fromBarcode = ozonStickerNumberFromPosting(posting);
  if (fromBarcode) return fromBarcode;
  const orderNumber =
    posting?.order_number != null
      ? String(posting.order_number).trim()
      : posting?.orderNumber != null
        ? String(posting.orderNumber).trim()
        : '';
  if (orderNumber) return orderNumber;
  const postingNumber =
    posting?.posting_number != null
      ? String(posting.posting_number).trim()
      : posting?.postingNumber != null
        ? String(posting.postingNumber).trim()
        : '';
  return ozonOrderNumberFromPostingNumber(postingNumber) || null;
}
