/**
 * Связь полей ERP ↔ маркетплейсы (серверная копия логики client/src/utils/productMpFieldLinks.js).
 * ERP: мм / г; Ozon: мм / г; WB: см / кг (weightBrutto); YM: см / кг.
 */

export const MP_FIELD_LINK_KEYS = [
  'name',
  'sku',
  'description',
  'brand',
  'country',
  'dimensions',
  'product_dimensions',
  'rich_content',
];

export const MP_FIELD_LINK_MPS = ['ozon', 'wb', 'ym'];

export const DEDICATED_PRODUCT_DIM_KEYS = [
  'product_length',
  'product_width',
  'product_height',
  'product_weight',
];

export const DEDICATED_PACK_DIM_KEYS = ['length', 'width', 'height', 'weight'];

/** Связь ручного ERP-атрибута с характеристиками МП: attr_<id> */
export const ATTR_MP_FIELD_LINK_RE = /^attr_\d+$/;

export function isAttrMpFieldLinkKey(fieldKey) {
  return ATTR_MP_FIELD_LINK_RE.test(String(fieldKey || ''));
}

export function isDedicatedMpFieldLinkKey(fieldKey) {
  const key = String(fieldKey || '');
  return (
    MP_FIELD_LINK_KEYS.includes(key) ||
    DEDICATED_PRODUCT_DIM_KEYS.includes(key) ||
    DEDICATED_PACK_DIM_KEYS.includes(key)
  );
}

export const MP_FIELD_LINK_SUPPORT = {
  name: ['ozon', 'wb', 'ym'],
  sku: ['ozon', 'wb', 'ym'],
  description: ['ozon', 'wb', 'ym'],
  brand: ['ozon', 'wb', 'ym'],
  country: ['ozon', 'wb', 'ym'],
  dimensions: ['ozon', 'wb', 'ym'],
  product_dimensions: ['ozon', 'wb', 'ym'],
  rich_content: ['ozon', 'wb', 'ym'],
};

export const DEDICATED_MAIN_MAP_KEYS = [
  'name',
  'sku',
  'description',
  'brand',
  'country',
  ...DEDICATED_PRODUCT_DIM_KEYS,
  ...DEDICATED_PACK_DIM_KEYS,
];

const DEDICATED_MAIN_STORED_KEYS = [
  ...DEDICATED_MAIN_MAP_KEYS,
  'product_dimensions',
  'dimensions',
];

function parseDedicatedCharcEntry(raw) {
  if (raw == null || raw === '' || raw === false) return null;
  if (raw === true) return { id: '', name: 'Основное' };
  if (typeof raw === 'string' || typeof raw === 'number') {
    const s = String(raw).trim();
    if (!s) return null;
    return /^\d+$/.test(s) ? { id: s, name: '' } : { id: '', name: s };
  }
  if (typeof raw !== 'object') return null;
  const id = raw.id != null && raw.id !== '' ? String(raw.id).trim() : '';
  const name = String(raw.name || raw.title || '').trim();
  if (!id && !name) return null;
  return { id, name };
}

