import { collectAttributeContextValues } from './aiContextAttributes.js';

/** Поля карточки, которые ИИ может предлагать (совпадает с сервером). */

export const AI_CARD_FIELDS = [
  { key: 'name', label: 'Название', max: 500 },
  { key: 'description', label: 'Описание', max: 8000 },
  { key: 'mp_ozon_name', label: 'Ozon — название', max: 255 },
  { key: 'mp_ozon_description', label: 'Ozon — описание', max: 6000 },
  { key: 'mp_wb_name', label: 'Wildberries — название', max: 255 },
  { key: 'mp_wb_description', label: 'Wildberries — описание', max: 6000 },
  { key: 'mp_ym_name', label: 'Яндекс Маркет — название', max: 255 },
  { key: 'mp_ym_description', label: 'Яндекс Маркет — описание', max: 6000 },
];

export const AI_CARD_FIELD_KEYS = AI_CARD_FIELDS.map((f) => f.key);
export const AI_CARD_FIELD_LABEL = Object.fromEntries(AI_CARD_FIELDS.map((f) => [f.key, f.label]));
export const MAX_BULK_AI_CARDS = 8;

/** Запрос явно просит переписать текст, а не только дырки. */
export function instructionAllowsOverwrite(instruction) {
  const t = String(instruction || '').toLowerCase();
  if (!t.trim()) return false;
  const mentionsEmpty = /пуст/.test(t);
  const wantsRewrite = /перепиш|сделай|продающ|улучш|сократи|перефразир|заполни названия|заполни описан/.test(t);
  if (mentionsEmpty && !wantsRewrite) return false;
  return wantsRewrite;
}

export function snapshotAiCardFields(src) {
  const out = {};
  for (const { key } of AI_CARD_FIELDS) {
    const v = src?.[key];
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

/** Снимок для GigaChat: поля карточки, габариты и значения ERP-атрибутов. */
export function snapshotAiCardDraft(src, extra = {}) {
  const dim = (key) => {
    const v = src?.[key];
    return v == null ? '' : String(v);
  };
  return {
    ...snapshotAiCardFields(src),
    sku: src?.sku == null ? '' : String(src.sku),
    brand: src?.brand == null ? '' : String(src.brand),
    country_of_origin: src?.country_of_origin == null ? '' : String(src.country_of_origin),
    category_name: extra.categoryName || src?.category_name || src?.categoryName || '',
    product_length: dim('product_length'),
    product_width: dim('product_width'),
    product_height: dim('product_height'),
    product_weight: dim('product_weight'),
    length: dim('length'),
    width: dim('width'),
    height: dim('height'),
    weight: dim('weight'),
    ...collectAttributeContextValues(src, extra),
  };
}
