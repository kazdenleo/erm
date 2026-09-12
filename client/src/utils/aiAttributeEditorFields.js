/** Поля для универсального ИИ-редактора атрибутов (editable + связанные МП). */

import { AI_CARD_CONTEXT_FIELDS, AI_CARD_CONTEXT_KEYS, pickContextByKeys, erpAttrEditorKey, parseErpAttrEditorId } from './aiContextAttributes.js';

export { erpAttrEditorKey, parseErpAttrEditorId };

export const DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS = AI_CARD_CONTEXT_FIELDS;
export const DEFAULT_ATTR_EDITOR_CONTEXT_KEYS = AI_CARD_CONTEXT_KEYS;

export function ozonAttrEditorKey(attrId) {
  return `ozon_attr_${attrId}`;
}

export function filterContextForAttrEditor(draft, contextKeys, fieldDefs = DEFAULT_ATTR_EDITOR_CONTEXT_FIELDS) {
  return pickContextByKeys(
    draft,
    Array.isArray(contextKeys) && contextKeys.length ? contextKeys : DEFAULT_ATTR_EDITOR_CONTEXT_KEYS,
    fieldDefs
  );
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