function parseDedicatedCharcList(raw) {
  if (raw == null || raw === '' || raw === false) return [];
  if (raw === true) return [{ id: '', name: 'Основное' }];
  const items = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const e = parseDedicatedCharcEntry(item);
    if (!e) continue;
    const k = `${e.id}|${String(e.name || '').trim().toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function emptyCategoryDedicatedCharcLinks() {
  const out = {};
  for (const key of DEDICATED_MAIN_STORED_KEYS) {
    out[key] = { ozon: [], wb: [], ym: [] };
  }
  return out;
}

/** Какие поля Main явно добавлены в категорию (даже без связей с МП). */
export const DEDICATED_ADDED_KEYS_FIELD = '_added';

function parseDedicatedLinksObject(raw) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  return obj;
}

function dedicatedSlotHasAny(slot) {
  if (slot == null || slot === '') return false;
  if (Array.isArray(slot) && slot.every((x) => typeof x === 'string')) {
    return slot.some((x) => x === 'ozon' || x === 'wb' || x === 'ym');
  }
  if (typeof slot !== 'object') return false;
  return (
    parseDedicatedCharcList(slot.ozon).length > 0 ||
    parseDedicatedCharcList(slot.wb).length > 0 ||
    parseDedicatedCharcList(slot.ym).length > 0
  );
}

function sanitizeAddedDedicatedKeys(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(item || '').trim();
    if (!DEDICATED_MAIN_MAP_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function listAddedDedicatedMainKeys(raw) {
  const obj = parseDedicatedLinksObject(raw);
  if (!obj) return [];
  if (Object.prototype.hasOwnProperty.call(obj, DEDICATED_ADDED_KEYS_FIELD)) {
    return sanitizeAddedDedicatedKeys(obj[DEDICATED_ADDED_KEYS_FIELD]);
  }
  return DEDICATED_MAIN_MAP_KEYS.filter((key) => dedicatedSlotHasAny(obj[key]));
}

function copyDedicatedSlot(slot) {
  return {
    ozon: Array.isArray(slot?.ozon) ? slot.ozon : [],
    wb: Array.isArray(slot?.wb) ? slot.wb : [],
    ym: Array.isArray(slot?.ym) ? slot.ym : [],
  };
}

export function serializeCategoryDedicatedCharcLinks(raw, addedKeys) {
  const normalized = normalizeCategoryDedicatedCharcLinks(raw);
  const keys = sanitizeAddedDedicatedKeys(
    Array.isArray(addedKeys) ? addedKeys : listAddedDedicatedMainKeys(raw)
  );
  const out = { [DEDICATED_ADDED_KEYS_FIELD]: keys };
  for (const key of DEDICATED_MAIN_STORED_KEYS) {
    const slot = normalized[key];
    const keep =
      keys.includes(key) ||
      (!DEDICATED_MAIN_MAP_KEYS.includes(key) && dedicatedSlotHasAny(slot));
    if (!keep) continue;
    out[key] = copyDedicatedSlot(slot);
  }
  return out;
}

export function normalizeCategoryDedicatedCharcLinks(raw) {
  const out = emptyCategoryDedicatedCharcLinks();
  let obj = raw;
  if (raw == null || raw === '') {
    out[DEDICATED_ADDED_KEYS_FIELD] = [];
    return out;
  }
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      out[DEDICATED_ADDED_KEYS_FIELD] = [];
      return out;
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    out[DEDICATED_ADDED_KEYS_FIELD] = [];
    return out;
  }
  for (const key of DEDICATED_MAIN_STORED_KEYS) {
    const v = obj[key];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      out[key] = {
        ozon: v.includes('ozon') ? [{ id: '', name: 'Основное' }] : [],
        wb: v.includes('wb') ? [{ id: '', name: 'Основное' }] : [],
        ym: v.includes('ym') ? [{ id: '', name: 'Основное' }] : [],
      };
      continue;
    }
    out[key] = {
      ozon: parseDedicatedCharcList(v?.ozon),
      wb: parseDedicatedCharcList(v?.wb),
      ym: parseDedicatedCharcList(v?.ym),
    };
  }
  out[DEDICATED_ADDED_KEYS_FIELD] = listAddedDedicatedMainKeys(obj);
  return out;
}

export function emptyMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [];
  }
  return out;
}

export function createMpFieldLinks() {
  return emptyMpFieldLinks();
}

export function defaultMpFieldLinks() {
  return emptyMpFieldLinks();
}

/** Связи Main↔МП на карточке не наследуются из категории. */
export function overlayCategoryDedicatedMpLinks(productLinks, _categoryLinks) {
  return normalizeMpFieldLinks(productLinks);
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
    out[key] = parseFieldMpList(obj[key], supported);
  }
  for (const key of Object.keys(obj)) {
    if (!isAttrMpFieldLinkKey(key)) continue;
    out[key] = parseFieldMpList(obj[key], MP_FIELD_LINK_MPS);
  }
  return out;
}

function mpSlotIsLinked(slot) {
  if (slot == null || slot === false || slot === '') return false;
  if (Array.isArray(slot)) return slot.length > 0;
  if (typeof slot === 'object') return true;
  return true;
}

function parseFieldMpList(v, supported) {
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x || '').toLowerCase())
      .filter((m) => supported.includes(m));
  }
  if (v && typeof v === 'object') {
    return supported.filter((m) => mpSlotIsLinked(v[m]));
  }
  return [];
}

export function isMpFieldLinked(links, fieldKey, mp) {
  const list = links?.[fieldKey];
  if (!Array.isArray(list)) return false;
  return list.includes(String(mp || '').toLowerCase());
}

/** YM-параметры упаковки оффера (weightDimensions), не категорийные parameterValues. */
export function isYmPackOfferParam(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!n) return false;
  if (/^(длина|ширина|высота)\s+(упаковк|товара\s+в\s+упаковк)/.test(n)) return true;
  if (/^вес\s+(с\s+)?упаковк/.test(n)) return true;
  if (/^вес\s+товара\s+(с|в)\s+упаковк/.test(n)) return true;
  if (/^габарит(ы)?\s+упаковк/.test(n)) return true;
  return false;
}

function ymParamNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function isYmProductWeightOnlyParam(name) {
  const n = ymParamNameKey(name);
  if (!n || /упаковк/.test(n)) return false;
  if (/^(вес|weight)(\s+товара)?(\s*[,:(–-]\s*(г|кг|g|kg))?$/.test(n)) return true;
  if (/^вес\s+товара\b/.test(n)) return true;
  if (/^product\s+weight$/.test(n)) return true;
  return false;
}

/**
 * YM-параметры категории, которые уже редактируются отдельными полями карточки
 * (название / описание / страна). Габариты и вес в списке показываем.
 */
export function isYmParamDuplicatingDedicatedField(name) {
  const n = ymParamNameKey(name);
  if (!n) return false;
  if (/страна\s+(производства|изготовления|происхождения|производителя|изготовителя)/.test(n)) return true;
  if (n === 'страна' || n === 'country') return true;
  if (/^название(\s+товара)?$/.test(n) || n === 'name') return true;
  if (/^описание(\s+товара)?$/.test(n) || n === 'description') return true;
  if (n === 'бренд' || n === 'brand' || n === 'торговая марка') return true;
  if (n === 'штрихкод' || n === 'штрих код' || n === 'barcode' || n === 'ean' || n === 'gtin') return true;
  if (n === 'изготовитель' || n === 'производитель' || n === 'manufacturer') return true;
  if (isYmProductWeightOnlyParam(n)) return true;
  return false;
}

export function ymParamMatchesOfferField(name, field) {
  const n = ymParamNameKey(name);
  if (field === 'vendor') return n === 'бренд' || n === 'brand' || n === 'торговая марка';
  if (field === 'manufacturer') {
    return n === 'изготовитель' || n === 'производитель' || n === 'manufacturer';
  }
  if (field === 'barcode') {
    return n === 'штрихкод' || n === 'штрих код' || n === 'barcode' || n === 'ean' || n === 'gtin';
  }
  if (field === 'country') {
    return (
      n === 'страна' ||
      n === 'country' ||
      /страна\s+(производства|изготовления|происхождения|производителя|изготовителя)/.test(n)
    );
  }
  return false;
}

export function filterYmCategoryAttributesForForm(attrs) {
  if (!Array.isArray(attrs)) return [];
  return attrs.filter(
    (a) => !isYmParamDuplicatingDedicatedField(a?.name) && !isYmProductWeightOnlyParam(a?.name)
  );
}

function ymParamDedupeScore(p) {
  let s = 0;
  if (p?.required) s += 100;
  const ymType = String(p?.ym_parameter_type || p?.type || '').toUpperCase();
  if (ymType === 'ENUM' || ymType === 'DICTIONARY' || p?.type === 'dictionary') s += 50;
  const optCount = Array.isArray(p?.dictionary_options) ? p.dictionary_options.length : 0;
  s += Math.min(optCount, 40);
  if (p?.filtering) s += 25;
  if (p?.distinctive) s += 10;
  return s;
}

export function dedupeYmCategoryParamsByName(attrs) {
  const source = Array.isArray(attrs) ? attrs : [];
  const groups = new Map();
  for (const a of source) {
    const k = ymParamNameKey(a?.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const seen = new Set();
  const out = [];
  for (const a of source) {
    const k = ymParamNameKey(a?.name);
    if (!k) {
      out.push(a);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    const g = groups.get(k) || [a];
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    g.sort(
      (x, y) =>
        ymParamDedupeScore(y) - ymParamDedupeScore(x) || Number(x.id) - Number(y.id)
    );
    out.push(g[0]);
  }
  return out;
}

function normalizeWbCharcName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function isWbCountryCharcName(name) {
  const n = normalizeWbCharcName(name);
  if (!n) return false;
  if (n === 'страна' || n === 'country') return true;
  return /страна\s+(производства|изготовления|происхождения|производителя|изготовителя)/.test(n);
}

export function isWbCharcDuplicatingDedicatedField(name) {
  const n = normalizeWbCharcName(name);
  if (!n) return false;
  if (n === 'название' || n === 'наименование' || n === 'name' || n === 'title') return true;
  if (/^название(\s+товар(а)?)?$/.test(n)) return true;
  if (/^наименование(\s+товар(а)?)?$/.test(n)) return true;
  if (n === 'описание' || n === 'description') return true;
  if (/^описание(\s+товар(а)?)?$/.test(n)) return true;
  if (n.includes('описание') && (n.includes('товар') || n.includes('продавца') || n.includes('карточк'))) {
    return true;
  }
  if (isWbCountryCharcName(n)) return true;
  if (n === 'бренд' || n === 'brand') return true;
  if (n.includes('бренд продавца') || n.includes('торговая марк')) return true;
  if (n.includes('артикул продавца') || n === 'vendorcode' || n === 'vendor code') return true;
  return false;
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
          : mp === 'ym'
            ? trimOrNull(parseDraftObj(product?.ym_draft).vendor)
            : null;
    if (mpVal) return mpVal;
    if (mp === 'ym') return trimOrNull(product.brand);
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
    const fromOffer = ymWeightDimensionsToErp(draft.weightDimensions);
    if (fromOffer && Number(fromOffer.length) > 0 && Number(fromOffer.width) > 0 && Number(fromOffer.height) > 0) {
      return fromOffer;
    }
    const erp = {};
    if (product.length != null && Number(product.length) > 0) erp.length = Number(product.length);
    if (product.width != null && Number(product.width) > 0) erp.width = Number(product.width);
    if (product.height != null && Number(product.height) > 0) erp.height = Number(product.height);
    if (product.weight != null && Number(product.weight) > 0) erp.weight = Number(product.weight);
    return Object.keys(erp).length ? erp : fromOffer;
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

/**
 * Размеры товара (без упаковки) для push: связь вкл. → ERP product_*; выкл. → draft.productDimensions.
 */
export function resolveProductDimensionsMmForPush(product, mp) {
  const links = normalizeMpFieldLinks(product?.mp_field_links);
  const code = String(mp || '').toLowerCase();
  const pick = (src) => {
    if (!src || typeof src !== 'object') return null;
    const out = {};
    if (src.length != null && Number(src.length) > 0) out.length = Number(src.length);
    if (src.width != null && Number(src.width) > 0) out.width = Number(src.width);
    if (src.height != null && Number(src.height) > 0) out.height = Number(src.height);
    if (src.weight != null && Number(src.weight) > 0) out.weight = Number(src.weight);
    return Object.keys(out).length ? out : null;
  };
  if (isMpFieldLinked(links, 'product_dimensions', code)) {
    return pick({
      length: product.product_length ?? product.productLength,
      width: product.product_width ?? product.productWidth,
      height: product.product_height ?? product.productHeight,
      weight: product.product_weight ?? product.productWeight,
    });
  }
  const draft =
    code === 'ozon'
      ? parseDraftObj(product?.ozon_draft)
      : code === 'wb'
        ? parseDraftObj(product?.wb_draft)
        : parseDraftObj(product?.ym_draft);
  return pick(draft.productDimensions);
}

