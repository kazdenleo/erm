/** Ozon: «Аннотация» (характеристика категории, id 4191). «Название» — id 4180. */

export const OZON_NAME_ATTR_ID = 4180;
export const OZON_ANNOTATION_ATTR_ID = 4191;

function normalizeOzonAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «Название» карточки, не модели/группы/файла/видео. */
export function isOzonNameAttr(attr) {
  if (!attr) return false;
  if (Number(attr.id ?? attr.attribute_id) === OZON_NAME_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (n === 'название') return true;
  if (
    n.startsWith('название') &&
    !n.includes('модели') &&
    !n.includes('группы') &&
    !n.includes('файла') &&
    !n.includes('видео')
  ) {
    return true;
  }
  return false;
}

export function isOzonAnnotationAttr(attr) {
  if (!attr) return false;
  if (Number(attr.id ?? attr.attribute_id) === OZON_ANNOTATION_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (n.includes('аннотация')) return true;
  if (n.includes('описание') && n.includes('маркетинг')) return true;
  return false;
}

/** Текст аннотации в форме: U+2028, <br> и прежний « · » → обычные переносы строк. */
export function ozonAnnotationToFormText(text) {
  return String(text ?? '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/\u2028|\u2029/g, '\n')
    .replace(/\s*·\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Дубль карточного описания Ozon: в UI не показываем, текст уходит в «Аннотация». */
export function isOzonPlainDescriptionAttr(attr) {
  if (!attr || isOzonAnnotationAttr(attr)) return false;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (n === 'описание' || n === 'описание товара' || n === 'описание карточки' || n === 'description') {
    return true;
  }
  if (
    n.startsWith('описание') &&
    !n.includes('модел') &&
    !n.includes('комплект') &&
    !n.includes('состава') &&
    !n.includes('rich')
  ) {
    return true;
  }
  return false;
}

export function findOzonNameAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonNameAttr);
}

export function findOzonAnnotationAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonAnnotationAttr);
}

export function findOzonPlainDescriptionAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonPlainDescriptionAttr);
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** «текст->0»: Ozon отдал значение без id словаря — в форме и при сохранении оставляем текст. */
export function stripOzonZeroDictArrow(s) {
  return String(s ?? '')
    .replace(/->0(?=\s*(;|$))/g, '')
    .replace(/\s*;\s*;/g, ';')
    .replace(/^\s*;\s*|\s*;\s*$/g, '')
    .trim();
}

function isOzonRealDictId(id) {
  const t = String(id ?? '').trim();
  return t !== '' && t !== '0' && /^\d+$/.test(t);
}

/** Текст характеристики Ozon из строки, `{value}`, `{values:[{value}]}`. */
export function ozonAttrPlainText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const s = String(raw).trim();
    return s === '[object Object]' ? '' : stripOzonZeroDictArrow(s);
  }
  if (Array.isArray(raw)) {
    return raw.map(ozonAttrPlainText).filter(Boolean).join('; ');
  }
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.values) && raw.values.length) {
      return raw.values.map(ozonAttrPlainText).filter(Boolean).join('; ');
    }
    const nested = raw.value ?? (isOzonRealDictId(raw.dictionary_value_id) ? raw.dictionary_value_id : null) ?? raw.id ?? raw.name ?? raw.text;
    if (nested && typeof nested === 'object') return ozonAttrPlainText(nested);
    return ozonAttrPlainText(nested);
  }
  return stripOzonZeroDictArrow(String(raw).trim());
}

/**
 * Значение для поля формы: для словаря предпочитаем dictionary_value_id,
 * иначе тот же текст, что ozonAttrPlainText.
 */
export function ozonStoredAttrToFormValue(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const s = String(raw).trim();
    return s === '[object Object]' ? '' : stripOzonZeroDictArrow(s);
  }
  if (Array.isArray(raw)) {
    return raw.map(ozonStoredAttrToFormValue).filter(Boolean).join('; ');
  }
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.values) && raw.values.length) {
      return raw.values.map(ozonStoredAttrToFormValue).filter(Boolean).join('; ');
    }
    const dict = raw.dictionary_value_id ?? (raw.id != null && raw.value == null ? raw.id : null);
    if (isOzonRealDictId(dict)) return String(dict).trim();
    if (raw.value != null && typeof raw.value === 'object') return ozonStoredAttrToFormValue(raw.value);
    if (raw.value != null) return stripOzonZeroDictArrow(String(raw.value).trim());
    return ozonAttrPlainText(raw);
  }
  return stripOzonZeroDictArrow(String(raw).trim());
}

/** Первый непустой текст по списку атрибутов схемы и запасным ключам. */
export function pickOzonCardText(values, attrList, extraKeys = []) {
  const src = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const keys = [
    ...(Array.isArray(attrList) ? attrList.map((a) => String(a?.id ?? a?.attribute_id ?? '')) : []),
    ...extraKeys.map((k) => String(k)),
  ].filter(Boolean);
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const t = ozonAttrPlainText(src[key] ?? src[Number(key)]);
    if (t) return t;
  }
  return '';
}
