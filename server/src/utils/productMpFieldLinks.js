/**
 * Связь полей ERP ↔ маркетплейсы (серверная копия логики client/src/utils/productMpFieldLinks.js).
 * ERP: мм / г; Ozon: мм / г; WB: см / кг (weightBrutto); YM: см / кг.
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

export function emptyMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [];
  }
  return out;
}

/** Все связи вкл. — только при создании новой карточки. */
export function createMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [...(MP_FIELD_LINK_SUPPORT[key] || [])];
  }
  return out;
}

export function defaultMpFieldLinks() {
  return emptyMpFieldLinks();
}

export function normalizeMpFieldLinks(raw) {
  const defaults = emptyMpFieldLinks();
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
      out[key] = [];
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

/**
 * YM-параметры категории, которые уже редактируются отдельными полями ERP/оффера.
 */
export function isYmParamDuplicatingDedicatedField(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!n) return false;
  if (/^(длина|ширина|высота)\s+(упаковк|товара\s+в\s+упаковк)/.test(n)) return true;
  if (/^вес\s+(с\s+)?упаковк/.test(n)) return true;
  if (/^вес\s+товара\s+с\s+упаковк/.test(n)) return true;
  if (/^габарит(ы|ы\s+упаковк)/.test(n)) return true;
  if (/страна\s+(производства|изготовления|происхождения)/.test(n)) return true;
  if (/артикул\s+производител/.test(n)) return true;
  if (n === 'vendor' || n === 'vendorcode' || n === 'vendor code' || n === 'mpn') return true;
  if (/^название(\s+товара)?$/.test(n) || n === 'name') return true;
  if (/^описание(\s+товара)?$/.test(n) || n === 'description') return true;
  return false;
}

export function filterYmCategoryAttributesForForm(attrs) {
  if (!Array.isArray(attrs)) return [];
  return attrs.filter((a) => !isYmParamDuplicatingDedicatedField(a?.name));
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
 * Текст карточки для push: приоритет у полей вкладки МП (mp_*),
 * при пустом mp_* и включённой связи — fallback на «Основное».
 */
export function resolveCardTextForPush(product, mp, fieldKey) {
  const links = normalizeMpFieldLinks(product?.mp_field_links);
  const linked = isMpFieldLinked(links, fieldKey, mp);

  if (fieldKey === 'name') {
    const mpVal =
      mp === 'ozon'
        ? trimOrNull(product.mp_ozon_name)
        : mp === 'wb'
          ? trimOrNull(product.mp_wb_name)
          : mp === 'ym'
            ? trimOrNull(product.mp_ym_name)
            : null;
    if (mpVal) return mpVal;
    return linked ? trimOrNull(product.name) : null;
  }
  if (fieldKey === 'description') {
    const mpVal =
      mp === 'ozon'
        ? trimOrNull(product.mp_ozon_description)
        : mp === 'wb'
          ? trimOrNull(product.mp_wb_description)
          : mp === 'ym'
            ? trimOrNull(product.mp_ym_description)
            : null;
    if (mpVal) return mpVal;
    return linked ? trimOrNull(product.description) : null;
  }
  if (fieldKey === 'brand') {
    const mpVal =
      mp === 'ozon'
        ? trimOrNull(product.mp_ozon_brand)
        : mp === 'wb'
          ? trimOrNull(product.mp_wb_brand)
          : null;
    if (mpVal) return mpVal;
    return linked ? trimOrNull(product.brand) : null;
  }
  if (fieldKey === 'sku') {
    if (linked) return trimOrNull(product.sku);
    if (mp === 'ozon') return trimOrNull(product.sku_ozon);
    if (mp === 'wb') return trimOrNull(product.mp_wb_vendor_code);
    if (mp === 'ym') return trimOrNull(product.sku_ym);
  }
  if (fieldKey === 'country') {
    if (linked) return trimOrNull(product.country_of_origin);
    const draft =
      mp === 'ozon'
        ? parseDraftObj(product?.ozon_draft)
        : mp === 'wb'
          ? parseDraftObj(product?.wb_draft)
          : mp === 'ym'
            ? parseDraftObj(product?.ym_draft)
            : {};
    if (mp === 'ym') {
      const list = draft.manufacturerCountries;
      if (Array.isArray(list)) {
        return list.map((c) => String(c || '').trim()).find(Boolean) || null;
      }
      return trimOrNull(list);
    }
    return trimOrNull(draft.country);
  }
  return null;
}

function parseDraftObj(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Габариты для push (мм / г): связь вкл. → ERP; выкл. → draft МП.
 * @returns {{ length?: number, width?: number, height?: number, weight?: number }|null}
 */
export function resolveDimensionsMmForPush(product, mp) {
  const links = normalizeMpFieldLinks(product?.mp_field_links);
  const code = String(mp || '').toLowerCase();
  if (isMpFieldLinked(links, 'dimensions', code)) {
    const out = {};
    if (product.length != null && Number(product.length) > 0) out.length = Number(product.length);
    if (product.width != null && Number(product.width) > 0) out.width = Number(product.width);
    if (product.height != null && Number(product.height) > 0) out.height = Number(product.height);
    if (product.weight != null && Number(product.weight) > 0) out.weight = Number(product.weight);
    return Object.keys(out).length ? out : null;
  }
  if (code === 'ym') {
    const draft = parseDraftObj(product?.ym_draft);
    return ymWeightDimensionsToErp(draft.weightDimensions);
  }
  const draft = parseDraftObj(code === 'ozon' ? product?.ozon_draft : product?.wb_draft);
  const d = draft.dimensions;
  if (!d || typeof d !== 'object') return null;
  const out = {};
  if (d.length != null && Number(d.length) > 0) out.length = Number(d.length);
  if (d.width != null && Number(d.width) > 0) out.width = Number(d.width);
  if (d.height != null && Number(d.height) > 0) out.height = Number(d.height);
  if (d.weight != null && Number(d.weight) > 0) out.weight = Number(d.weight);
  return Object.keys(out).length ? out : null;
}

/** Пушить габариты, если есть длина×ширина×высота (из Main или draft). */
export function shouldPushDimensions(product, mp) {
  const d = resolveDimensionsMmForPush(product, mp);
  return !!(d && Number(d.length) > 0 && Number(d.width) > 0 && Number(d.height) > 0);
}
