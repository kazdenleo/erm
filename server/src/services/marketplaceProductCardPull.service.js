/**
 * Загрузка данных карточки товара с маркетплейсов в ERP (Ozon, WB, Яндекс.Маркет).
 * Маппинг полей согласован с ProductForm («Обновить данные с …»).
 */

import integrationsService from './integrations.service.js';
import productsService from './products.service.js';
import logger from '../utils/logger.js';
import { sanitizeWbVendorCode } from '../utils/wbVendorCode.js';
import { isOzonFreeTextMpAttr, isOzonManufacturerArticleAttr } from '../utils/ozonManufacturerArticle.js';
import {
  parseOzonComplexFromCard,
  findOzonVehicleGroups,
  countVehicleRows,
} from '../utils/ozonComplexAttributes.js';
import {
  cmToMm,
  DEDICATED_PACK_DIM_KEYS,
  isMpFieldLinked,
  normalizeMpFieldLinks,
  ymWeightDimensionsToErp,
} from '../utils/productMpFieldLinks.js';
import { WB_ITEM_DIM_CHARC, WB_PACK_DIM_CHARC, isWbDedicatedDimCharcId } from '../utils/marketplaceDimensions.js';
import {
  barcodesFromWbSizes,
  barcodesFromOzonCard,
  barcodesFromYmCard,
  mergeBarcodesFromMarketplace,
} from '../utils/productBarcodes.js';
import { importImagesFromMarketplaceCard } from './marketplaceProductImages.service.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';
import { marketplaceHtmlToPlainText, ozonAnnotationToErpText } from '../utils/marketplaceDescriptionHtml.js';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import { createDimensionsCheckTaskIfNeeded } from './employeeTasks.service.js';
import {
  detectOzonDimensionsLockedFromInfo,
  withOzonDraftDimensionsLock,
} from '../utils/ozonDimensionsLock.js';

const ALL_MP = ['ozon', 'wb', 'ym'];

const MP_TITLE = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

const UPDATE_FIELD_LABELS = {
  mp_ozon_name: 'название',
  mp_ozon_description: 'описание',
  mp_ozon_brand: 'бренд',
  sku_ozon: 'артикул',
  marketplace_ozon_product_id: 'product_id Ozon',
  ozon_attributes: 'атрибуты',
  ozon_draft: 'габариты/страна (черновик)',
  mp_wb_name: 'название',
  mp_wb_description: 'описание',
  mp_wb_brand: 'бренд',
  mp_wb_vendor_code: 'артикул (vendorCode)',
  sku_wb: 'nmId',
  wb_attributes: 'атрибуты',
  wb_draft: 'габариты/страна (черновик)',
  mp_ym_name: 'название',
  mp_ym_description: 'описание',
  sku_ym: 'артикул (offerId)',
  ym_market_sku: 'marketSku',
  ym_attributes: 'атрибуты',
  ym_draft: 'габариты/страна (черновик)',
  brand: 'бренд (Основное)',
  country_of_origin: 'страна (Основное)',
  length: 'длина упаковки',
  width: 'ширина упаковки',
  height: 'высота упаковки',
  weight: 'вес упаковки',
  barcodes: 'штрихкоды',
  images: 'изображения',
};

