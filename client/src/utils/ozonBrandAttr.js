/** Ozon: «Бренд» (характеристика категории, не отдельное поле mp_ozon_brand). */
export const OZON_BRAND_ATTR_ID = 85;

function normalizeOzonAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isOzonBrandAttr(attr) {
  if (!attr) return false;
  if (Number(attr.id ?? attr.attribute_id) === OZON_BRAND_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (n === 'бренд' || n === 'brand') return true;
  if (n.includes('торговая марк')) return true;
  return false;
}

export function findOzonBrandAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonBrandAttr);
}
