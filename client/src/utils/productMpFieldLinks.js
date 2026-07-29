/**
 * Связь полей вкладки «Основное» с карточками маркетплейсов.
 * ERP: габариты мм, вес г.
 * Ozon: мм / г; WB: см / г (weightBrutto); YM: см / кг.
 */

export const MP_FIELD_LINK_KEYS = ['name', 'sku', 'description', 'brand', 'country', 'dimensions'];

export const MP_FIELD_LINK_MPS = ['ozon', 'wb', 'ym'];

/** Какие МП поддерживают связь для поля (по умолчанию все включены). */
export const MP_FIELD_LINK_SUPPORT = {
  name: ['ozon', 'wb', 'ym'],
  sku: ['ozon', 'wb', 'ym'],
  description: ['ozon', 'wb', 'ym'],
  brand: ['ozon', 'wb'],
  country: ['ozon', 'wb', 'ym'],
  dimensions: ['ozon', 'wb', 'ym'],
};

export const MP_FIELD_LINK_TOGGLES = [
  { code: 'ozon', label: 'OZ', title: 'Ozon', color: '#005bff' },
  { code: 'wb', label: 'WB', title: 'Wildberries', color: '#cb11ab' },
  { code: 'ym', label: 'ЯМ', title: 'Яндекс.Маркет', color: '#fc3f1d' },
];

export const MP_FIELD_LINK_TITLES = {
  name: 'Связать название с карточкой маркетплейса',
  sku: 'Связать артикул с артикулом продавца на маркетплейсе',
  description: 'Связать описание с карточкой маркетплейса',
  brand: 'Связать бренд с карточкой маркетплейса',
  country: 'Связать страну производства с карточкой маркетплейса',
  dimensions: 'Связать вес и габариты с карточкой маркетплейса (с пересчётом единиц)',
};

/** @returns {Record<string, string[]>} */
export function defaultMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [...(MP_FIELD_LINK_SUPPORT[key] || [])];
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
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

/**
 * @param {Record<string, string[]>} links
 * @param {string} fieldKey
 * @param {string} mp
 */
export function isMpFieldLinked(links, fieldKey, mp) {
  const list = links?.[fieldKey];
  if (!Array.isArray(list)) return false;
  return list.includes(String(mp || '').toLowerCase());
}

/**
 * @param {Record<string, string[]>} links
 * @param {string} fieldKey
 * @param {string} mp
 * @returns {Record<string, string[]>}
 */
export function toggleMpFieldLink(links, fieldKey, mp) {
  const normalized = normalizeMpFieldLinks(links);
  const code = String(mp || '').toLowerCase();
  const supported = MP_FIELD_LINK_SUPPORT[fieldKey] || [];
  if (!supported.includes(code)) return normalized;
  const set = new Set(normalized[fieldKey] || []);
  if (set.has(code)) set.delete(code);
  else set.add(code);
  return { ...normalized, [fieldKey]: supported.filter((m) => set.has(m)) };
}

/** мм → см для WB / YM */
export function mmToCm(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n / 10));
}

/** г → кг для YM */
export function gramsToKg(g) {
  const n = Number(g);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 1000) * 1000) / 1000;
}

/**
 * YM-параметры категории, которые уже редактируются отдельными полями ERP/оффера
 * (не показываем второй раз среди характеристик).
 * OEM / OE-код / партномер — не сюда (это категорийные характеристики).
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

/** Отфильтровать категорийные параметры YM, дублирующие dedicated-поля. */
export function filterYmCategoryAttributesForForm(attrs) {
  if (!Array.isArray(attrs)) return [];
  return attrs.filter((a) => !isYmParamDuplicatingDedicatedField(a?.name));
}

/** см → мм (YM → ERP) */
export function cmToMm(cm) {
  const n = Number(cm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * 10));
}

/** кг → г (YM → ERP) */
export function kgToGrams(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * 1000));
}

/**
 * YM weightDimensions (см / кг) → ERP (мм / г).
 * @returns {{ length?: number, width?: number, height?: number, weight?: number }|null}
 */
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

/**
 * Значения габаритов/веса в единицах маркетплейса для отображения.
 * @returns {{ length: number|null, width: number|null, height: number|null, weight: number|null, lengthUnit: string, weightUnit: string }}
 */
