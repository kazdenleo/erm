/** Тип ERP-атрибута «Редактируемое поле». */

export const EDITABLE_ATTR_TYPE = 'editable';

export function isEditableAttrType(type) {
  return String(type || '').toLowerCase() === EDITABLE_ATTR_TYPE;
}

export function normalizeShowRelatedFields(type, value) {
  if (!isEditableAttrType(type)) return false;
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function normalizeAiChatEnabled(type, value) {
  if (!isEditableAttrType(type)) return false;
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function attrAiChatEnabled(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (!isEditableAttrType(attr.type)) return false;
  return (
    attr.ai_chat_enabled === true ||
    attr.ai_chat_enabled === 'true' ||
    attr.ai_chat_enabled === 1 ||
    attr.aiChatEnabled === true
  );
}
