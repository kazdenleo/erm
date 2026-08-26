/**
 * Системные атрибуты полей вкладки «Основное».
 */

export const SYSTEM_MAIN_FIELD_KEYS = [
  'name',
  'sku',
  'description',
  'brand',
  'country',
  'product_length',
  'product_width',
  'product_height',
  'product_weight',
  'length',
  'width',
  'height',
  'weight',
];

export function isSystemMainFieldAttrKey(systemKey) {
  const key = String(systemKey || '').trim();
  return SYSTEM_MAIN_FIELD_KEYS.includes(key);
}

export function isSystemCardAttrKey(systemKey) {
  const key = String(systemKey || '').trim();
  if (!key) return false;
  if (key === 'price_before_discount' || key === 'price_after_discount') return true;
  return isSystemMainFieldAttrKey(key);
}