export function convertDimensionsForMarketplace(mp, { length, width, height, weight } = {}) {
  const code = String(mp || '').toLowerCase();
  const L = Number(length);
  const W = Number(width);
  const H = Number(height);
  const Wt = Number(weight);
  const safe = (n) => (Number.isFinite(n) && n > 0 ? n : null);

  if (code === 'wb') {
    return {
      length: safe(L) != null ? mmToCm(L) : null,
      width: safe(W) != null ? mmToCm(W) : null,
      height: safe(H) != null ? mmToCm(H) : null,
      weight: safe(Wt),
      lengthUnit: 'см',
      weightUnit: 'г',
    };
  }
  if (code === 'ym') {
    return {
      length: safe(L) != null ? mmToCm(L) : null,
      width: safe(W) != null ? mmToCm(W) : null,
      height: safe(H) != null ? mmToCm(H) : null,
      weight: safe(Wt) != null ? gramsToKg(Wt) : null,
      lengthUnit: 'см',
      weightUnit: 'кг',
    };
  }
  // ozon / default — как в ERP
  return {
    length: safe(L) != null ? Math.round(L) : null,
    width: safe(W) != null ? Math.round(W) : null,
    height: safe(H) != null ? Math.round(H) : null,
    weight: safe(Wt) != null ? Math.round(Wt) : null,
    lengthUnit: 'мм',
    weightUnit: 'г',
  };
}

/**
 * Подставить связанные значения из «Основное» в mp_* поля.
 * @param {object} prev formData
 * @param {Record<string, string[]>} links
 * @param {string[]} [onlyFields] ограничить полями
 */
export function applyLinkedMpFieldsFromMain(prev, links, onlyFields = null) {
  const next = { ...prev };
  const normalized = normalizeMpFieldLinks(links);
  const want = (key) => !onlyFields || onlyFields.includes(key);

  if (want('name')) {
    const v = String(prev.name || '');
    if (isMpFieldLinked(normalized, 'name', 'ozon')) next.mp_ozon_name = v;
    if (isMpFieldLinked(normalized, 'name', 'wb')) next.mp_wb_name = v;
    if (isMpFieldLinked(normalized, 'name', 'ym')) next.mp_ym_name = v;
  }
  if (want('description')) {
    const v = String(prev.description || '');
    if (isMpFieldLinked(normalized, 'description', 'ozon')) next.mp_ozon_description = v;
    if (isMpFieldLinked(normalized, 'description', 'wb')) next.mp_wb_description = v;
    if (isMpFieldLinked(normalized, 'description', 'ym')) next.mp_ym_description = v;
  }
  if (want('brand')) {
    const v = String(prev.brand || '');
    if (isMpFieldLinked(normalized, 'brand', 'ozon')) next.mp_ozon_brand = v;
    if (isMpFieldLinked(normalized, 'brand', 'wb')) next.mp_wb_brand = v;
  }
  if (want('sku')) {
    const v = String(prev.sku || '');
    if (isMpFieldLinked(normalized, 'sku', 'wb')) next.mp_wb_vendor_code = v;
    // Ozon offer_id / YM offerId — идентификаторы связи; копируем только если поле пустое
    if (isMpFieldLinked(normalized, 'sku', 'ozon') && !String(prev.sku_ozon || '').trim()) {
      next.sku_ozon = v;
    }
    if (isMpFieldLinked(normalized, 'sku', 'ym') && !String(prev.sku_ym || '').trim()) {
      next.sku_ym = v;
    }
  }
  return next;
}

/**
 * Значение поля на вкладке МП с учётом связи.
 */
export function resolveLinkedDisplayValue(formData, links, fieldKey, mp) {
  if (!isMpFieldLinked(links, fieldKey, mp)) {
    if (fieldKey === 'name') {
      if (mp === 'ozon') return formData.mp_ozon_name;
      if (mp === 'wb') return formData.mp_wb_name;
      if (mp === 'ym') return formData.mp_ym_name;
    }
    if (fieldKey === 'description') {
      if (mp === 'ozon') return formData.mp_ozon_description;
      if (mp === 'wb') return formData.mp_wb_description;
      if (mp === 'ym') return formData.mp_ym_description;
    }
    if (fieldKey === 'brand') {
      if (mp === 'ozon') return formData.mp_ozon_brand;
      if (mp === 'wb') return formData.mp_wb_brand;
    }
    if (fieldKey === 'sku') {
      if (mp === 'ozon') return formData.sku_ozon;
      if (mp === 'wb') return formData.mp_wb_vendor_code;
      if (mp === 'ym') return formData.sku_ym;
    }
    if (fieldKey === 'country') return '';
    return '';
  }
  if (fieldKey === 'name') return formData.name;
  if (fieldKey === 'description') return formData.description;
  if (fieldKey === 'brand') return formData.brand;
  if (fieldKey === 'sku') return formData.sku;
  if (fieldKey === 'country') return formData.country_of_origin;
  return '';
}
