/** Тип ERP-атрибута «Редактируемое поле». */

export const EDITABLE_ATTR_TYPE = 'editable';

export function isEditableAttrType(type) {
  return String(type || '').toLowerCase() === EDITABLE_ATTR_TYPE;
}

export function normalizeShowRelatedFields(type, value) {
  if (!isEditableAttrType(type)) return false;
  return value === true || value === 'true' || value === 1 || value === '1';
}
