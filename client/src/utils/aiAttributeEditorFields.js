/** Поля для универсального ИИ-редактора атрибутов (editable + связанные МП). */

export const DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS = [
  { key: 'name', label: 'Название' },
  { key: 'sku', label: 'Артикул' },
  { key: 'brand', label: 'Бренд' },
  { key: 'description', label: 'Описание' },
  { key: 'category_name', label: 'Категория' },
  { key: 'country_of_origin', label: 'Страна' },
];

export const DEFAULT_ATTR_EDITOR_CONTEXT_KEYS = DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS.map((f) => f.key);

export function erpAttrEditorKey(attrId) {
  return `erp_attr_${attrId}`;
}

export function ozonAttrEditorKey(attrId) {
  return `ozon_attr_${attrId}`;
}

export function filterContextForAttrEditor(draft, contextKeys) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const allow = new Set(
    (Array.isArray(contextKeys) ? contextKeys : DEFAULT_ATTR_EDITOR_CONTEXT_KEYS).map((k) =>
      String(k || '').trim()
    )
  );
  allow.add('sku');
  const out = {};
  for (const k of allow) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      out[k] = src[k] == null ? '' : String(src[k]);
    }
  }
  return out;
}

export function formatAttrEditorChangesPreview(changes = []) {
  if (!changes?.length) return 'Модель не предложила изменений.';
  return changes
    .map((c) => `• ${c.label || c.field}:\n${String(c.to || '').slice(0, 400)}`)
    .join('\n\n');
}

export const APPLICABILITY_AI_EXAMPLES = [
  'Заполни применимость по OEM и названию товара',
  'Добавь автомобили из текста применимости в таблицу Ozon',
  'Сверь применимость с описанием и брендом',
];
