/**
 * Нормализация телефона клиента для поиска и уникальности в рамках аккаунта.
 * Совпадает с выражением в миграции 218_customers.sql.
 */
export function normalizeCustomerPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) return `7${d.slice(1)}`;
  if (d.length === 10) return `7${d}`;
  return d;
}

/** Цифры из поисковой строки для LIKE по phone_normalized (ведущая 8 отбрасывается). */
export function customerPhoneSearchDigits(search) {
  const d = String(search ?? '').replace(/\D/g, '');
  if (d.length < 3) return '';
  return d.startsWith('8') ? d.slice(1) : d;
}
