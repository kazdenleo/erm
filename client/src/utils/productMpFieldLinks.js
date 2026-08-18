/**
 * Связь полей вкладки «Основное» с карточками маркетплейсов.
 * ERP: габариты мм, вес г.
 * Ozon: мм / г; WB: см / кг (weightBrutto); YM: см / кг.
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

/** Какие МП поддерживают связь для поля. */
export const MP_FIELD_LINK_SUPPORT = {
  name: ['ozon', 'wb', 'ym'],
  sku: ['ozon', 'wb', 'ym'],
  description: ['ozon', 'wb', 'ym'],
  brand: ['ozon', 'wb'],
  country: ['ozon', 'wb', 'ym'],
  dimensions: ['ozon', 'wb', 'ym'],
  /** Размеры товара (без упаковки): product_length / width / height / weight */
  product_dimensions: ['ozon', 'wb', 'ym'],
  rich_content: ['ozon', 'wb', 'ym'],
};

export const MP_FIELD_LINK_PEER_SYNC = {
  rich_content: true,
};

export const MP_FIELD_LINK_TOGGLES = [
  { code: 'ozon', label: 'OZ', title: 'Ozon', color: '#005bff' },
  { code: 'wb', label: 'WB', title: 'Wildberries', color: '#cb11ab' },
  { code: 'ym', label: 'ЯМ', title: 'Яндекс.Маркет', color: '#fc3f1d' },
];

export const MP_FIELD_LINK_TITLES = {
  name: 'Связать с вкладкой «Основное» (не с другими МП)',
  sku: 'Связать с артикулом на «Основном» (не с другими МП)',
  description: 'Связать с описанием на «Основном» (не с другими МП)',
  brand: 'Связать с брендом на «Основном» (не с другими МП)',
  country: 'Связать со страной на «Основном» (не с другими МП)',
  dimensions: 'Связать вес/габариты упаковки с «Основным» (не с другими МП; единицы пересчитываются)',
  product_dimensions: 'Связать размеры товара с «Основным» (не с другими МП)',
  rich_content: 'Связать Rich-контент: генерация заполняет все включённые маркетплейсы из шаблона категории',
};

/** Все связи выкл. — дефолт при чтении без сохранённого mp_field_links. */
export function emptyMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [];
  }
  return out;
}

/** Все поддерживаемые связи вкл. — только при создании новой карточки. */
export function createMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [...(MP_FIELD_LINK_SUPPORT[key] || [])];
  }
  return out;
}

