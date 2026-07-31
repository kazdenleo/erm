/**
 * Загрузка данных карточки товара с маркетплейсов в ERP (Ozon, WB, Яндекс.Маркет).
 * Маппинг полей согласован с ProductForm («Обновить данные с …»).
 */

import integrationsService from './integrations.service.js';
import productsService from './products.service.js';
import logger from '../utils/logger.js';
import { sanitizeWbVendorCode } from '../utils/wbVendorCode.js';
import { ymWeightDimensionsToErp } from '../utils/productMpFieldLinks.js';
import { WB_PACK_DIM_CHARC } from '../utils/marketplaceDimensions.js';
import {
  barcodesFromWbSizes,
  coerceBarcodeString,
} from '../utils/productBarcodes.js';
import { importImagesFromMarketplaceCard } from './marketplaceProductImages.service.js';
import { addRuntimeNotification } from '../utils/runtime-notifications.js';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';

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

async function notifyCardFieldChanges(product, mp, changedLabels) {
  if (!Array.isArray(changedLabels) || changedLabels.length === 0) return;
  const sku = trimStr(product?.sku) || `#${product?.id}`;
  const name = trimStr(product?.name);
  const mpTitle = MP_TITLE[mp] || String(mp || '').toUpperCase();
  const fieldsText = changedLabels.join(', ');
  await addRuntimeNotification({
    type: 'mp_card_field_changed',
    severity: 'warn',
    source: 'marketplace_card_pull',
    marketplace: mp,
    title: `Изменения карточки на ${mpTitle}`,
    message:
      `${sku}${name ? ` «${name.slice(0, 80)}»` : ''}: обновились поля (${fieldsText}).`,
    meta: {
      product_id: Number(product.id),
      marketplace: mp,
      fields: changedLabels,
      url: `/products?open=${product.id}`,
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
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeOzonAttrsFromCard(attrs, prev = {}) {
  const next = { ...prev };
  if (!Array.isArray(attrs)) return next;
  for (const a of attrs) {
    const id = a.attribute_id ?? a.id;
    if (id == null) continue;
    let val = null;
    if (Array.isArray(a.values) && a.values[0] != null) {
      const v = a.values[0];
      val = v.dictionary_value_id ?? v.value ?? v.id ?? v;
    } else {
      val = a.value ?? a.values;
    }
    next[String(id)] = val != null ? String(val) : '';
  }
  return next;
}

function mergeWbAttrsFromCard(characteristics, prev = {}) {
  const next = { ...prev };
  if (!Array.isArray(characteristics)) return next;
  for (const c of characteristics) {
    const id = c?.id ?? c?.characteristic_id ?? c?.charcID;
    const key = id != null ? String(id) : String(c?.name ?? c?.characteristic_name ?? '').trim();
    if (!key) continue;
    if (!isEmptyVal(next[key])) continue;
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
    const v0 = brandAttr?.values?.[0];
    if (v0) brand = trimStr(v0.value ?? v0.dictionary_value_id ?? v0.id ?? '');
  }
  if (name) updates.mp_ozon_name = name;
  if (description) updates.mp_ozon_description = description;
  if (brand) updates.mp_ozon_brand = brand;

  const offerIdFromOzon = trimStr(data.offer_id ?? data.sku);
  if (offerIdFromOzon) updates.sku_ozon = offerIdFromOzon;
  if (data.id != null && String(data.id).trim() !== '') {
    const n = Number(String(data.id).replace(/\D/g, '').slice(0, 19));
    if (Number.isFinite(n) && n > 0) updates.marketplace_ozon_product_id = n;
  }

  if (data.weight != null && isEmptyVal(product.weight)) {
    updates.weight = Number(data.weight);
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
  if (apiWidth != null && isEmptyVal(product.width)) updates.width = apiWidth;
  if (apiHeight != null && isEmptyVal(product.height)) updates.height = apiHeight;
  if (apiLength != null && isEmptyVal(product.length)) updates.length = apiLength;

  // Как WB: габариты упаковки в ozon_draft (для мин. цен без связи dimensions↔ozon)
  const erpLength = toPos(product.length);
  const erpWidth = toPos(product.width);
  const erpHeight = toPos(product.height);
  const erpWeight = toPos(product.weight);
  const draftLength = apiLength ?? erpLength;
  const draftWidth = apiWidth ?? erpWidth;
  const draftHeight = apiHeight ?? erpHeight;
  const draftWeight = apiWeight ?? erpWeight;
  if (draftLength != null || draftWidth != null || draftHeight != null || draftWeight != null) {
    const prevDraft = parseJsonObject(product.ozon_draft);
    const prevDims =
      prevDraft.dimensions && typeof prevDraft.dimensions === 'object' ? prevDraft.dimensions : {};
    updates.ozon_draft = {
      ...prevDraft,
      dimensions: {
        ...prevDims,
        ...(draftLength != null ? { length: draftLength } : {}),
        ...(draftWidth != null ? { width: draftWidth } : {}),
        ...(draftHeight != null ? { height: draftHeight } : {}),
        ...(draftWeight != null ? { weight: draftWeight } : {}),
      },
    };
  }

  const prevAttrs = parseJsonObject(product.ozon_attributes);
  const mergedAttrs = mergeOzonAttrsFromCard(attrs, prevAttrs);
  if (Object.keys(mergedAttrs).length > 0) {
    updates.ozon_attributes = mergedAttrs;
  }
  return updates;
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

  const barcodes = barcodesFromWbSizes(data.sizes);
  const prevBc = Array.isArray(product.barcodes) ? product.barcodes : [];
  const prevEmpty =
    prevBc.length === 0 ||
    prevBc.every((b) => !coerceBarcodeString(b?.barcode ?? b));
  if (barcodes.length > 0 && prevEmpty) {
    updates.barcodes = barcodes.map((b) => ({ barcode: b, marketplaces: [] }));
  }

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
  if (Object.keys(mergedAttrs).length > 0) {
    updates.wb_attributes = mergedAttrs;
  }
  return updates;
}

function mapYmCardToUpdates(product, data) {
  const updates = {};
  const resolvedOfferId = trimStr(data.offerId);
  const name = trimStr(data.name);
  const description = trimStr(data.description);
  if (resolvedOfferId) updates.sku_ym = resolvedOfferId;
  if (data.marketSku != null && String(data.marketSku).trim() !== '') {
    updates.ym_market_sku = String(data.marketSku).trim();
  }
  if (name) updates.mp_ym_name = name;
  if (description) updates.mp_ym_description = description;

  const vendor = trimStr(data.vendor);
  if (vendor && isEmptyVal(product.brand)) {
    updates.brand = vendor;
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
    const prevDraft = parseJsonObject(product.ym_draft);
    updates.ym_draft = {
      ...prevDraft,
      weightDimensions: {
        length: data.weightDimensions.length,
        width: data.weightDimensions.width,
        height: data.weightDimensions.height,
        ...(data.weightDimensions.weight != null ? { weight: data.weightDimensions.weight } : {}),
      },
    };
  }

  const prevAttrs = parseJsonObject(product.ym_attributes);
  const mergedAttrs = mergeYmAttrsFromCard(data.parameterValues, prevAttrs);
  if (Object.keys(mergedAttrs).length > 0) {
    updates.ym_attributes = mergedAttrs;
  }
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
  const changedLabels = describeCardFieldChanges(product, updates);
  const fields = updates && Object.keys(updates).length > 0 ? Object.keys(updates) : [];
  if (fields.length > 0) {
    await productsService.update(product.id, updates, { profileId: opts.profileId ?? null });
  }

  let imagesSync = null;
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

  if (opts.notifyChanges && changedLabels.length > 0) {
    await notifyCardFieldChanges(product, mp, changedLabels);
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
  const product = await productsService.getById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }
  const results = [];
  for (const mp of uniqueMps) {
    try {
      results.push(await pullOneMarketplace(product, mp, opts));
      // после успешного апдейта подтягиваем свежий product для следующего МП
      const refreshed = await productsService.getById(productId);
      if (refreshed) Object.assign(product, refreshed);
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
 * @param {{ productIds: Array<number|string>, marketplaces: string|string[] }} payload
 * @param {{ profileId?: number|string|null, notifyChanges?: boolean }} [opts]
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

  const items = [];
  for (const productId of ids) {
    try {
      const out = await pullProductCard(productId, uniqueMps, opts);
      items.push(out);
    } catch (e) {
      items.push({
        productId,
        ok: false,
        results: uniqueMps.map((mp) => ({
          marketplace: mp,
          ok: false,
          error: e?.message || String(e)
        }))
      });
    }
  }
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
    marketplaces: uniqueMps
  });
  return {
    total: items.length,
    success,
    skipped,
    failed,
    items
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
  const orgRepo = repositoryFactory.getOrganizationsRepository();
  const orgs = (await orgRepo.findAll()).filter((o) => o.daily_pull_marketplace_cards === true);
  if (orgs.length === 0) {
    logger.info('[MP Card Pull Daily] нет организаций с daily_pull_marketplace_cards=true');
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

export default {
  pullProductCard,
  pullProductCardsBulk,
  pullDailyMarketplaceCardsForEnabledOrgs,
};
