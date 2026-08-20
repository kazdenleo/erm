/** Ozon: артикул производителя (партномер / OEM), не offer_id продавца. */

export const OZON_PARTNUMBER_ATTR_ID = 7236;

function normalizeOzonAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isOzonManufacturerArticleAttr(attr) {
  if (!attr) return false;
  const id = Number(attr.id ?? attr.attribute_id);
  if (id === OZON_PARTNUMBER_ATTR_ID) return true;
  const n = normalizeOzonAttrName(attr.name);
  if (!n) return false;
  if (n.includes('артикул продавца') || n.includes('offer id') || n.includes('offer_id')) return false;
  if (n.includes('артикул производител') || n.includes('код производител')) return true;
  if (n.includes('партномер') || n.includes('partnumber') || n.includes('part number')) return true;
  if (n === 'oem' || n.startsWith('oem ') || n.includes('oem-номер') || n.includes('oem номер')) return true;
  if (n === 'mpn' || n.includes('manufacturer part')) return true;
  if (n === 'артикул') return true;
  return false;
}

export function findOzonManufacturerArticleAttrs(attrs) {
  return (Array.isArray(attrs) ? attrs : []).filter(isOzonManufacturerArticleAttr);
}
