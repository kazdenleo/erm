export function erpAttrEditorKey(attrId) {
  return `erp_attr_${attrId}`;
}

/** Базовые поля карточки и МП — всегда в списке «учитывать». */
export const AI_CARD_CONTEXT_FIELDS = [
  { key: 'name', label: 'Название' },
  { key: 'brand', label: 'Бренд' },
  { key: 'sku', label: 'Артикул' },
  { key: 'category_name', label: 'Категория' },
  { key: 'country_of_origin', label: 'Страна' },
  { key: 'description', label: 'Текущее описание' },
  { key: 'mp_ozon_name', label: 'Ozon — название' },
  { key: 'mp_ozon_description', label: 'Ozon — описание' },
  { key: 'mp_wb_name', label: 'Wildberries — название' },
  { key: 'mp_wb_description', label: 'Wildberries — описание' },
  { key: 'mp_ym_name', label: 'Яндекс Маркет — название' },
  { key: 'mp_ym_description', label: 'Яндекс Маркет — описание' },
  { key: 'product_length', label: 'Длина товара' },
  { key: 'product_width', label: 'Ширина товара' },
  { key: 'product_height', label: 'Высота товара' },
  { key: 'product_weight', label: 'Вес товара' },
  { key: 'length', label: 'Длина упаковки' },
  { key: 'width', label: 'Ширина упаковки' },
  { key: 'height', label: 'Высота упаковки' },
  { key: 'weight', label: 'Вес упаковки' },
];

export const AI_CARD_CONTEXT_KEYS = AI_CARD_CONTEXT_FIELDS.map((f) => f.key);

const SYSTEM_KEY_TO_DRAFT = {
  name: 'name',
  sku: 'sku',
  description: 'description',
  brand: 'brand',
  country: 'country_of_origin',
  product_length: 'product_length',
  product_width: 'product_width',
  product_height: 'product_height',
  product_weight: 'product_weight',
  length: 'length',
  width: 'width',
  height: 'height',
  weight: 'weight',
};

const ERP_ROW_PREFIX = '__erpAttr__';

export function stringifyAiContextValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(stringifyAiContextValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

export function aiContextKeyForAttribute(attr) {
  const sk = String(attr?.system_key || '').trim();
  if (sk && SYSTEM_KEY_TO_DRAFT[sk]) return SYSTEM_KEY_TO_DRAFT[sk];
  const id = attr?.id;
  if (id == null || String(id).trim() === '') return '';
  return erpAttrEditorKey(id);
}

/** Список полей контекста: карточка + все ERP-атрибуты. */
export function buildAiContextFieldDefs(attributes = []) {
  const seen = new Set();
  const out = [];
  const add = (key, label) => {
    const k = String(key || '').trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, label: String(label || k).trim() || k });
  };
  for (const f of AI_CARD_CONTEXT_FIELDS) add(f.key, f.label);
  const attrs = [...(attributes || [])].sort((a, b) =>
    String(a?.name || '').localeCompare(String(b?.name || ''), 'ru')
  );
  for (const attr of attrs) {
    const key = aiContextKeyForAttribute(attr);
    if (!key) continue;
    add(key, attr.name || key);
  }
  return out;
}

export function contextFieldLabels(defs = []) {
  return Object.fromEntries((defs || []).map((f) => [f.key, f.label || f.key]));
}

/** Значения атрибутов из карточки / строки массового редактирования. */
export function collectAttributeContextValues(src = {}, extra = {}) {
  const out = {};
  const values = extra.attributeValues || src.attributeValues || src.attribute_values || {};
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    for (const [id, val] of Object.entries(values)) {
      out[erpAttrEditorKey(id)] = stringifyAiContextValue(val);
    }
  }
  for (const [k, v] of Object.entries(src || {})) {
    if (!String(k).startsWith(ERP_ROW_PREFIX)) continue;
    const id = String(k).slice(ERP_ROW_PREFIX.length);
    if (!id) continue;
    out[erpAttrEditorKey(id)] = stringifyAiContextValue(v);
  }
  return out;
}

export function pickContextByKeys(draft, contextKeys, fieldDefs = []) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const labels = contextFieldLabels(fieldDefs);
  const allow = [];
  const seen = new Set();
  for (const k of Array.isArray(contextKeys) ? contextKeys : []) {
    const key = String(k || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    allow.push(key);
  }
  if (!seen.has('sku')) allow.unshift('sku');
  const usedLabels = new Set();
  const out = {};
  for (const key of allow) {
    let label = labels[key] || key;
    if (usedLabels.has(label)) label = `${label} (${key})`;
    usedLabels.add(label);
    const raw = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : '';
    out[label] = stringifyAiContextValue(raw);
  }
  return out;
}
