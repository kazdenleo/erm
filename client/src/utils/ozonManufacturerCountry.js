/** Ozon: «Страна-изготовитель» (характеристика категории, не ozon_draft.country). */
export const OZON_MANUFACTURER_COUNTRY_ATTR_ID = 4389;

function normalizeOzonAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isOzonManufacturerCountryAttr(attr) {
  if (!attr) return false;
  if (Number(attr.id ?? attr.attribute_id) === OZON_MANUFACTURER_COUNTRY_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  return n === 'страна-изготовитель' || n === 'страна изготовитель' || /^страна[-\s]изготовител/.test(n);
}

export function findOzonManufacturerCountryAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonManufacturerCountryAttr);
}

function dictEntryText(o) {
  if (!o || typeof o !== 'object') return '';
  return String(o.value ?? o.info ?? o.title ?? o.name ?? o.label ?? '').trim();
}

/** Текст страны → id справочника Ozon, иначе исходная строка. */
export function resolveOzonCountryDictValue(text, dict) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (!Array.isArray(dict) || dict.length === 0) return t;
  const byId = dict.find((o) => o && String(o.id) === t);
  if (byId?.id != null) return String(byId.id);
  const norm = normalizeOzonAttrName(t);
  const exact = dict.find((o) => normalizeOzonAttrName(dictEntryText(o)) === norm);
  if (exact?.id != null) return String(exact.id);
  const partial = dict.find((o) => {
    const x = normalizeOzonAttrName(dictEntryText(o));
    return x && (x.includes(norm) || (norm.length >= 3 && norm.includes(x)));
  });
  if (partial?.id != null) return String(partial.id);
  return t;
}

export function displayOzonCountryValue(raw, dict) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  if (!Array.isArray(dict) || dict.length === 0) return t;
  const hit =
    dict.find((o) => o && String(o.id) === t) ||
    dict.find((o) => normalizeOzonAttrName(dictEntryText(o)) === normalizeOzonAttrName(t));
  return hit ? dictEntryText(hit) || t : t;
}