/** @deprecated используйте emptyMpFieldLinks / createMpFieldLinks */
export function defaultMpFieldLinks() {
  return emptyMpFieldLinks();
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
export function normalizeMpFieldLinks(raw) {
  const defaults = emptyMpFieldLinks();
  if (raw == null || raw === '') {
    // Раньше размеры товара в bulk всегда зеркалились — сохраняем поведение по умолчанию.
    defaults.product_dimensions = [...(MP_FIELD_LINK_SUPPORT.product_dimensions || [])];
    defaults.rich_content = [...(MP_FIELD_LINK_SUPPORT.rich_content || [])];
    return defaults;
  }
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      defaults.product_dimensions = [...(MP_FIELD_LINK_SUPPORT.product_dimensions || [])];
      defaults.rich_content = [...(MP_FIELD_LINK_SUPPORT.rich_content || [])];
      return defaults;
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    defaults.product_dimensions = [...(MP_FIELD_LINK_SUPPORT.product_dimensions || [])];
    defaults.rich_content = [...(MP_FIELD_LINK_SUPPORT.rich_content || [])];
    return defaults;
  }

  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    const supported = MP_FIELD_LINK_SUPPORT[key] || [];
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      // Старые карточки без ключа — размеры товара и Rich-контент считаем связанными со всеми МП.
      out[key] = key === 'product_dimensions' || key === 'rich_content' ? [...supported] : [];
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

/**
 * Явно включить/выключить связь поля с МП (для массового редактирования).
 * @param {Record<string, string[]>} links
 * @param {string} fieldKey
 * @param {string} mp
 * @param {boolean} enabled
 * @returns {Record<string, string[]>}
 */
export function setMpFieldLink(links, fieldKey, mp, enabled) {
  const normalized = normalizeMpFieldLinks(links);
  const code = String(mp || '').toLowerCase();
  const supported = MP_FIELD_LINK_SUPPORT[fieldKey] || [];
  if (!supported.includes(code)) return normalized;
  const set = new Set(normalized[fieldKey] || []);
  if (enabled) set.add(code);
  else set.delete(code);
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
  return attrs.filter((a) => {
    if (isYmParamDuplicatingDedicatedField(a?.name)) return false;
    const n = String(a?.name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    // Габариты товара — отдельный блок на вкладке YM
    if (/^(длина|ширина|высота)\s+товар/.test(n)) return false;
    if (/^вес\s+товар/.test(n)) return false;
    if (/^габарит(ы)?\s+товар/.test(n)) return false;
    if (/^вес\s+без\s+упаковк/.test(n)) return false;
    return true;
  });
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

/** ERP мм/г → YM weightDimensions (см / кг). */
export function erpDimsToYmWeightDimensions({ length, width, height, weight } = {}) {
  const L = mmToCm(length);
  const W = mmToCm(width);
  const H = mmToCm(height);
  const Wt = gramsToKg(weight);
  if (L == null || W == null || H == null) return null;
  return {
    length: L,
    width: W,
    height: H,
    ...(Wt != null ? { weight: Wt } : {}),
  };
}

/** Достать weightDimensions из ym_draft формы/товара. */
export function getYmDraftWeightDimensions(formOrProduct) {
  const draft = formOrProduct?.ym_draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  const wd = draft.weightDimensions;
  return wd && typeof wd === 'object' ? wd : null;
}

/** Страна для YM без связи с «Основным» — ym_draft.manufacturerCountries. */
export function getYmDraftCountry(formOrProduct) {
  const draft = formOrProduct?.ym_draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return '';
  const list = draft.manufacturerCountries;
  if (Array.isArray(list)) {
    return list.map((c) => String(c || '').trim()).find(Boolean) || '';
  }
  if (list != null && String(list).trim()) return String(list).trim();
  return '';
}

export function withYmDraftCountry(prev, country) {
  const prevDraft =
    prev?.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
      ? prev.ym_draft
      : {};
  const c = String(country || '').trim();
  return {
    ...prev,
    ym_draft: {
      ...prevDraft,
      manufacturerCountries: c ? [c] : [],
    },
  };
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

/** ozon_draft / wb_draft / ym_draft */
export function getMpDraft(formOrProduct, mp) {
  const code = String(mp || '').toLowerCase();
  if (code === 'ozon') return parseDraftObj(formOrProduct?.ozon_draft);
  if (code === 'wb') return parseDraftObj(formOrProduct?.wb_draft);
  if (code === 'ym') return parseDraftObj(formOrProduct?.ym_draft);
  return {};
}

export function getMpDraftCountry(formOrProduct, mp) {
  const code = String(mp || '').toLowerCase();
  if (code === 'ym') return getYmDraftCountry(formOrProduct);
  return String(getMpDraft(formOrProduct, mp).country || '').trim();
}

/** Габариты МП без связи — в draft.dimensions (всегда мм / г). YM: weightDimensions (см/кг) → мм/г. */
export function getMpDraftDimensionsMm(formOrProduct, mp) {
  const code = String(mp || '').toLowerCase();
  if (code === 'ym') {
    const d = getMpDraft(formOrProduct, 'ym').dimensions;
    if (d && typeof d === 'object') return d;
    return ymWeightDimensionsToErp(getYmDraftWeightDimensions(formOrProduct));
  }
  const d = getMpDraft(formOrProduct, mp).dimensions;
  if (!d || typeof d !== 'object') return null;
  return d;
}

/** Габариты товара МП без связи — в draft.productDimensions (всегда мм / г). */
export function getMpDraftProductDimensionsMm(formOrProduct, mp) {
  const d = getMpDraft(formOrProduct, mp).productDimensions;
  if (!d || typeof d !== 'object') return null;
  return d;
}

export function withMpDraftPatch(prev, mp, patch) {
  const code = String(mp || '').toLowerCase();
  const key = code === 'ozon' ? 'ozon_draft' : code === 'wb' ? 'wb_draft' : code === 'ym' ? 'ym_draft' : null;
  if (!key) return prev;
  const prevDraft = parseDraftObj(prev?.[key]);
  return { ...prev, [key]: { ...prevDraft, ...patch } };
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
      // Content API weightBrutto — кг (как в кабинете WB)
      weight: safe(Wt) != null ? gramsToKg(Wt) : null,
      lengthUnit: 'см',
      weightUnit: 'кг',
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
  if (want('dimensions') && isMpFieldLinked(normalized, 'dimensions', 'ym')) {
    const wd = erpDimsToYmWeightDimensions(prev);
    if (wd) {
      const prevDraft =
        prev.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
          ? prev.ym_draft
          : {};
      next.ym_draft = { ...prevDraft, weightDimensions: wd };
    }
  }
  if (want('country') && isMpFieldLinked(normalized, 'country', 'ym')) {
    const c = String(prev.country_of_origin || '').trim();
    const prevDraft =
      next.ym_draft && typeof next.ym_draft === 'object' && !Array.isArray(next.ym_draft)
        ? next.ym_draft
        : prev.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
          ? prev.ym_draft
          : {};
    next.ym_draft = {
      ...prevDraft,
      manufacturerCountries: c ? [c] : [],
    };
  }
  if (want('country')) {
    const c = String(prev.country_of_origin || '').trim();
    if (isMpFieldLinked(normalized, 'country', 'ozon')) {
      const d = parseDraftObj(next.ozon_draft ?? prev.ozon_draft);
      next.ozon_draft = { ...d, country: c };
    }
    if (isMpFieldLinked(normalized, 'country', 'wb')) {
      const d = parseDraftObj(next.wb_draft ?? prev.wb_draft);
      next.wb_draft = { ...d, country: c };
    }
  }
  if (want('dimensions')) {
    const dims = {
      length: prev.length !== '' && prev.length != null ? Number(prev.length) : null,
      width: prev.width !== '' && prev.width != null ? Number(prev.width) : null,
      height: prev.height !== '' && prev.height != null ? Number(prev.height) : null,
      weight: prev.weight !== '' && prev.weight != null ? Number(prev.weight) : null,
    };
    if (isMpFieldLinked(normalized, 'dimensions', 'ozon')) {
      const d = parseDraftObj(next.ozon_draft ?? prev.ozon_draft);
      next.ozon_draft = { ...d, dimensions: dims };
    }
    if (isMpFieldLinked(normalized, 'dimensions', 'wb')) {
      const d = parseDraftObj(next.wb_draft ?? prev.wb_draft);
      next.wb_draft = { ...d, dimensions: dims };
    }
  }
  if (want('product_dimensions')) {
    const productDims = {
      length: prev.product_length !== '' && prev.product_length != null ? Number(prev.product_length) : null,
      width: prev.product_width !== '' && prev.product_width != null ? Number(prev.product_width) : null,
      height: prev.product_height !== '' && prev.product_height != null ? Number(prev.product_height) : null,
      weight: prev.product_weight !== '' && prev.product_weight != null ? Number(prev.product_weight) : null,
    };
    if (isMpFieldLinked(normalized, 'product_dimensions', 'ozon')) {
      const d = parseDraftObj(next.ozon_draft ?? prev.ozon_draft);
      next.ozon_draft = { ...d, productDimensions: productDims };
    }
    if (isMpFieldLinked(normalized, 'product_dimensions', 'wb')) {
      const d = parseDraftObj(next.wb_draft ?? prev.wb_draft);
      next.wb_draft = { ...d, productDimensions: productDims };
    }
    if (isMpFieldLinked(normalized, 'product_dimensions', 'ym')) {
      const d = parseDraftObj(next.ym_draft ?? prev.ym_draft);
      next.ym_draft = { ...d, productDimensions: productDims };
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
