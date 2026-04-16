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
