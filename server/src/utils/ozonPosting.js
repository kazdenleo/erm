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
 * Номер, напечатанный на этикетке Ozon FBS (`ii50048401925`) — аналог стикера WB.
 * Приходит только в v3/posting/fbs/get (поле scanit); barcodes.lower/upper_barcode
 * на этикетке не печатаются и стикером не являются.
 */
export function ozonStickerNumberFromPosting(posting) {
  if (!posting || typeof posting !== 'object') return null;
  const raw = posting.scanit ?? posting.scanIt ?? null;
  if (raw == null) return null;
  const s = String(raw).trim();
  return isOzonLabelStickerNumber(s) ? s : null;
}

/** Ранее в стикер Ozon сохранялся числовой barcodes.lower_barcode — такие значения считаем отсутствующими. */
export function isOzonLabelStickerNumber(value) {
  const s = String(value ?? '').trim();
  return s !== '' && !/^\d+$/.test(s);
}

/**
 * Что сохранить в assembly_sticker_number для Ozon:
 * только ШК этикетки. Номер заказа/отправления — в колонке заказа, не в стикере.
 */
export function ozonAssemblyStickerFromPosting(posting) {
  return ozonStickerNumberFromPosting(posting);
}
