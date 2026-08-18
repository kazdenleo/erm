/** Ozon: «Аннотация» (характеристика категории, id 4191). «Название» — по подписи схемы. */

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

export function findOzonNameAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonNameAttr);
}

export function findOzonAnnotationAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonAnnotationAttr);
}

export function ozonAttrPlainText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const v = raw.value ?? raw.dictionary_value_id ?? raw.id ?? raw.name;
    return String(v ?? '').trim();
  }
  return String(raw).trim();
}
