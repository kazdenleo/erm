/** Тип ERP-атрибута «Редактируемое поле» (длинный текст + опционально связанные МП). */

export const EDITABLE_ATTR_TYPE = 'editable';

export function isEditableAttrType(type) {
  return String(type || '').toLowerCase() === EDITABLE_ATTR_TYPE;
}

/** Показывать попап со связанными полями МП (как «Название» / «Описание»). */
export function attrShowsRelatedFields(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (!isEditableAttrType(attr.type)) return false;
  return (
    attr.show_related_fields === true ||
    attr.show_related_fields === 'true' ||
    attr.show_related_fields === 1 ||
    attr.showRelatedFields === true
  );
}

/** ИИ-чат в попапе редактора (контекст из других полей карточки). */
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
