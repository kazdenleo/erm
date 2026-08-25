/** Ozon: артикул производителя (партномер), не offer_id продавца и не отдельное поле OEM. */

export const OZON_PARTNUMBER_ATTR_ID = 7236;

function normalizeOzonAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Отдельная характеристика/атрибут OEM — не то же самое, что Ozon 7236. */
export function isStandaloneOemAttrName(name) {
  const n = normalizeOzonAttrName(name);
  if (!n) return false;
  if (n === 'oem' || n === 'оем') return true;
  if (n.startsWith('oem ') || n.startsWith('оем ')) return true;
  if (n.includes('oem-номер') || n.includes('oem номер') || n.includes('оем-номер') || n.includes('оем номер')) {
    return true;
  }
  return false;
}

export function isOzonManufacturerArticleAttr(attr) {
  if (!attr) return false;
  const id = Number(attr.id ?? attr.attribute_id);
  if (id === OZON_PARTNUMBER_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (isStandaloneOemAttrName(n)) return false;
  if (n.includes('артикул продавца') || n.includes('offer id') || n.includes('offer_id')) return false;
  if (n.includes('артикул производител') || n.includes('код производител')) return true;
  if (n.includes('партномер') || n.includes('partnumber') || n.includes('part number')) return true;
  if (n === 'mpn' || n.includes('manufacturer part')) return true;
  return false;
}

export function findOzonManufacturerArticleAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonManufacturerArticleAttr);
}
