/**
 * Ozon в author_name часто отдаёт заглушки вместо имени покупателя.
 * Реальное имя в Seller API по вопросам обычно недоступно.
 */
function isOzonGenericBuyerName(name) {
  const s = String(name ?? '').trim();
  if (!s) return true;
  const lower = s.toLowerCase().replace(/\s+/g, ' ');
  if (lower === 'пользователь ozon' || lower === 'пользователь озон') return true;
  if (lower.includes('пользователь') && (lower.includes('ozon') || lower.includes('озон'))) return true;
  if (lower.includes('скрыть') && lower.includes('данн')) return true;
  if (lower === 'покупатель' || lower === 'buyer' || lower === 'anonymous') return true;
  return false;
}

/**
 * @param {string|null|undefined} name
 * @param {string|null|undefined} marketplace
 * @returns {string|null}
 */
export function sanitizeMarketplaceBuyerName(name, marketplace) {
  const s = name != null ? String(name).trim() : '';
  if (!s) return null;
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'ozon' && isOzonGenericBuyerName(s)) return null;
  return s;
}
