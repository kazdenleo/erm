/** Поля описаний для ИИ (выход) и контекст карточки (вход). */

import { AI_CARD_CONTEXT_FIELDS, AI_CARD_CONTEXT_KEYS, pickContextByKeys } from './aiContextAttributes.js';

export const AI_DESCRIPTION_OUTPUT_FIELDS = [
  { key: 'description', label: 'Основное — описание' },
  { key: 'mp_ozon_description', label: 'Ozon — описание' },
  { key: 'mp_wb_description', label: 'Wildberries — описание' },
  { key: 'mp_ym_description', label: 'Яндекс Маркет — описание' },
];

export const AI_DESCRIPTION_OUTPUT_KEYS = AI_DESCRIPTION_OUTPUT_FIELDS.map((f) => f.key);

export const AI_DESCRIPTION_CONTEXT_FIELDS = AI_CARD_CONTEXT_FIELDS;
export const AI_DESCRIPTION_CONTEXT_KEYS = AI_CARD_CONTEXT_KEYS;

export function filterDraftForAiContext(draft, contextKeys, fieldDefs = AI_DESCRIPTION_CONTEXT_FIELDS) {
  return pickContextByKeys(draft, contextKeys, fieldDefs);
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
