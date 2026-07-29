/**
 * Связь полей ERP ↔ маркетплейсы (серверная копия логики client/src/utils/productMpFieldLinks.js).
 * ERP: мм / г; Ozon: мм / г; WB: см / г; YM: см / кг.
 */

export const MP_FIELD_LINK_KEYS = ['name', 'sku', 'description', 'brand', 'country', 'dimensions'];

export const MP_FIELD_LINK_SUPPORT = {
  name: ['ozon', 'wb', 'ym'],
  sku: ['ozon', 'wb', 'ym'],
  description: ['ozon', 'wb', 'ym'],
  brand: ['ozon', 'wb'],
  country: ['ozon', 'wb', 'ym'],
  dimensions: ['ozon', 'wb', 'ym'],
};

export function defaultMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [...(MP_FIELD_LINK_SUPPORT[key] || [])];
  }
  return out;
}

export function normalizeMpFieldLinks(raw) {
  const defaults = defaultMpFieldLinks();
  if (raw == null || raw === '') return defaults;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return defaults;
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return defaults;

  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    const supported = MP_FIELD_LINK_SUPPORT[key] || [];
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      out[key] = [...supported];
      continue;
    }
    const v = obj[key];
    if (Array.isArray(v)) {
      out[key] = v
        .map((x) => String(x || '').toLowerCase())
        .filter((m) => supported.includes(m));
    } else if (v && typeof v === 'object') {
      out[key] = supported.filter((m) => !!v[m]);
    } else {
      out[key] = [];
    }
  }
  return out;
}

export function isMpFieldLinked(links, fieldKey, mp) {
  const list = links?.[fieldKey];
  if (!Array.isArray(list)) return false;
  return list.includes(String(mp || '').toLowerCase());
}

export function mmToCm(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n / 10));
}

export function gramsToKg(g) {
  const n = Number(g);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 1000) * 1000) / 1000;
}

export function cmToMm(cm) {
  const n = Number(cm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * 10));
}

export function kgToGrams(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * 1000));
}

/** YM weightDimensions (см / кг) → ERP (мм / г). */
export function ymWeightDimensionsToErp(wd) {
  if (!wd || typeof wd !== 'object') return null;
  const length = cmToMm(wd.length);
  const width = cmToMm(wd.width);
  const height = cmToMm(wd.height);
  const weight = kgToGrams(wd.weight);
  const out = {};
  if (length != null) out.length = length;
  if (width != null) out.width = width;
  if (height != null) out.height = height;
  if (weight != null) out.weight = weight;
  return Object.keys(out).length ? out : null;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Значение текстового поля для push с учётом связи.
 * Без связи — только mp_* (без подстановки из «Основное»).
 */
export function resolveCardTextForPush(product, mp, fieldKey) {
  const links = normalizeMpFieldLinks(product?.mp_field_links);
  const linked = isMpFieldLinked(links, fieldKey, mp);

  if (fieldKey === 'name') {
    if (linked) return trimOrNull(product.name);
    if (mp === 'ozon') return trimOrNull(product.mp_ozon_name);
    if (mp === 'wb') return trimOrNull(product.mp_wb_name);
    if (mp === 'ym') return trimOrNull(product.mp_ym_name);
  }
  if (fieldKey === 'description') {
    if (linked) return trimOrNull(product.description);
    if (mp === 'ozon') return trimOrNull(product.mp_ozon_description);
    if (mp === 'wb') return trimOrNull(product.mp_wb_description);
    if (mp === 'ym') return trimOrNull(product.mp_ym_description);
  }
  if (fieldKey === 'brand') {
    if (linked) return trimOrNull(product.brand);
    if (mp === 'ozon') return trimOrNull(product.mp_ozon_brand);
    if (mp === 'wb') return trimOrNull(product.mp_wb_brand);
  }
  if (fieldKey === 'sku') {
    if (linked) return trimOrNull(product.sku);
    if (mp === 'ozon') return trimOrNull(product.sku_ozon);
    if (mp === 'wb') return trimOrNull(product.mp_wb_vendor_code);
    if (mp === 'ym') return trimOrNull(product.sku_ym);
  }
  if (fieldKey === 'country') {
    if (linked) return trimOrNull(product.country_of_origin);
    return null;
  }
  return null;
}

export function shouldPushDimensions(product, mp) {
  const links = normalizeMpFieldLinks(product?.mp_field_links);
  return isMpFieldLinked(links, 'dimensions', mp);
}
