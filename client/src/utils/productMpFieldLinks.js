/**
 * Связь полей вкладки «Основное» с карточками маркетплейсов.
 * ERP: габариты мм, вес г.
 * Ozon: мм / г; WB: см / кг (weightBrutto); YM: см / кг.
 */

import { classifyMarketplaceDimAttrName, ozonPackDimAxis } from './marketplaceDimensions.js';

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

/** Связь ручного ERP-атрибута с характеристиками МП: attr_<id> → ['ozon','wb','ym'] */
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

export function erpAttrLinkFieldKey(attrId) {
  const id = String(attrId ?? '').trim();
  return id ? `attr_${id}` : '';
}

/** Какие МП поддерживают связь для поля. */
export const MP_FIELD_LINK_SUPPORT = {
  name: ['ozon', 'wb', 'ym'],
  sku: ['ozon', 'wb', 'ym'],
  description: ['ozon', 'wb', 'ym'],
  brand: ['ozon', 'wb', 'ym'],
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

export const MP_FIELD_LINK_FIELD_LABELS = {
  name: 'Название',
  sku: 'Артикул',
  description: 'Описание',
  brand: 'Бренд',
  country: 'Страна производителя',
  product_length: 'Длина товара',
  product_width: 'Ширина товара',
  product_height: 'Высота товара',
  product_weight: 'Вес товара',
  length: 'Длина упаковки',
  width: 'Ширина упаковки',
  height: 'Высота упаковки',
  weight: 'Вес упаковки',
  product_dimensions: 'Габариты товара',
  dimensions: 'Габариты упаковки',
  rich_content: 'Rich-контент',
};

/** Поля вкладки «Основное», которые сопоставляются в категории с характеристиками МП. */
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

/** Поля вкладки «Основное», добавленные в категорию. */
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

/**
 * Сохранить только явно добавленные поля Main (можно без связей с МП).
 * @param {object|string|null} raw
 * @param {string[]} [addedKeys]
 */
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

/** Сопоставление поля Main → характеристики Ozon/WB/ЯМ (массивы {id,name}). */
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

/** Все связи выкл. — дефолт при чтении без сохранённого mp_field_links. */
export function emptyMpFieldLinks() {
  const out = {};
  for (const key of MP_FIELD_LINK_KEYS) {
    out[key] = [];
  }
  return out;
}

/** @deprecated связи полей Main↔МП задаются в категории, не при создании карточки. */
export function createMpFieldLinks() {
  return emptyMpFieldLinks();
}

/** @deprecated используйте emptyMpFieldLinks / createMpFieldLinks */
export function defaultMpFieldLinks() {
  return emptyMpFieldLinks();
}

/**
 * Связи Main↔МП на карточке не наследуются из категории.
 * Категория задаёт только сопоставление характеристик; тумблеры синхронизации — на товаре, по умолчанию выкл.
 */
export function overlayCategoryDedicatedMpLinks(productLinks, _categoryLinks) {
  return normalizeMpFieldLinks(productLinks);
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
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
  if (slot == null || slot === false || slot === '' || slot === 0) return false;
  if (slot === true || slot === 1 || slot === '1' || slot === 'true') return true;
  // Массив объектов [{id,name}] — сопоставление характеристик категории, не тумблер связи.
  if (Array.isArray(slot)) {
    if (!slot.length) return false;
    if (slot.every((x) => x != null && typeof x === 'object')) return false;
    return slot.some((x) => {
      const s = String(x || '').toLowerCase();
      return s === '1' || s === 'true' || MP_FIELD_LINK_MPS.includes(s);
    });
  }
  return false;
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

export function supportedMpsForFieldKey(fieldKey, supportedOverride) {
  if (Array.isArray(supportedOverride) && supportedOverride.length) {
    return supportedOverride.map((m) => String(m || '').toLowerCase()).filter(Boolean);
  }
  if (MP_FIELD_LINK_SUPPORT[fieldKey]) return MP_FIELD_LINK_SUPPORT[fieldKey];
  if (isAttrMpFieldLinkKey(fieldKey)) return [...MP_FIELD_LINK_MPS];
  return [];
}

function currentMpListForField(normalized, fieldKey, _supported) {
  if (Object.prototype.hasOwnProperty.call(normalized, fieldKey) && Array.isArray(normalized[fieldKey])) {
    return normalized[fieldKey];
  }
  return [];
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
export function toggleMpFieldLink(links, fieldKey, mp, supportedOverride) {
  const normalized = normalizeMpFieldLinks(links);
  const code = String(mp || '').toLowerCase();
  const supported = supportedMpsForFieldKey(fieldKey, supportedOverride);
  if (!supported.includes(code)) return normalized;
  const set = new Set(currentMpListForField(normalized, fieldKey, supported));
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
export function setMpFieldLink(links, fieldKey, mp, enabled, supportedOverride) {
  const normalized = normalizeMpFieldLinks(links);
  const code = String(mp || '').toLowerCase();
  const supported = supportedMpsForFieldKey(fieldKey, supportedOverride);
  if (!supported.includes(code)) return normalized;
  const set = new Set(currentMpListForField(normalized, fieldKey, supported));
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

/** Вес товара без упаковки: у Маркета такого параметра нет, только weightDimensions.weight. */
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
 * (название / описание / страна / бренд / штрихкод / изготовитель).
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
  if (n.includes('артикул производител') || n === 'vendorcode' || n === 'vendor code') return true;
  if (isYmProductWeightOnlyParam(n)) return true;
  return false;
}

/**
 * Поля оффера, которых нет среди характеристик категории API.
 * Показываем в выпадающих списках привязки в категории / атрибутах.
 */
export const MP_OFFER_FIELD_ATTRS = {
  ozon: [
    { id: '__ozon_offer_id__', name: 'Артикул продавца', description: 'offer_id карточки в кабинете Ozon' },
    { id: '__ozon_vendor_code__', name: 'Артикул производителя', description: 'Партномер / OEM; уходит в характеристику категории, если она есть' },
    { id: '__ozon_pack_length__', name: 'Длина упаковки', skipIfIds: ['9802'] },
    { id: '__ozon_pack_width__', name: 'Ширина упаковки', skipIfIds: ['6605', '9799'] },
    { id: '__ozon_pack_height__', name: 'Высота упаковки', skipIfIds: ['6606', '6859'] },
    { id: '__ozon_pack_weight__', name: 'Вес с упаковкой', skipIfIds: ['4497', '4383'] },
  ],
  wb: [{ id: '__wb_vendor_code__', name: 'Артикул продавца' }],
  ym: [
    { id: '__ym_name__', name: 'Название' },
    { id: '__ym_description__', name: 'Описание' },
    { id: '__ym_shop_sku__', name: 'Артикул продавца' },
    { id: '__ym_vendor_code__', name: 'Артикул производителя' },
    { id: '__ym_vendor__', name: 'Бренд' },
    { id: '__ym_barcodes__', name: 'Штрихкод' },
    { id: '__ym_manufacturer__', name: 'Изготовитель' },
    { id: '__ym_country__', name: 'Страна производства' },
    { id: '__ym_pack_length__', name: 'Длина упаковки', type: 'number', description: 'Поле оффера Маркета, см' },
    { id: '__ym_pack_width__', name: 'Ширина упаковки', type: 'number', description: 'Поле оффера Маркета, см' },
    { id: '__ym_pack_height__', name: 'Высота упаковки', type: 'number', description: 'Поле оффера Маркета, см' },
    { id: '__ym_pack_weight__', name: 'Вес товара в упаковке', type: 'number', description: 'Поле оффера Маркета (weightDimensions.weight), кг' },
  ],
};

export const YM_OFFER_FIELD_ATTRS = MP_OFFER_FIELD_ATTRS.ym;

function mpOfferFieldTarget(id) {
  switch (String(id || '')) {
    case '__ozon_offer_id__':
      return { kind: 'field', field: 'sku_ozon' };
    case '__ozon_vendor_code__':
      return { kind: 'ozon_vendor_code' };
    case '__wb_vendor_code__':
      return { kind: 'field', field: 'mp_wb_vendor_code' };
    case '__ym_name__':
      return { kind: 'field', field: 'mp_ym_name' };
    case '__ym_description__':
      return { kind: 'field', field: 'mp_ym_description' };
    case '__ym_shop_sku__':
      return { kind: 'field', field: 'sku_ym' };
    case '__ym_vendor_code__':
      return { kind: 'ym_vendor_code' };
    case '__ym_vendor__':
      return { kind: 'ym_vendor' };
    case '__ym_barcodes__':
      return { kind: 'ym_barcodes' };
    case '__ym_manufacturer__':
      return { kind: 'ym_manufacturer' };
    case '__ym_country__':
      return { kind: 'ym_country' };
    case '__ozon_pack_length__':
      return { kind: 'ozon_pack', axis: 'length' };
    case '__ozon_pack_width__':
      return { kind: 'ozon_pack', axis: 'width' };
    case '__ozon_pack_height__':
      return { kind: 'ozon_pack', axis: 'height' };
    case '__ozon_pack_weight__':
      return { kind: 'ozon_pack', axis: 'weight' };
    case '__ym_pack_length__':
      return { kind: 'ym_pack', axis: 'length' };
    case '__ym_pack_width__':
      return { kind: 'ym_pack', axis: 'width' };
    case '__ym_pack_height__':
      return { kind: 'ym_pack', axis: 'height' };
    case '__ym_pack_weight__':
      return { kind: 'ym_pack', axis: 'weight' };
    default:
      return null;
  }
}

export function isMpOfferFieldAttrId(id) {
  return mpOfferFieldTarget(id) != null;
}

export function isYmOfferFieldAttrId(id) {
  return String(id || '').startsWith('__ym_') && isMpOfferFieldAttrId(id);
}

export function readMpOfferFieldValue(formData, id) {
  const target = mpOfferFieldTarget(id);
  if (!target) return '';
  if (target.kind === 'field') return String(formData?.[target.field] ?? '');
  if (target.kind === 'ym_vendor_code') {
    return String(getMpDraft(formData, 'ym').vendorCode ?? '');
  }
  if (target.kind === 'ym_vendor') {
    if (isMpFieldLinked(formData?.mp_field_links, 'brand', 'ym')) {
      return String(formData?.brand ?? '');
    }
    return String(getMpDraft(formData, 'ym').vendor ?? '');
  }
  if (target.kind === 'ym_manufacturer') {
    return String(getMpDraft(formData, 'ym').manufacturer ?? '');
  }
  if (target.kind === 'ym_country') {
    if (isMpFieldLinked(formData?.mp_field_links, 'country', 'ym')) {
      return String(formData?.country_of_origin ?? '');
    }
    return getYmDraftCountry(formData);
  }
  if (target.kind === 'ym_barcodes') {
    const draft = String(getMpDraft(formData, 'ym').barcode ?? '').trim();
    if (draft) return draft;
    const rows = Array.isArray(formData?.barcodes) ? formData.barcodes : [];
    for (const row of rows) {
      const code = typeof row === 'string' ? row : row?.barcode;
      if (code != null && String(code).trim()) return String(code).trim();
    }
    return '';
  }
  if (target.kind === 'ozon_vendor_code') {
    return String(getMpDraft(formData, 'ozon').vendorCode ?? '');
  }
  if (target.kind === 'ozon_pack') {
    const dims = getMpDraft(formData, 'ozon').dimensions || {};
    const v = dims[target.axis];
    return v == null ? '' : String(v);
  }
  if (target.kind === 'ym_pack') {
    const wd = getYmDraftWeightDimensions(formData) || {};
    const v = wd[target.axis];
    return v == null ? '' : String(v);
  }
  return '';
}

export function applyMpOfferFieldToForm(prev, entryId, str, { onlyIfEmpty = false } = {}) {
  const target = mpOfferFieldTarget(entryId);
  if (!target) return prev;
  if (target.kind === 'field') {
    if (onlyIfEmpty && String(prev[target.field] ?? '').trim()) return prev;
    if (String(prev[target.field] ?? '') === str) return prev;
    return { ...prev, [target.field]: str };
  }
  if (target.kind === 'ym_vendor_code') {
    const d = parseDraftObj(prev?.ym_draft);
    if (onlyIfEmpty && String(d.vendorCode ?? '').trim()) return prev;
    if (String(d.vendorCode ?? '') === str) return prev;
    return { ...prev, ym_draft: { ...d, vendorCode: str } };
  }
  if (target.kind === 'ym_vendor') {
    if (isMpFieldLinked(prev?.mp_field_links, 'brand', 'ym')) {
      if (onlyIfEmpty && String(prev.brand ?? '').trim()) return prev;
      if (String(prev.brand ?? '') === str) return prev;
      return applyLinkedMpFieldsFromMain({ ...prev, brand: str }, prev.mp_field_links, ['brand']);
    }
    const d = parseDraftObj(prev?.ym_draft);
    if (onlyIfEmpty && String(d.vendor ?? '').trim()) return prev;
    if (String(d.vendor ?? '') === str) return prev;
    return { ...prev, ym_draft: { ...d, vendor: str } };
  }
  if (target.kind === 'ym_manufacturer') {
    const d = parseDraftObj(prev?.ym_draft);
    if (onlyIfEmpty && String(d.manufacturer ?? '').trim()) return prev;
    if (String(d.manufacturer ?? '') === str) return prev;
    return { ...prev, ym_draft: { ...d, manufacturer: str } };
  }
  if (target.kind === 'ym_country') {
    if (isMpFieldLinked(prev?.mp_field_links, 'country', 'ym')) {
      if (onlyIfEmpty && String(prev.country_of_origin ?? '').trim()) return prev;
      if (String(prev.country_of_origin ?? '') === str) return prev;
      return applyLinkedMpFieldsFromMain(
        { ...prev, country_of_origin: str },
        prev.mp_field_links,
        ['country']
      );
    }
    if (onlyIfEmpty && getYmDraftCountry(prev)) return prev;
    if (getYmDraftCountry(prev) === String(str || '').trim()) return prev;
    return withYmDraftCountry(prev, str);
  }
  if (target.kind === 'ym_barcodes') {
    const d = parseDraftObj(prev?.ym_draft);
    if (onlyIfEmpty && String(d.barcode ?? '').trim()) return prev;
    if (String(d.barcode ?? '') === str) return prev;
    return { ...prev, ym_draft: { ...d, barcode: str } };
  }
  if (target.kind === 'ozon_vendor_code') {
    const d = parseDraftObj(prev?.ozon_draft);
    if (onlyIfEmpty && String(d.vendorCode ?? '').trim()) return prev;
    if (String(d.vendorCode ?? '') === str) return prev;
    return { ...prev, ozon_draft: { ...d, vendorCode: str } };
  }
  if (target.kind === 'ozon_pack') {
    const d = parseDraftObj(prev?.ozon_draft);
    const dims =
      d.dimensions && typeof d.dimensions === 'object' && !Array.isArray(d.dimensions)
        ? { ...d.dimensions }
        : {};
    const n = Number(String(str || '').replace(',', '.'));
    const nextVal = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    if (onlyIfEmpty && Number(dims[target.axis]) > 0) return prev;
    if ((dims[target.axis] ?? null) === nextVal) return prev;
    if (nextVal == null) delete dims[target.axis];
    else dims[target.axis] = nextVal;
    return { ...prev, ozon_draft: { ...d, dimensions: dims } };
  }
  if (target.kind === 'ym_pack') {
    const d = parseDraftObj(prev?.ym_draft);
    const wd =
      d.weightDimensions && typeof d.weightDimensions === 'object' && !Array.isArray(d.weightDimensions)
        ? { ...d.weightDimensions }
        : {};
    const n = Number(String(str || '').replace(',', '.'));
    const nextVal = Number.isFinite(n) && n > 0 ? n : null;
    if (onlyIfEmpty && Number(wd[target.axis]) > 0) return prev;
    if ((wd[target.axis] ?? null) === nextVal) return prev;
    if (nextVal == null) delete wd[target.axis];
    else wd[target.axis] = nextVal;
    return { ...prev, ym_draft: { ...d, weightDimensions: wd } };
  }
  return prev;
}

function offerFieldNameAliases(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const keys = [n, `${n} товара`];
  if (n === 'артикул продавца') {
    keys.push('код продавца', 'код товара продавца', 'offer id', 'offer_id', 'shopsku', 'shop sku', 'sku');
  }
  if (n === 'артикул производителя') {
    keys.push('vendorcode', 'vendor code', 'mpn', 'партномер');
  }
  if (n === 'бренд') keys.push('brand', 'торговая марка');
  if (n === 'штрихкод') keys.push('штрих код', 'barcode', 'ean', 'gtin');
  if (n === 'изготовитель') keys.push('производитель', 'manufacturer');
  if (n === 'страна производства') {
    keys.push(
      'страна',
      'страна производителя',
      'страна изготовителя',
      'страна изготовления',
      'страна происхождения',
      'country'
    );
  }
  if (n === 'длина упаковки') keys.push('глубина упаковки', 'длина упаковки, мм', 'глубина упаковки, мм');
  if (n === 'ширина упаковки') keys.push('ширина упаковки, мм');
  if (n === 'высота упаковки') keys.push('высота упаковки, мм');
  if (n === 'вес с упаковкой' || n === 'вес товара в упаковке') {
    keys.push(
      'вес с упаковкой',
      'вес товара в упаковке',
      'вес упаковки',
      'вес в упаковке',
      'вес товара с упаковкой'
    );
  }
  return keys;
}

function normOfferFieldLookupName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** id поля оффера (__ym_shop_sku__ и т.д.) по подписи из схемы или категории. */
export function resolveMpOfferFieldIdByName(mp, name) {
  const code = String(mp || '').toLowerCase();
  const list = MP_OFFER_FIELD_ATTRS[code] || [];
  const want = normOfferFieldLookupName(name);
  if (!want) return '';
  for (const offer of list) {
    if (normOfferFieldLookupName(offer.name) === want) return String(offer.id);
    if (offerFieldNameAliases(offer.name).some((alias) => normOfferFieldLookupName(alias) === want)) {
      return String(offer.id);
    }
  }
  return '';
}

export function isYmOfferFieldParamName(name) {
  return !!resolveMpOfferFieldIdByName('ym', name);
}

export function withMpOfferFieldAttrs(mp, attrs) {
  const extras = MP_OFFER_FIELD_ATTRS[mp] || [];
  let list = dedupeYmCategoryParamsByName(mp, Array.isArray(attrs) ? [...attrs] : []);
  const code = String(mp || '').toLowerCase();
  if (code === 'ym') {
    list = list.filter(
      (a) =>
        !isYmParamDuplicatingDedicatedField(a?.name) &&
        !isYmPackOfferParam(a?.name) &&
        !isYmProductWeightOnlyParam(a?.name)
    );
  }
  if (code === 'ozon') {
    // Упаковка на Ozon — поля карточки, не характеристики категории («товар с упаковкой» нет).
    list = list.filter((a) => classifyMarketplaceDimAttrName(a?.name) !== 'pack' && !ozonPackDimAxis(a));
  }
  const ids = new Set(list.map((a) => String(a?.id ?? '').trim().toLowerCase()).filter(Boolean));
  const names = new Set(
    list
      .map((a) => String(a?.name || '').trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean)
  );
  for (const extra of extras) {
    if (ids.has(String(extra.id).toLowerCase())) continue;
    if ((extra.skipIfIds || []).some((sid) => ids.has(String(sid).toLowerCase()))) continue;
    // YM: дубликаты категории уже сняты; alias вроде «страна» не должен прятать поле оффера.
    if (code !== 'ym' && offerFieldNameAliases(extra.name).some((k) => names.has(k))) continue;
    const { skipIfIds: _skip, ...rest } = extra;
    list.push({ ...rest });
  }
  return list;
}

export function withYmOfferFieldAttrs(attrs) {
  return withMpOfferFieldAttrs('ym', attrs);
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

/** Одинаковые названия YM (часто «Модель автомобиля»): оставляем ENUM/обязательный/фильтр. */
export function dedupeYmCategoryParamsByName(mp, attrs) {
  const source = Array.isArray(attrs) ? attrs : [];
  if (String(mp || '').toLowerCase() !== 'ym') return source;
  const groups = new Map();
  for (const a of source) {
    const k = ymParamNameKey(a?.name);
    if (!k || String(a?.id || '').startsWith('__')) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const seen = new Set();
  const out = [];
  for (const a of source) {
    if (String(a?.id || '').startsWith('__')) {
      out.push(a);
      continue;
    }
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

const OZON_SKU_OFFER_FIELD_IDS = ['__ozon_offer_id__', '__ozon_vendor_code__'];

/** Характеристики Ozon для карточки товара: артикулы продавца/производителя сверху; упаковка — отдельный блок. */
export function ozonAttrsForProductForm(attrs) {
  const list = withMpOfferFieldAttrs('ozon', Array.isArray(attrs) ? attrs : []).filter(
    (a) => !String(a?.id || '').startsWith('__ozon_pack_')
  );
  const pinned = [];
  for (const id of OZON_SKU_OFFER_FIELD_IDS) {
    const hit = list.find((a) => String(a?.id) === id);
    if (hit) pinned.push(hit);
  }
  const rest = list.filter((a) => !OZON_SKU_OFFER_FIELD_IDS.includes(String(a?.id)));
  return [...pinned, ...rest];
}

/** Артикул продавца на вкладке МП с учётом связи с «Основным». */
export function readMpSellerSku(formData, mp) {
  const code = String(mp || '').toLowerCase();
  if (isMpFieldLinked(formData?.mp_field_links, 'sku', code)) {
    return String(formData?.sku ?? '');
  }
  if (code === 'ozon') return String(formData?.sku_ozon ?? '');
  if (code === 'wb') return String(formData?.mp_wb_vendor_code ?? '');
  if (code === 'ym') return String(formData?.sku_ym ?? '');
  return '';
}

/** Отфильтровать категорийные параметры YM, дублирующие dedicated-поля и несуществующий «вес товара». */
export function filterYmCategoryAttributesForForm(attrs) {
  if (!Array.isArray(attrs)) return [];
  return attrs.filter(
    (a) => !isYmParamDuplicatingDedicatedField(a?.name) && !isYmProductWeightOnlyParam(a?.name)
  );
}

function normalizeWbCharcName(name) {
  return String(name || '')
      .trim()
      .toLowerCase()
    .replace(/ё/g, 'е')
      .replace(/\s+/g, ' ');
}

/** Страна на WB — характеристика кабинета + dedicated-поле «Страна» на вкладке. */
export function isWbCountryCharcName(name) {
  const n = normalizeWbCharcName(name);
  if (!n) return false;
  if (n === 'страна' || n === 'country') return true;
  return /страна\s+(производства|изготовления|происхождения|производителя|изготовителя)/.test(n);
}

/**
 * Характеристики WB, которые уже редактируются отдельными полями вкладки
 * (название / описание / бренд / страна / артикул продавца).
 * Не скрываем «название модели», «наименование группы» и т.п.
 */
export function isWbCharcDuplicatingDedicatedField(name) {
  const n = normalizeWbCharcName(name);
  if (!n) return false;
  if (n === 'oem' || n === 'оем' || n.startsWith('oem ') || n.startsWith('оем ')) return false;
  if (n.includes('oem-номер') || n.includes('oem номер')) return false;
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
    if (isMpFieldLinked(normalized, 'brand', 'ym')) {
      const prevDraft =
        next.ym_draft && typeof next.ym_draft === 'object' && !Array.isArray(next.ym_draft)
          ? next.ym_draft
          : prev.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
            ? prev.ym_draft
            : {};
      next.ym_draft = { ...prevDraft, vendor: v };
    }
  }
  if (want('sku')) {
    const v = String(prev.sku || '');
    if (isMpFieldLinked(normalized, 'sku', 'wb')) next.mp_wb_vendor_code = v;
    if (isMpFieldLinked(normalized, 'sku', 'ozon')) next.sku_ozon = v;
    if (isMpFieldLinked(normalized, 'sku', 'ym')) next.sku_ym = v;
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
