/**
 * Нормализация артикулов маркетплейсов (offer_id / shop SKU).
 * Убирает пробелы и типичный мусор из импорта: «KN1038K;» → «KN1038K».
 */
export function normalizeMarketplaceSku(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^\uFEFF/, '');
  if (!s) return null;
  // Хвостовые разделители из CSV/Excel (точка с запятой, запятая)
  s = s.replace(/[;,]+$/g, '').trim();
  return s || null;
}
