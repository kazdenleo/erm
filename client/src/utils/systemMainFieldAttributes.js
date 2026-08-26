/**
 * Системные атрибуты полей вкладки «Основное» (метаданные типа / связанных полей).
 * Значения лежат в колонках products.*, не в product_attribute_values.
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

/** @type {Array<{ system_key: string, name: string, type: string, show_related_fields: boolean }>} */
export const SYSTEM_MAIN_FIELD_SEED = [
  { system_key: 'name', name: 'Название', type: 'editable', show_related_fields: true },
  { system_key: 'sku', name: 'Артикул', type: 'text', show_related_fields: false },
  { system_key: 'description', name: 'Описание', type: 'editable', show_related_fields: true },
  { system_key: 'brand', name: 'Бренд', type: 'text', show_related_fields: false },
  { system_key: 'country', name: 'Страна производителя', type: 'text', show_related_fields: false },
  { system_key: 'product_length', name: 'Длина товара', type: 'number', show_related_fields: false },
  { system_key: 'product_width', name: 'Ширина товара', type: 'number', show_related_fields: false },
  { system_key: 'product_height', name: 'Высота товара', type: 'number', show_related_fields: false },
  { system_key: 'product_weight', name: 'Вес товара', type: 'number', show_related_fields: false },
  { system_key: 'length', name: 'Длина упаковки', type: 'number', show_related_fields: false },
  { system_key: 'width', name: 'Ширина упаковки', type: 'number', show_related_fields: false },
  { system_key: 'height', name: 'Высота упаковки', type: 'number', show_related_fields: false },
  { system_key: 'weight', name: 'Вес упаковки', type: 'number', show_related_fields: false },
];

export function isSystemCardAttr(attr) {
  return String(attr?.system_key || '').trim() !== '';
}

export function isSystemMainFieldAttrKey(systemKey) {
  const key = String(systemKey || '').trim();
  return SYSTEM_MAIN_FIELD_KEYS.includes(key);
}

export function isSystemMainFieldAttr(attr) {
  return isSystemMainFieldAttrKey(attr?.system_key);
}

/** Найти системный атрибут поля Main по ключу (name, description, …). */
export function findSystemMainFieldAttr(attributes, systemKey) {
  const key = String(systemKey || '').trim();
  if (!key) return null;
  return (attributes || []).find((a) => String(a?.system_key || '') === key) || null;
}

/**
 * Показывать попап со связанными МП для поля Main (name / description).
 * Если записи ещё нет — для name/description по умолчанию true.
 */
export function mainFieldShowsRelatedFields(attributes, systemKey) {
  const key = String(systemKey || '').trim();
  const attr = findSystemMainFieldAttr(attributes, key);
  if (!attr) {
    return key === 'name' || key === 'description';
  }
  const type = String(attr.type || '').toLowerCase();
  if (type === 'editable') {
    return (
      attr.show_related_fields === true ||
      attr.show_related_fields === 'true' ||
      attr.show_related_fields === 1
    );
  }
  return false;
}