function stableJson(v) {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

function parseMaybeJson(v) {
  if (v == null) return v;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return v;
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }
  return v;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  const pa = parseMaybeJson(a);
  const pb = parseMaybeJson(b);
  if ((pa != null && typeof pa === 'object') || (pb != null && typeof pb === 'object')) {
    return stableJson(pa) === stableJson(pb);
  }
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/** Человекочитаемый список изменившихся полей карточки. */
function describeCardFieldChanges(product, updates) {
  if (!updates || typeof updates !== 'object') return [];
  const labels = [];
  for (const [key, nextVal] of Object.entries(updates)) {
    if (valuesEqual(product?.[key], nextVal)) continue;
    if (key === 'ozon_draft' || key === 'wb_draft' || key === 'ym_draft') {
      const prev = parseMaybeJson(product?.[key]) || {};
      const next = parseMaybeJson(nextVal) || {};
      const prevDims = prev?.dimensions || prev?.weightDimensions || null;
      const nextDims = next?.dimensions || next?.weightDimensions || null;
      if (!valuesEqual(prevDims, nextDims)) labels.push('габариты/вес');
      const prevCountry = prev?.country ?? prev?.manufacturerCountries ?? null;
      const nextCountry = next?.country ?? next?.manufacturerCountries ?? null;
      if (!valuesEqual(prevCountry, nextCountry)) labels.push('страна');
      continue;
    }
    labels.push(UPDATE_FIELD_LABELS[key] || key);
  }
  return [...new Set(labels)];
}

async function notifyCardFieldChanges(product, mp, changedLabels, opts = {}) {
  if (!Array.isArray(changedLabels) || changedLabels.length === 0) return;
  const sku = trimStr(product?.sku) || `#${product?.id}`;
  const name = trimStr(product?.name);
  const mpTitle = MP_TITLE[mp] || String(mp || '').toUpperCase();
  const fieldsText = changedLabels.join(', ');
  const profileId = opts.profileId ?? product?.profile_id ?? product?.profileId ?? null;
  await addRuntimeNotification({
    type: 'mp_card_field_changed',
    severity: 'warn',
    source: 'marketplace_card_pull',
    marketplace: mp,
    profileId,
    title: `Изменения карточки на ${mpTitle}`,
    message:
      `${sku}${name ? ` «${name.slice(0, 80)}»` : ''}: обновились поля (${fieldsText}).`,
    meta: {
      product_id: Number(product.id),
      marketplace: mp,
      fields: changedLabels,
      url: `/products/${product.id}`,
      ...(profileId != null ? { profile_id: Number(profileId) } : {}),
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeMp(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'all') return [...ALL_MP];
  if (m === 'wildberries') return ['wb'];
  if (m === 'yandex' || m === 'yandexmarket') return ['ym'];
  if (ALL_MP.includes(m)) return [m];
  const err = new Error('Неизвестный маркетплейс. Допустимо: ozon, wb, ym, all.');
  err.statusCode = 400;
  throw err;
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/** Ozon offer_id: убираем хвостовые `;` (часто попадают из импорта). */
function normalizeOzonOfferId(v) {
  const s = trimStr(v).replace(/;+\s*$/g, '').trim();
  return s;
}

function parseJsonObject(v) {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v };
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isEmptyVal(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function productOrgId(product) {
  const raw = product?.organization_id ?? product?.organizationId ?? null;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw).trim();
}

function stripHtml(s) {
  return marketplaceHtmlToPlainText(s);
}

function mergeOzonAttrsFromCard(attrs, prev = {}) {
  const next = { ...prev };
  if (!Array.isArray(attrs)) return next;
  for (const a of attrs) {
    const id = a.attribute_id ?? a.id;
    if (id == null) continue;
    const normalized = ozonAttrValueToStored(a);
    if (normalized === '') continue;
    next[String(id)] =
      Number(id) === 4191 ? ozonAnnotationToErpText(normalized) : normalized;
  }
  return next;
}

/** Значение атрибута Ozon для хранения: текст; для словаря — «Текст->id» (как в импорте). */
function ozonAttrValueToStored(a) {
  if (!a || typeof a !== 'object') return '';
    if (Array.isArray(a.values) && a.values.length > 0) {
      const parts = [];
      for (const v of a.values) {
        if (v == null) continue;
        const textRaw =
          v.value != null && String(v.value).trim() !== ''
            ? String(v.value).trim()
            : '';
        const dictId =
          v.dictionary_value_id != null && String(v.dictionary_value_id).trim() !== ''
            ? String(v.dictionary_value_id).trim()
            : v.id != null && String(v.id).trim() !== ''
              ? String(v.id).trim()
              : '';
        const text = textRaw && !(dictId && textRaw === dictId && /^\d+$/.test(textRaw)) ? textRaw : '';
        if (isOzonFreeTextMpAttr(a) || a.values.length > 1) {
          if (text) parts.push(text);
          else if (dictId) parts.push(String(dictId));
          continue;
        }
        if (text && dictId && dictId !== '0' && dictId !== text && !text.includes('->')) {
          return `${text}->${dictId}`;
        }
        if (text) return text;
        if (dictId) return dictId;
        return v != null ? String(v) : '';
      }
      if (parts.length) return parts.join('; ');
    }
  if (a.value != null && typeof a.value === 'object') {
    return String(a.value.value ?? a.value.text ?? a.value.id ?? '').trim();
  }
  if (a.value != null) return String(a.value).trim();
  return '';
}

function ozonAttrDisplayText(storedOrAttr) {
  if (storedOrAttr == null) return '';
  if (typeof storedOrAttr === 'object') {
    return stripOzonDictArrow(ozonAttrValueToStored(storedOrAttr));
  }
  return stripOzonDictArrow(String(storedOrAttr).trim());
}

function stripOzonDictArrow(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const idx = t.indexOf('->');
  if (idx > 0) return t.slice(0, idx).trim();
  return t;
}

function findOzonAttr(attrs, pred) {
  if (!Array.isArray(attrs)) return null;
  return attrs.find(pred) || null;
}

/**
 * Дозаполнить dedicated-поля и ozon_draft из атрибутов карточки
 * (у Ozon описание часто только в attr 4191; габариты/страна — в attrs).
 */
function enrichOzonUpdatesFromAttributes(updates, product, attrs) {
  const list = Array.isArray(attrs) ? attrs : [];
  const mergedAttrs = {
    ...parseJsonObject(product.ozon_attributes),
    ...(updates.ozon_attributes && typeof updates.ozon_attributes === 'object'
      ? updates.ozon_attributes
      : {}),
  };

  if (!trimStr(updates.mp_ozon_description)) {
    const a =
      findOzonAttr(list, (x) => Number(x.attribute_id ?? x.id) === 4191) ||
      findOzonAttr(list, (x) => /аннотация|описание\s+товар/i.test(String(x.name ?? '')));
    const t = a ? ozonAttrDisplayText(a) : ozonAttrDisplayText(mergedAttrs['4191']);
    if (t) updates.mp_ozon_description = ozonAnnotationToErpText(t);
  }

  if (!trimStr(updates.mp_ozon_name)) {
    const a = findOzonAttr(list, (x) => {
      const n = String(x.name || '')
        .toLowerCase()
        .trim();
      return (
        n === 'название' ||
        (n.startsWith('название') && !/модели|группы|файла|видео/.test(n))
      );
    });
    const t = a ? ozonAttrDisplayText(a) : '';
    if (t) updates.mp_ozon_name = t;
  }

  if (!trimStr(updates.mp_ozon_brand)) {
    const a =
      findOzonAttr(list, (x) => Number(x.attribute_id ?? x.id) === 85) ||
      findOzonAttr(list, (x) => /бренд|brand/i.test(String(x.name ?? '')));
    const t = a ? ozonAttrDisplayText(a) : ozonAttrDisplayText(mergedAttrs['85']);
    if (t) updates.mp_ozon_brand = t;
  } else if (/^\d+$/.test(trimStr(updates.mp_ozon_brand))) {
    // В mp_* попал только dictionary id — подставим человекочитаемый бренд из attrs
    const a =
      findOzonAttr(list, (x) => Number(x.attribute_id ?? x.id) === 85) ||
      findOzonAttr(list, (x) => /бренд|brand/i.test(String(x.name ?? '')));
    const t = a ? ozonAttrDisplayText(a) : ozonAttrDisplayText(mergedAttrs['85']);
    if (t && !/^\d+$/.test(t)) updates.mp_ozon_brand = t;
  }

  const toPos = (v) => {
    const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const pickMerged = (...keys) => {
    for (const k of keys) {
      const n = toPos(mergedAttrs[k] ?? mergedAttrs[String(k)]);
      if (n != null) return n;
    }
    return null;
  };

  const prevDraft = parseJsonObject(updates.ozon_draft ?? product.ozon_draft);
  const prevDims =
    prevDraft.dimensions && typeof prevDraft.dimensions === 'object' ? { ...prevDraft.dimensions } : {};

  // Упаковка: известные id Ozon (см. extractOzonDimensionsMm) + по имени атрибута
  let packL = toPos(prevDims.length) ?? pickMerged(9802);
  let packW = toPos(prevDims.width) ?? pickMerged(6605, 9799);
  let packH = toPos(prevDims.height) ?? pickMerged(6606, 6859);
  let packWt = toPos(prevDims.weight) ?? pickMerged(4497, 4383);

  for (const a of list) {
    const n = String(a.name || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const val = toPos(ozonAttrDisplayText(a));
    if (val == null) continue;
    if (/^(длина)\s+(упаковк|товара\s+в\s+упаковк)/.test(n) && packL == null) packL = val;
    else if (/^(ширина)\s+(упаковк|товара\s+в\s+упаковк)/.test(n) && packW == null) packW = val;
    else if (/^(высота)\s+(упаковк|товара\s+в\s+упаковк)/.test(n) && packH == null) packH = val;
    else if (/^вес\s+(с\s+)?упаковк|^вес\s+товара\s+с\s+упаковк/.test(n) && packWt == null) packWt = val;
  }

  let country = trimStr(prevDraft.country);
  if (!country) {
    const a =
      findOzonAttr(list, (x) => Number(x.attribute_id ?? x.id) === 4389) ||
      findOzonAttr(list, (x) =>
        /страна\s+(производства|изготовления|происхождения)/i.test(String(x.name ?? ''))
      );
    country = a ? ozonAttrDisplayText(a) : ozonAttrDisplayText(mergedAttrs['4389']);
  }

  let vendorCode = trimStr(prevDraft.vendorCode);
  if (!vendorCode) {
    const a = findOzonAttr(list, isOzonManufacturerArticleAttr);
    vendorCode = a ? ozonAttrDisplayText(a) : '';
  }

  if (packL != null || packW != null || packH != null || packWt != null || country || vendorCode) {
    updates.ozon_draft = {
      ...prevDraft,
      dimensions: {
        ...prevDims,
        ...(packL != null ? { length: packL } : {}),
        ...(packW != null ? { width: packW } : {}),
        ...(packH != null ? { height: packH } : {}),
        ...(packWt != null ? { weight: packWt } : {}),
      },
      ...(country ? { country } : {}),
      ...(vendorCode ? { vendorCode } : {}),
    };
  }
}

function mapOzonCardToUpdates(product, data) {
  const updates = {};
  const name = trimStr(data.name ?? data.title);
  const description = stripHtml(data.description ?? data.description_html ?? '');
  let brand = trimStr(data.brand);
  const attrs = data.attributes ?? data.attribute_values;
  if (!brand && Array.isArray(attrs)) {
    const brandAttr = attrs.find(
      (a) =>
        Number(a.attribute_id ?? a.id) === 85 ||
        /бренд|brand/i.test(String(a.name ?? a.attribute_id ?? ''))
    );
    if (brandAttr) brand = ozonAttrDisplayText(brandAttr);
  }
  if (name) updates.mp_ozon_name = name;
  if (description) updates.mp_ozon_description = description;
  if (brand) updates.mp_ozon_brand = brand;

  const offerIdFromOzon = normalizeOzonOfferId(data.offer_id ?? data.sku);
  if (offerIdFromOzon) updates.sku_ozon = offerIdFromOzon;
  if (data.id != null && String(data.id).trim() !== '') {
    const n = Number(String(data.id).replace(/\D/g, '').slice(0, 19));
    if (Number.isFinite(n) && n > 0) updates.marketplace_ozon_product_id = n;
  }

  const dx = data.dimension_x ?? data.width;
  const dy = data.dimension_y ?? data.height;
  const dz = data.dimension_z ?? data.depth ?? data.length;
  const toPos = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const apiLength = toPos(dz);
  const apiWidth = toPos(dx);
  const apiHeight = toPos(dy);
  const apiWeight = toPos(data.weight ?? data.weight_brutto);

  // Габариты с Ozon в ozon_draft всегда. В «Основное» — только если упаковка
  // не связана с Ozon (иначе импорт откатывает только что изменённые мм).
  const packLinked = isPackLinkedToMp(product, 'ozon');
  if (!packLinked) {
    if (apiWidth != null) updates.width = apiWidth;
    if (apiHeight != null) updates.height = apiHeight;
    if (apiLength != null) updates.length = apiLength;
    if (apiWeight != null) updates.weight = apiWeight;
  }

  // Как WB: габариты упаковки в ozon_draft (для мин. цен без связи dimensions↔ozon)
  const erpLength = toPos(product.length);
  const erpWidth = toPos(product.width);
  const erpHeight = toPos(product.height);
  const erpWeight = toPos(product.weight);
  const draftLength = apiLength ?? erpLength;
  const draftWidth = apiWidth ?? erpWidth;
  const draftHeight = apiHeight ?? erpHeight;
  const draftWeight = apiWeight ?? erpWeight;
  const dimsLocked = detectOzonDimensionsLockedFromInfo(data);
  const prevDraft = parseJsonObject(product.ozon_draft);
  const prevDims =
    prevDraft.dimensions && typeof prevDraft.dimensions === 'object' ? prevDraft.dimensions : {};
  let nextDraft = { ...prevDraft };
  if (draftLength != null || draftWidth != null || draftHeight != null || draftWeight != null) {
    nextDraft = {
      ...nextDraft,
      dimensions: {
        ...prevDims,
        ...(draftLength != null ? { length: draftLength } : {}),
        ...(draftWidth != null ? { width: draftWidth } : {}),
        ...(draftHeight != null ? { height: draftHeight } : {}),
        ...(draftWeight != null ? { weight: draftWeight } : {}),
      },
    };
  }
  nextDraft = withOzonDraftDimensionsLock(nextDraft, dimsLocked);
  updates.ozon_draft = nextDraft;

  const prevAttrs = parseJsonObject(product.ozon_attributes);
  const mergedAttrs = mergeOzonAttrsFromCard(attrs, prevAttrs);
  if (Object.keys(mergedAttrs).length > 0) {
    updates.ozon_attributes = mergedAttrs;
  }

  try {
    const schemaForVehicles = Array.isArray(attrs) ? attrs : [];
    const groups = findOzonVehicleGroups(schemaForVehicles, []);
    const parsed = parseOzonComplexFromCard(data.complex_attributes, attrs, groups);
    if (countVehicleRows(parsed) > 0) {
      updates.ozon_complex_attributes = parsed;
    }
  } catch {
    /* schema без complex_id — пропускаем */
  }

  enrichOzonUpdatesFromAttributes(updates, product, attrs);

  const ozBarcodes = barcodesFromOzonCard(data);
  const mergedBc = mergeBarcodesFromMarketplace(product.barcodes, ozBarcodes, 'ozon');
  if (mergedBc) updates.barcodes = mergedBc;

  return updates;
}

function isPackLinkedToMp(product, mp) {
  const links = normalizeMpFieldLinks(product?.mp_field_links);
  if (isMpFieldLinked(links, 'dimensions', mp)) return true;
  return DEDICATED_PACK_DIM_KEYS.some((k) => isMpFieldLinked(links, k, mp));
}

function wbCharcNumeric(characteristics, charcId) {
  if (!Array.isArray(characteristics)) return null;
  const want = String(charcId);
  const hit = characteristics.find((c) => String(c?.id ?? c?.characteristic_id ?? c?.charcID ?? '') === want);
  if (!hit) return null;
  const raw = hit.value;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return toNumber(v);
}

function mergeWbAttrsFromCard(characteristics, prev = {}) {
  const next = { ...prev };
  if (!Array.isArray(characteristics)) return next;
  for (const c of characteristics) {
    const id = c?.id ?? c?.characteristic_id ?? c?.charcID;
    const key = id != null ? String(id) : String(c?.name ?? c?.characteristic_name ?? '').trim();
    if (!key) continue;
    if (!isWbDedicatedDimCharcId(key) && !isEmptyVal(next[key])) continue;
    const raw = c?.value;
    let normalized = '';
    if (raw === undefined || raw === null) normalized = '';
    else if (typeof raw === 'boolean' || typeof raw === 'number') normalized = raw;
    else if (Array.isArray(raw)) {
      normalized = raw.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join('; ');
    } else if (typeof raw === 'object') {
      try {
        normalized = JSON.stringify(raw);
      } catch {
        normalized = String(raw);
      }
    } else {
      normalized = String(raw);
    }
    if (isEmptyVal(normalized)) continue;
    next[key] = normalized;
  }
  return next;
}

function mergeYmAttrsFromCard(parameterValues, prev = {}) {
  const next = { ...prev };
  if (!Array.isArray(parameterValues)) return next;
  for (const pv of parameterValues) {
    const pid = pv?.parameterId ?? pv?.id;
    if (pid == null) continue;
    const key = String(pid);
    if (!isEmptyVal(next[key])) continue;
    // ENUM: valueId нужен для селекта; текст — запасной вариант
    let val =
      pv?.valueId ??
      pv?.optionId ??
      pv?.dictionaryValueId ??
      pv?.value ??
      null;
    if (val != null && typeof val === 'object') {
      val = val.valueId ?? val.id ?? val.value ?? val.label ?? '';
    }
    if (val != null && String(val).trim() !== '') {
      next[key] = String(val).trim();
    }
  }
  return next;
}

function toNumber(v) {
  const n =
    typeof v === 'number'
      ? v
      : v != null && String(v).trim() !== ''
        ? Number(String(v).replace(',', '.'))
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function mapWbCardToUpdates(product, data) {
  const updates = {};
  const name = trimStr(data.title ?? data.name);
  const brand = trimStr(data.brand);
  const description = trimStr(data.description ?? data.descriptionRu);
  const vendorCode = sanitizeWbVendorCode(data.vendorCode ?? data.vendor_code);
  if (name) updates.mp_wb_name = name;
  if (description) updates.mp_wb_description = description;
  if (brand) updates.mp_wb_brand = brand;
  if (vendorCode) updates.mp_wb_vendor_code = vendorCode;

  const nmFromWb = data.nmId ?? data.nmID ?? data.nm_id;
  if (nmFromWb != null && String(nmFromWb).trim() !== '') {
    updates.sku_wb = String(nmFromWb).trim();
  }

  const dims = data.dimensions && typeof data.dimensions === 'object' ? data.dimensions : null;
  const width = dims?.width;
  const height = dims?.height;
  const length = dims?.length;
  const weightBrutto = dims?.weightBrutto;
  const convertDimsToMm = (val, all) => {
    const n = toNumber(val);
    if (n == null) return null;
    const max = Math.max(...all.map((x) => toNumber(x) ?? 0));
    return max > 0 && max <= 200 ? Math.round(n * 10) : Math.round(n);
  };
  const convertWeightToG = (val) => {
    const n = toNumber(val);
    if (n == null) return null;
    return n <= 50 ? Math.round(n * 1000) : Math.round(n);
  };
  const wMm = convertDimsToMm(width, [width, height, length]);
  const hMm = convertDimsToMm(height, [width, height, length]);
  const lMm = convertDimsToMm(length, [width, height, length]);
  const wG = convertWeightToG(weightBrutto);
  if (wG != null && isEmptyVal(product.weight)) updates.weight = wG;
  if (lMm != null && isEmptyVal(product.length)) updates.length = lMm;
  if (wMm != null && isEmptyVal(product.width)) updates.width = wMm;
  if (hMm != null && isEmptyVal(product.height)) updates.height = hMm;

  // Всегда сохраняем габариты упаковки WB (Content API dimensions) в wb_draft
  if (lMm != null || wMm != null || hMm != null || wG != null) {
    const prevDraft = parseJsonObject(product.wb_draft);
    const prevDims =
      prevDraft.dimensions && typeof prevDraft.dimensions === 'object' ? prevDraft.dimensions : {};
    updates.wb_draft = {
      ...prevDraft,
      dimensions: {
        ...prevDims,
        ...(lMm != null ? { length: lMm } : {}),
        ...(wMm != null ? { width: wMm } : {}),
        ...(hMm != null ? { height: hMm } : {}),
        ...(wG != null ? { weight: wG } : {}),
      },
    };
  }

  const itemLcm = wbCharcNumeric(data.characteristics, WB_ITEM_DIM_CHARC.length);
  const itemWcm = wbCharcNumeric(data.characteristics, WB_ITEM_DIM_CHARC.width);
  const itemHcm = wbCharcNumeric(data.characteristics, WB_ITEM_DIM_CHARC.height);
  const itemLmm = cmToMm(itemLcm);
  const itemWmm = cmToMm(itemWcm);
  const itemHmm = cmToMm(itemHcm);
  if (itemLmm != null || itemWmm != null || itemHmm != null) {
    const prevDraft = parseJsonObject(updates.wb_draft ?? product.wb_draft);
    const prevProduct =
      prevDraft.productDimensions && typeof prevDraft.productDimensions === 'object'
        ? prevDraft.productDimensions
        : {};
    updates.wb_draft = {
      ...prevDraft,
      productDimensions: {
        ...prevProduct,
        ...(itemLmm != null ? { length: itemLmm } : {}),
        ...(itemWmm != null ? { width: itemWmm } : {}),
        ...(itemHmm != null ? { height: itemHmm } : {}),
      },
    };
  }

  const wbBarcodes = barcodesFromWbSizes(data.sizes);
  const mergedWbBc = mergeBarcodesFromMarketplace(product.barcodes, wbBarcodes, 'wb');
  if (mergedWbBc) updates.barcodes = mergedWbBc;

  const prevAttrs = parseJsonObject(product.wb_attributes);
  let mergedAttrs = mergeWbAttrsFromCard(data.characteristics, prevAttrs);
  // Зеркало card.dimensions → атрибуты «* упаковки» (см), чтобы объём/логистика брали упаковку
  const lengthCm = toNumber(length);
  const widthCm = toNumber(width);
  const heightCm = toNumber(height);
  if (lengthCm != null && widthCm != null && heightCm != null) {
    mergedAttrs = {
      ...mergedAttrs,
      [WB_PACK_DIM_CHARC.length]: String(lengthCm),
      [WB_PACK_DIM_CHARC.width]: String(widthCm),
      [WB_PACK_DIM_CHARC.height]: String(heightCm),
    };
  }
  if (itemLcm != null) mergedAttrs = { ...mergedAttrs, [WB_ITEM_DIM_CHARC.length]: String(itemLcm) };
  if (itemWcm != null) mergedAttrs = { ...mergedAttrs, [WB_ITEM_DIM_CHARC.width]: String(itemWcm) };
  if (itemHcm != null) mergedAttrs = { ...mergedAttrs, [WB_ITEM_DIM_CHARC.height]: String(itemHcm) };
  if (Object.keys(mergedAttrs).length > 0) {
    updates.wb_attributes = mergedAttrs;
  }
  return updates;
}

function mapYmCardToUpdates(product, data) {
  const updates = {};
  const resolvedOfferId = trimStr(data.offerId);
  const name = trimStr(data.name);
  const description = marketplaceHtmlToPlainText(data.description);
  if (resolvedOfferId) updates.sku_ym = resolvedOfferId;
  if (data.marketSku != null && String(data.marketSku).trim() !== '') {
    updates.ym_market_sku = String(data.marketSku).trim();
  }
  if (name) updates.mp_ym_name = name;
  if (description) updates.mp_ym_description = description;

  const vendor = trimStr(data.vendor);
  const prevDraft = parseJsonObject(product.ym_draft);
  const nextDraft = { ...prevDraft };
  if (vendor) {
    nextDraft.vendor = vendor;
    if (isEmptyVal(product.brand)) updates.brand = vendor;
  }
  const manufacturerFromParams = Array.isArray(data.parameterValues)
    ? data.parameterValues.find((pv) => {
        const n = String(pv?.parameterName ?? pv?.name ?? '')
          .trim()
          .toLowerCase();
        return n === 'изготовитель' || n === 'производитель' || n === 'manufacturer';
      })
    : null;
  const manufacturerVal =
    manufacturerFromParams?.value ??
    manufacturerFromParams?.valueId ??
    null;
  if (manufacturerVal != null && String(manufacturerVal).trim()) {
    nextDraft.manufacturer = String(manufacturerVal).trim();
  }

  const countries = Array.isArray(data.manufacturerCountries) ? data.manufacturerCountries : [];
  const country = countries.map((c) => trimStr(c)).find(Boolean) || '';
  if (country && isEmptyVal(product.country_of_origin)) {
    updates.country_of_origin = country;
  }

  // YM API: см / кг → ERP мм / г; отдельно сохраняем weightDimensions в ym_draft
  const dims = ymWeightDimensionsToErp(data.weightDimensions);
  if (dims) {
    if (dims.length != null && isEmptyVal(product.length)) updates.length = dims.length;
    if (dims.width != null && isEmptyVal(product.width)) updates.width = dims.width;
    if (dims.height != null && isEmptyVal(product.height)) updates.height = dims.height;
    if (dims.weight != null && isEmptyVal(product.weight)) updates.weight = dims.weight;
  }
  if (data.weightDimensions && typeof data.weightDimensions === 'object') {
    nextDraft.weightDimensions = {
      length: data.weightDimensions.length,
      width: data.weightDimensions.width,
      height: data.weightDimensions.height,
      ...(data.weightDimensions.weight != null ? { weight: data.weightDimensions.weight } : {}),
    };
  }
  if (Object.keys(nextDraft).length) {
    updates.ym_draft = nextDraft;
  }

  const prevAttrs = parseJsonObject(product.ym_attributes);
  const mergedAttrs = mergeYmAttrsFromCard(data.parameterValues, prevAttrs);
  if (Object.keys(mergedAttrs).length > 0) {
    updates.ym_attributes = mergedAttrs;
  }

  const ymBarcodes = barcodesFromYmCard(data);
  const mergedYmBc = mergeBarcodesFromMarketplace(product.barcodes, ymBarcodes, 'ym');
  if (mergedYmBc) updates.barcodes = mergedYmBc;

  return updates;
}

async function fetchOzonCard(product, scope) {
  const organizationId = scope.organizationId;
  if (!organizationId) {
    const err = new Error('У товара не указана организация — нельзя запросить кабинет Ozon.');
    err.statusCode = 400;
    throw err;
  }
  const productIdRaw =
    product.ozon_product_id != null
      ? String(product.ozon_product_id)
      : product.marketplace_ozon_product_id != null
        ? String(product.marketplace_ozon_product_id)
        : '';
  const productId = productIdRaw ? Number(productIdRaw.replace(/\D/g, '')) : null;
  const explicitOffers = [
    product.sku_ozon,
    product.marketplace_skus?.ozon,
  ]
    .map((v) => normalizeOzonOfferId(v))
    .filter(Boolean);
  const hasExplicitLink = (productId && productId > 0) || explicitOffers.length > 0;
  // Без привязки Ozon не дергаем кабинет по «голому» ERP-артикулу — это даёт ложные 31 ошибку в массовом обновлении.
  if (!hasExplicitLink) {
    const erpSku = normalizeOzonOfferId(product.sku);
    const err = new Error(
      erpSku
        ? `Нет привязки к Ozon (sku_ozon / product_id). Артикул ERP «${erpSku}» в кабинет не отправлялся — укажите артикул Ozon в карточке.`
        : 'Нет привязки к Ozon (sku_ozon / product_id). Укажите артикул Ozon в карточке товара.'
    );
    err.statusCode = 400;
    err.code = 'NO_OZON_LINK';
    err.skipped = true;
    throw err;
  }
  const offerIds = [...new Set(explicitOffers)];
  const apiBase = { organizationId, profileId: scope.profileId ?? null };
  let data = null;
  let lastErr = null;
  const tried = [];
  if (productId && productId > 0) {
    tried.push(`product_id=${productId}`);
    try {
      data = await integrationsService.getOzonProductInfo({ ...apiBase, product_id: productId });
    } catch (e) {
      lastErr = e;
    }
  }
  for (const offerId of offerIds) {
    if (data) break;
    tried.push(`offer_id=${offerId}`);
    try {
      data = await integrationsService.getOzonProductInfo({ ...apiBase, offer_id: offerId });
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) {
    if (lastErr) throw lastErr;
    const err = new Error(
      `Товар не найден в кабинете Ozon выбранной организации (искали: ${tried.join(', ') || '—'}).`
    );
    err.statusCode = 404;
    throw err;
  }
  return data;
}

async function fetchWbCard(product, scope) {
  const organizationId = scope.organizationId;
  if (!organizationId) {
    const err = new Error('У товара не указана организация — нельзя запросить кабинет Wildberries.');
    err.statusCode = 400;
    throw err;
  }
  const skuWbRaw = trimStr(product.sku_wb);
  const nmId = skuWbRaw && /^\d+$/.test(skuWbRaw) ? skuWbRaw : null;
  const expectedVendor = sanitizeWbVendorCode(product.mp_wb_vendor_code);
  const vendorCandidates = [
    product.mp_wb_vendor_code,
    product.sku_ozon,
    skuWbRaw && !nmId ? skuWbRaw : null
  ]
    .map((v) => sanitizeWbVendorCode(v))
    .filter(Boolean);
  const vendorCodes = [...new Set(vendorCandidates)];
  if (!nmId && vendorCodes.length === 0) {
    const err = new Error('Нет nmId WB или vendorCode для запроса.');
    err.statusCode = 400;
    throw err;
  }
  const apiBase = { organizationId, profileId: scope.profileId ?? null };
  let data = null;
  let lastErr = null;
  const matchesExpectedVendor = (card) => {
    if (!expectedVendor) return true;
    const loaded = sanitizeWbVendorCode(card?.vendorCode ?? card?.vendor_code).toLowerCase();
    return loaded === expectedVendor.toLowerCase();
  };

  if (nmId) {
    try {
      const hit = await integrationsService.getWildberriesProductInfo({
        ...apiBase,
        nm_id: nmId,
        vendor_code: expectedVendor || vendorCodes[0] || undefined
      });
      if (hit && matchesExpectedVendor(hit)) data = hit;
      else if (hit && expectedVendor) {
        const err = new Error(
          `nmId ${nmId} в кабинете WB — другой товар (vendorCode «${sanitizeWbVendorCode(hit.vendorCode ?? hit.vendor_code) || '—'}»).`
        );
        err.statusCode = 404;
        throw err;
      } else if (hit) {
        data = hit;
      }
    } catch (e) {
      if (e?.statusCode === 404) throw e;
      lastErr = e;
    }
  }
  for (const vendorCode of vendorCodes) {
    if (data) break;
    try {
      const byVc = await integrationsService.getWildberriesProductByVendorCode(vendorCode, apiBase);
      if (!byVc?.nmId) continue;
      const hit = await integrationsService.getWildberriesProductInfo({
        ...apiBase,
        nm_id: byVc.nmId,
        vendor_code: vendorCode
      });
      if (hit && matchesExpectedVendor(hit)) data = hit;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) {
    if (lastErr) throw lastErr;
    const err = new Error(
      expectedVendor
        ? `Товар с vendorCode «${expectedVendor}» не найден в кабинете Wildberries.`
        : 'Товар не найден в кабинете Wildberries выбранной организации.'
    );
    err.statusCode = 404;
    throw err;
  }
  return data;
}

async function fetchYmCard(product, scope) {
  const organizationId = scope.organizationId;
  if (!organizationId) {
    const err = new Error('У товара не указана организация — нельзя запросить кабинет Яндекс.Маркета.');
    err.statusCode = 400;
    throw err;
  }
  const offerId = trimStr(product.sku_ym) || trimStr(product.sku);
  if (!offerId) {
    const err = new Error('Нет offerId Яндекс.Маркет / артикула ERP для запроса.');
    err.statusCode = 400;
    throw err;
  }
  const data = await integrationsService.getYandexProductInfo({
    offer_id: offerId,
    organizationId,
    profileId: scope.profileId ?? null
  });
  if (!data) {
    const err = new Error('Товар не найден в кабинете Яндекс.Маркета выбранной организации.');
    err.statusCode = 404;
    throw err;
  }
  return data;
}

async function filterBarcodesOwnedByOthers(productId, rows, existingProductBarcodes) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const codes = rows.map((r) => r?.barcode).filter(Boolean);
  if (!codes.length) return rows;
  // Уже привязанные к этому товару (включая внутренние) никогда не выкидываем
  const ownCodes = new Set(
    (Array.isArray(existingProductBarcodes) ? existingProductBarcodes : [])
      .map((r) => (typeof r === 'string' ? r : r?.barcode))
      .map((c) => (c != null ? String(c).trim() : ''))
      .filter(Boolean)
  );
  try {
    const r = await query(
      `SELECT barcode, product_id FROM barcodes WHERE barcode = ANY($1::text[])`,
      [codes]
    );
    const blocked = new Set(
      (r.rows || [])
        .filter((row) => row?.product_id != null && String(row.product_id) !== String(productId))
        .map((row) => String(row.barcode))
    );
    if (!blocked.size) return rows;
    const kept = rows.filter(
      (row) => ownCodes.has(String(row.barcode)) || !blocked.has(String(row.barcode))
    );
    const skipped = [...blocked].filter((bc) => !ownCodes.has(bc));
    if (skipped.length) {
      logger.warn('[CardPull] skip barcodes owned by other products', {
        productId,
        skipped,
      });
    }
    return kept;
  } catch (e) {
    logger.warn('[CardPull] barcode ownership check failed', { error: e?.message || String(e) });
    return rows;
  }
}

async function pullOneMarketplace(product, mp, opts = {}) {
  const organizationId = productOrgId(product);
  const scope = { organizationId, profileId: opts.profileId ?? null };
  let data;
  let updates;
  if (mp === 'ozon') {
    data = await fetchOzonCard(product, scope);
    updates = mapOzonCardToUpdates(product, data);
  } else if (mp === 'wb') {
    data = await fetchWbCard(product, scope);
    updates = mapWbCardToUpdates(product, data);
  } else if (mp === 'ym') {
    data = await fetchYmCard(product, scope);
    updates = mapYmCardToUpdates(product, data);
  } else {
    const err = new Error(`Неизвестный маркетплейс: ${mp}`);
    err.statusCode = 400;
    throw err;
  }

  if (updates?.barcodes) {
    const filtered = await filterBarcodesOwnedByOthers(
      product.id,
      updates.barcodes,
      product.barcodes
    );
    if (!filtered.length) {
      delete updates.barcodes;
    } else {
      updates.barcodes = filtered;
      const nextNorm = JSON.stringify(
        filtered.map((r) => ({
          barcode: r.barcode,
          marketplaces: [...(r.marketplaces || [])].sort(),
        }))
      );
      const existingNorm = JSON.stringify(
        (Array.isArray(product.barcodes) ? product.barcodes : [])
          .map((r) => ({
            barcode: typeof r === 'string' ? r : r?.barcode,
            marketplaces: [...((typeof r === 'object' && r?.marketplaces) || [])].sort(),
          }))
          .filter((r) => r.barcode)
      );
      if (nextNorm === existingNorm) delete updates.barcodes;
    }
  }

  const changedLabels = describeCardFieldChanges(product, updates);
  const fields = updates && Object.keys(updates).length > 0 ? Object.keys(updates) : [];
  if (fields.length > 0) {
  await productsService.update(product.id, updates, { profileId: opts.profileId ?? null });
  }

  let imagesSync = null;
  if (opts.skipImages !== true) {
    try {
      imagesSync = await importImagesFromMarketplaceCard(product.id, mp, data);
      if (imagesSync?.added > 0 || imagesSync?.enabled > 0) {
        if (!fields.includes('images')) fields.push('images');
        if (!changedLabels.includes('изображения')) changedLabels.push('изображения');
      }
    } catch (e) {
      logger.warn('[CardPull] images sync failed', {
        productId: product.id,
        mp,
        error: e?.message || String(e),
      });
      imagesSync = { error: e?.message || String(e) };
    }
  }

  if (opts.notifyChanges && changedLabels.length > 0) {
    await notifyCardFieldChanges(product, mp, changedLabels, {
      profileId: opts.profileId ?? product.profile_id ?? product.profileId ?? null,
    });
  }

  try {
    const marketplaceCardQualityService = (await import('./marketplaceCardQuality.service.js')).default;
    await marketplaceCardQualityService.persistFromFetchedItem(product.id, mp, data, {
      profileId: opts.profileId ?? product.profile_id ?? product.profileId ?? null,
      organizationId: organizationId || null,
    });
  } catch (e) {
    logger.warn('[CardPull] content rating persist failed', {
      productId: product.id,
      mp,
      error: e?.message || String(e),
    });
  }

  const profileIdForTask = opts.profileId ?? product.profile_id ?? product.profileId ?? null;
  if (profileIdForTask != null && changedLabels.length > 0) {
    try {
      await createDimensionsCheckTaskIfNeeded({
        profileId: profileIdForTask,
        product,
        marketplace: mp,
        changedLabels,
      });
    } catch (e) {
      logger.warn('[CardPull] dimensions task create failed', {
        productId: product.id,
        mp,
        error: e?.message || String(e),
      });
    }
  }

  return {
    marketplace: mp,
    ok: true,
    updated: fields.length > 0 || changedLabels.length > 0,
    fields,
    changedLabels,
    images: imagesSync
      ? {
          added: imagesSync.added ?? 0,
          enabled: imagesSync.enabled ?? 0,
          errors: imagesSync.errors || [],
          error: imagesSync.error || null,
        }
      : null,
  };
}

/**
 * Обновить карточку товара в ERP данными с маркетплейса(ов).
 * @param {number|string} productId
 * @param {string|string[]} marketplace
 * @param {{ profileId?: number|string|null }} [opts]
 */
export async function pullProductCard(productId, marketplace, opts = {}) {
  const mps = Array.isArray(marketplace)
    ? marketplace.flatMap((m) => normalizeMp(m))
    : normalizeMp(marketplace);
  const uniqueMps = [...new Set(mps)];
  // Важно: WithDetails — иначе product.barcodes = undefined и merge с МП
  // делает DELETE+INSERT только кодов с МП, затирая ШК с приёмки.
  const product = await productsService.getByIdWithDetails(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }
  if (!Array.isArray(product.barcodes)) {
    product.barcodes = [];
  }
  const results = [];
  for (const mp of uniqueMps) {
    try {
      results.push(await pullOneMarketplace(product, mp, opts));
      // после успешного апдейта подтягиваем свежий product для следующего МП
      const refreshed = await productsService.getByIdWithDetails(productId);
      if (refreshed) {
        Object.assign(product, refreshed);
        if (!Array.isArray(product.barcodes)) product.barcodes = [];
      }
    } catch (e) {
      results.push({
        marketplace: mp,
        ok: false,
        skipped: e?.skipped === true || e?.code === 'NO_OZON_LINK',
        error: e?.message || String(e)
      });
    }
  }
  return {
    productId: product.id,
    ok: results.every((r) => r.ok),
    results
  };
}

/**
 * Только изображения с МП → products.images (без обновления полей карточки).
 * @param {number|string} productId
 * @param {string} marketplace ozon|wb|ym
 * @param {{ profileId?: number|string|null }} [opts]
 */
export async function pullProductImagesOnly(productId, marketplace, opts = {}) {
  const mps = normalizeMp(marketplace);
  if (mps.length !== 1) {
    const err = new Error('Укажите один маркетплейс: ozon, wb или ym.');
    err.statusCode = 400;
    throw err;
  }
  const mp = mps[0];
  const product = await productsService.getById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }

  const organizationId = productOrgId(product);
  const scope = { organizationId, profileId: opts.profileId ?? null };
  let data;
  try {
    if (mp === 'ozon') data = await fetchOzonCard(product, scope);
    else if (mp === 'wb') data = await fetchWbCard(product, scope);
    else data = await fetchYmCard(product, scope);
  } catch (e) {
    return {
      productId: product.id,
      marketplace: mp,
      ok: false,
      skipped: e?.skipped === true || e?.code === 'NO_OZON_LINK',
      error: e?.message || String(e),
      added: 0,
      enabled: 0,
      images: Array.isArray(product.images) ? product.images : [],
    };
  }

  try {
    const imagesSync = await importImagesFromMarketplaceCard(product.id, mp, data);
    return {
      productId: product.id,
      marketplace: mp,
      ok: true,
      added: imagesSync?.added ?? 0,
      enabled: imagesSync?.enabled ?? 0,
      collapsed: imagesSync?.collapsed ?? 0,
      errors: imagesSync?.errors || [],
      images: imagesSync?.images ?? [],
    };
  } catch (e) {
    return {
      productId: product.id,
      marketplace: mp,
      ok: false,
      error: e?.message || String(e),
      added: 0,
      enabled: 0,
      images: Array.isArray(product.images) ? product.images : [],
    };
  }
}

/**
 * @param {{ productIds: Array<number|string>, marketplaces: string|string[] }} payload
 * @param {{ profileId?: number|string|null, notifyChanges?: boolean, skipImages?: boolean, concurrency?: number }} [opts]
 */
export async function pullProductCardsBulk(payload, opts = {}) {
  const ids = Array.isArray(payload?.productIds) ? payload.productIds : [];
  if (ids.length === 0) {
    const err = new Error('Укажите productIds');
    err.statusCode = 400;
    throw err;
  }
  if (ids.length > 500) {
    const err = new Error('Не больше 500 товаров за один запрос');
    err.statusCode = 400;
    throw err;
  }
  const mpRaw = payload.marketplaces ?? payload.marketplace ?? 'all';
  const mps = Array.isArray(mpRaw) ? mpRaw.flatMap((m) => normalizeMp(m)) : normalizeMp(mpRaw);
  const uniqueMps = [...new Set(mps)];

  // Массовый UI-pull: по умолчанию без скачивания картинок (это главный тормоз).
  // Ночная задача может явно передать skipImages: false.
  const skipImages = opts.skipImages !== false;
  const concurrency = Math.max(
    1,
    Math.min(12, Number(opts.concurrency ?? process.env.MP_CARD_PULL_BULK_CONCURRENCY ?? 6) || 6)
  );

  const pullOpts = { ...opts, skipImages };
  const items = new Array(ids.length);
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const i = cursor;
      cursor += 1;
      const productId = ids[i];
      try {
        items[i] = await pullProductCard(productId, uniqueMps, pullOpts);
    } catch (e) {
        items[i] = {
        productId,
        ok: false,
        results: uniqueMps.map((mp) => ({
          marketplace: mp,
          ok: false,
            error: e?.message || String(e),
          })),
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => worker());
  await Promise.all(workers);

  const success = items.filter((i) => i.ok).length;
  const skipped = items.filter(
    (i) => !i.ok && Array.isArray(i.results) && i.results.every((r) => r.ok || r.skipped)
  ).length;
  const failed = items.length - success - skipped;
  logger.info('[MP Card Pull] bulk done', {
    total: items.length,
    success,
    skipped,
    failed,
    marketplaces: uniqueMps,
    concurrency,
    skipImages,
  });
  return {
    total: items.length,
    success,
    skipped,
    failed,
    items,
  };
}

/**
 * Ежедневный импорт карточек для организаций с daily_pull_marketplace_cards=true.
 * При реальных изменениях полей — runtime-уведомление по товару.
 */
export async function pullDailyMarketplaceCardsForEnabledOrgs(opts = {}) {
  const delayMs = Math.max(
    0,
    Number(opts.delayMs ?? process.env.MP_CARD_PULL_DAILY_DELAY_MS ?? 250) || 250
  );
  const onlyProfileId =
    opts.profileId != null && Number.isFinite(Number(opts.profileId))
      ? Number(opts.profileId)
      : null;
  const orgRepo = repositoryFactory.getOrganizationsRepository();
  let orgs = (await orgRepo.findAll()).filter((o) => o.daily_pull_marketplace_cards === true);
  if (onlyProfileId != null) {
    orgs = orgs.filter((o) => Number(o.profile_id ?? o.profileId) === onlyProfileId);
  }
  if (orgs.length === 0) {
    logger.info('[MP Card Pull Daily] нет организаций с daily_pull_marketplace_cards=true', {
      profileId: onlyProfileId,
    });
    return { organizations: 0, products: 0, notified: 0, ok: 0, failed: 0 };
  }

  let productsTotal = 0;
  let notified = 0;
  let ok = 0;
  let failed = 0;

  for (const org of orgs) {
    const res = await query(
      `SELECT id, profile_id
         FROM products
        WHERE organization_id = $1
          AND COALESCE(is_archived, false) = false
        ORDER BY id`,
      [org.id]
    );
    const rows = res.rows || [];
    const profileId = org.profile_id ?? null;
    logger.info('[MP Card Pull Daily] org start', {
      organizationId: org.id,
      name: org.name,
      products: rows.length,
    });

    for (const row of rows) {
      productsTotal += 1;
      try {
        const out = await pullProductCard(row.id, 'all', {
          profileId: row.profile_id ?? profileId,
          notifyChanges: true,
        });
        const changed = (out.results || []).some(
          (r) => Array.isArray(r.changedLabels) && r.changedLabels.length > 0
        );
        if (changed) notified += 1;
        if (out.ok) ok += 1;
        else failed += 1;
      } catch (e) {
        failed += 1;
        logger.warn('[MP Card Pull Daily] product failed', {
          productId: row.id,
          error: e?.message || String(e),
        });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  logger.info('[MP Card Pull Daily] done', {
    organizations: orgs.length,
    products: productsTotal,
    notified,
    ok,
    failed,
  });
  return {
    organizations: orgs.length,
    products: productsTotal,
    notified,
    ok,
    failed,
  };
}

export { mapOzonCardToUpdates, mapWbCardToUpdates, mapYmCardToUpdates };

export default {
  pullProductCard,
  pullProductCardsBulk,
  pullProductImagesOnly,
  pullDailyMarketplaceCardsForEnabledOrgs,
};
