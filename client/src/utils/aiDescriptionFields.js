/** Поля описаний для ИИ (выход) и контекст карточки (вход). */

export const AI_DESCRIPTION_OUTPUT_FIELDS = [
  { key: 'description', label: 'Основное — описание' },
  { key: 'mp_ozon_description', label: 'Ozon — описание' },
  { key: 'mp_wb_description', label: 'Wildberries — описание' },
  { key: 'mp_ym_description', label: 'Яндекс Маркет — описание' },
];

export const AI_DESCRIPTION_OUTPUT_KEYS = AI_DESCRIPTION_OUTPUT_FIELDS.map((f) => f.key);

export const AI_DESCRIPTION_CONTEXT_FIELDS = [
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
];

export const AI_DESCRIPTION_CONTEXT_KEYS = AI_DESCRIPTION_CONTEXT_FIELDS.map((f) => f.key);

const CONTEXT_ALWAYS = new Set(['sku']);

export function filterDraftForAiContext(draft, contextKeys) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const allow = new Set(
    (Array.isArray(contextKeys) ? contextKeys : [])
      .map((k) => String(k || '').trim())
      .filter(Boolean)
  );
  for (const k of CONTEXT_ALWAYS) allow.add(k);
  const out = {};
  for (const k of allow) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      out[k] = src[k] == null ? '' : String(src[k]);
    }
  }
  return out;
}

export function previewAiText(value, limit = 160) {
  const s = String(value || '').trim();
  if (!s) return '—';
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…`;
}

export function formatAiChangesPreview(changes = []) {
  if (!changes?.length) return 'Модель не предложила изменений.';
  return changes
    .map((c) => `• ${c.label || c.field}:\n${previewAiText(c.to, 240)}`)
    .join('\n\n');
}

export const DESCRIPTION_AI_EXAMPLES = [
  'Сделай продающее описание по фактам из карточки, без воды',
  'Перепиши описание короче, сохрани характеристики',
  'Заполни пустые описания для всех выбранных полей',
];
