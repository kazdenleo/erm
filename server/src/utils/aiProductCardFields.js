/** Поля карточки, которые ИИ может предлагать (только текст, без записи в БД). */

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
export const AI_CARD_FIELD_MAX = Object.fromEntries(AI_CARD_FIELDS.map((f) => [f.key, f.max]));
export const AI_CARD_FIELD_LABEL = Object.fromEntries(AI_CARD_FIELDS.map((f) => [f.key, f.label]));

export const MAX_BULK_AI_CARDS = 8;

export function normalizeAiCardFields(keys) {
  const allow = new Set(AI_CARD_FIELD_KEYS);
  const list = (Array.isArray(keys) ? keys : [])
    .map((k) => String(k || '').trim())
    .filter((k) => allow.has(k));
  return list.length ? [...new Set(list)] : [...AI_CARD_FIELD_KEYS];
}

/** Запрос явно просит переписать текст, а не только дырки. */
export function instructionAllowsOverwrite(instruction) {
  const t = String(instruction || '').toLowerCase();
  if (!t.trim()) return false;
  const mentionsEmpty = /пуст/.test(t);
  const wantsRewrite = /перепиш|сделай|продающ|улучш|сократи|перефразир|заполни названия|заполни описан/.test(t);
  if (mentionsEmpty && !wantsRewrite) return false;
  return wantsRewrite;
}
