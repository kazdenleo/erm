/**
 * Обогащение карточки товара: PartsIndex + контент маркетплейсов.
 * Apply-режим пишет только в пустые поля Main-карточки ERP.
 */

import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import { getPartsIndexConfig, normalizePartsIndexKeys } from '../config/partsindex.config.js';
import { collectPartsIndexContent } from './partsindexEnrichment.js';
import { downloadImageToProductFolder } from './productImagesImport.service.js';
import {
  barcodeStringsFromProduct,
  normalizeBarcodeRows,
  barcodesFromOzonCard,
  barcodesFromWbSizes,
  barcodesFromYmCard,
} from '../utils/productBarcodes.js';
import { isProfileProductEnrichmentEnabled } from '../utils/profileProductEnrichment.js';
import integrationsService from './integrations.service.js';
import {
  extractMarketplaceImageUrls,
} from './marketplaceProductImages.service.js';
import { sanitizeWbVendorCode } from '../utils/wbVendorCode.js';
import {
  mapOzonCardToUpdates,
  mapWbCardToUpdates,
  mapYmCardToUpdates,
} from './marketplaceProductCardPull.service.js';
import { ymWeightDimensionsToErp } from '../utils/productMpFieldLinks.js';

const productsRepo = () => repositoryFactory.getProductsRepository();
const profilesRepo = () => repositoryFactory.getProfilesRepository();
const organizationsRepo = () => repositoryFactory.getOrganizationsRepository();

const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

/** Уникальные http(s) URL картинок (порядок сохраняем). */
function uniqImageUrls(rawList) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(rawList) ? rawList : []) {
    const url = String(typeof x === 'string' ? x : x?.url || '').trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** Имена ERP-атрибутов, куда пишем данные PartsIndex при обогащении. */
const ENRICHMENT_ATTR_ALIASES = {
  analogs: ['аналоги', 'analogs', 'analogues'],
  applicability: ['применимость', 'applicability'],
};

function normAttrName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function formatAnalogsAttrValue(analogs) {
  const codes = (Array.isArray(analogs) ? analogs : [])
    .map((a) => String(a?.code || a?.sku || a || '').trim())
    .filter(Boolean);
  return [...new Set(codes)].join(', ');
}

function formatApplicabilityLine(a) {
  if (!a || typeof a !== 'object') return String(a || '').trim();
  const head = [a.brand, a.model, a.modif, a.years].filter(Boolean).join(' ');
  const extra = [];
  if (a.body) extra.push(String(a.body));
  if (a.engCode) extra.push(`дв. ${a.engCode}`);
  return extra.length ? `${head}${head ? ' · ' : ''}${extra.join(' · ')}` : head;
}

function formatApplicabilityAttrValue(list) {
  const lines = (Array.isArray(list) ? list : [])
    .map(formatApplicabilityLine)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(lines)].join('\n');
}

async function findEnrichmentAttributeIds() {
  try {
    const result = await query('SELECT id, name FROM product_attributes');
    const byName = new Map();
    for (const row of result.rows || []) {
      const key = normAttrName(row.name);
      if (key && row.id != null) byName.set(key, String(row.id));
    }
    const pick = (aliases) => {
      for (const alias of aliases) {
        const id = byName.get(alias);
        if (id) return id;
      }
      return null;
    };
    return {
      analogsId: pick(ENRICHMENT_ATTR_ALIASES.analogs),
      applicabilityId: pick(ENRICHMENT_ATTR_ALIASES.applicability),
    };
  } catch (err) {
    return { analogsId: null, applicabilityId: null };
  }
}

async function ensureCategoryHasAttributes(categoryId, attrIds) {
  const cid = categoryId != null && categoryId !== '' ? Number(categoryId) : NaN;
  if (!Number.isFinite(cid)) return;
  for (const attrId of attrIds) {
    const aid = attrId != null && attrId !== '' ? Number(attrId) : NaN;
    if (!Number.isFinite(aid)) continue;
    try {
      await query(
        `INSERT INTO category_attributes (user_category_id, attribute_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [cid, aid]
      );
    } catch (_) {
      /* ignore */
    }
  }
}

function mergeEnrichmentAttributeValues(ids, analogs, applicability, existing = {}) {
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  const analogsVal = formatAnalogsAttrValue(analogs);
  const appVal = formatApplicabilityAttrValue(applicability);
  const isEmpty = (v) => v == null || String(v).trim() === '';
  if (ids.analogsId && analogsVal && isEmpty(out[ids.analogsId])) {
    out[ids.analogsId] = analogsVal;
  }
  if (ids.applicabilityId && appVal && isEmpty(out[ids.applicabilityId])) {
    out[ids.applicabilityId] = appVal;
  }
  return out;
}

function stripHtmlLoose(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseProductImages(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mpFlagOn(flags, mp) {
  if (!flags || typeof flags !== 'object') return false;
  return flags[mp] === true || flags[mp] === 1 || flags[mp] === '1' || flags[mp] === 'true';
}

/** URL реально с CDN маркетплейса (не локальный /uploads ERP). */
function isMarketplaceRemoteUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u || u.startsWith('/uploads/') || u.includes('/uploads/products/')) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  return (
    /ozone\.ru|ozon\.ru|ozonusercontent/i.test(u) ||
    /wbbasket\.ru|wildberries\.ru|wbstatic|wbcontent/i.test(u) ||
    /yandex\.(net|ru)|avatars\.mds\.yandex|market\.yandex/i.test(u)
  );
}

/**
 * Фото из ERP-галереи, которые реально пришли с МП (есть remote source_url).
 * Локальные /uploads с бейджами ozon/wb/ym — это не «скачанные с МП».
 */
function productMarketplaceRemoteImages(product, mp) {
  const images = parseProductImages(product?.images);
  const out = [];
  const seen = new Set();
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const flags = img.marketplaces && typeof img.marketplaces === 'object' ? img.marketplaces : null;
    if (flags && !mpFlagOn(flags, mp)) continue;
    const candidates = [
      img.source_url,
      ...(Array.isArray(img.source_urls) ? img.source_urls : []),
      img.url,
      img.href,
      img.src,
    ];
    const remote = candidates.map((x) => String(x || '').trim()).find((x) => isMarketplaceRemoteUrl(x));
    if (!remote || seen.has(remote)) continue;
    seen.add(remote);
    out.push(remote);
  }
  return out;
}

function emptyMpBucket() {
  return {
    ok: false,
    source: null,
    name: null,
    description: null,
    brand: null,
    weight: null,
    length: null,
    width: null,
    height: null,
    barcodes: [],
    attributes: [],
    images: [],
    error: null,
  };
}

function parseJsonObjectLoose(v) {
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

function attrsFromMpObject(obj) {
  const src = parseJsonObjectLoose(obj);
  const out = [];
  for (const [k, v] of Object.entries(src)) {
    if (v == null || v === '') continue;
    const value =
      typeof v === 'object' ? (() => { try { return JSON.stringify(v); } catch { return String(v); } })() : String(v);
    if (!String(value).trim()) continue;
    out.push({ name: String(k), value: String(value).trim() });
  }
  return out;
}

function dimsFromDraft(draft) {
  const d = parseJsonObjectLoose(draft);
  const dims =
    (d.dimensions && typeof d.dimensions === 'object' ? d.dimensions : null) ||
    (d.weightDimensions && typeof d.weightDimensions === 'object' ? d.weightDimensions : null) ||
    {};
  const toNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    length: toNum(dims.length),
    width: toNum(dims.width),
    height: toNum(dims.height),
    weight: toNum(dims.weight),
  };
}

function barcodeListFromUnknown(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return barcodeStringsFromProduct({ barcodes: raw });
  }
  return barcodeStringsFromProduct({ barcodes: [raw] });
}

function bucketHasContent(bucket) {
  if (!bucket) return false;
  return !!(
    bucket.name ||
    bucket.description ||
    bucket.brand ||
    bucket.weight != null ||
    bucket.length != null ||
    bucket.width != null ||
    bucket.height != null ||
    (bucket.barcodes && bucket.barcodes.length) ||
    (bucket.attributes && bucket.attributes.length) ||
    (bucket.images && bucket.images.length)
  );
}

function finalizeMpBucket(bucket, source) {
  if (bucketHasContent(bucket)) {
    bucket.ok = true;
    bucket.source = source;
  }
  return bucket;
}

function mpBucketFromStored(product, mp) {
  const bucket = emptyMpBucket();
  if (mp === 'ozon') {
    bucket.name = pickFirstNonEmpty(product.mp_ozon_name);
    bucket.description = pickFirstNonEmpty(product.mp_ozon_description);
    bucket.brand = pickFirstNonEmpty(product.mp_ozon_brand);
    bucket.attributes = attrsFromMpObject(product.ozon_attributes);
    const draftDims = dimsFromDraft(product.ozon_draft);
    bucket.length = draftDims.length;
    bucket.width = draftDims.width;
    bucket.height = draftDims.height;
    bucket.weight = draftDims.weight;
  } else if (mp === 'wb') {
    bucket.name = pickFirstNonEmpty(product.mp_wb_name);
    bucket.description = pickFirstNonEmpty(product.mp_wb_description);
    bucket.brand = pickFirstNonEmpty(product.mp_wb_brand);
    bucket.attributes = attrsFromMpObject(product.wb_attributes);
    const draftDims = dimsFromDraft(product.wb_draft);
    bucket.length = draftDims.length;
    bucket.width = draftDims.width;
    bucket.height = draftDims.height;
    bucket.weight = draftDims.weight;
  } else if (mp === 'ym') {
    bucket.name = pickFirstNonEmpty(product.mp_ym_name);
    bucket.description = pickFirstNonEmpty(product.mp_ym_description);
    bucket.attributes = attrsFromMpObject(product.ym_attributes);
    const draft = parseJsonObjectLoose(product.ym_draft);
    const fromYm = ymWeightDimensionsToErp(draft.weightDimensions) || dimsFromDraft(product.ym_draft);
    if (fromYm) {
      bucket.length = fromYm.length ?? null;
      bucket.width = fromYm.width ?? null;
      bucket.height = fromYm.height ?? null;
      bucket.weight = fromYm.weight ?? null;
    }
  }
  // Main ERP — запасной источник, если у МП уже есть текст/атрибуты (значит карточка МП велась)
  if (bucket.name || bucket.description || bucket.attributes.length) {
    if (bucket.weight == null && product.weight != null) bucket.weight = Number(product.weight) || product.weight;
    if (bucket.length == null && product.length != null) bucket.length = Number(product.length) || product.length;
    if (bucket.width == null && product.width != null) bucket.width = Number(product.width) || product.width;
    if (bucket.height == null && product.height != null) bucket.height = Number(product.height) || product.height;
    bucket.barcodes = barcodeStringsFromProduct(product);
  }
  bucket.images = productMarketplaceRemoteImages(product, mp).map((url) => ({ url, source: mp }));
  return finalizeMpBucket(bucket, 'stored');
}

function mpBucketFromOzonCard(card) {
  const bucket = emptyMpBucket();
  if (!card) return bucket;
  const updates = mapOzonCardToUpdates({}, card);
  bucket.name = pickFirstNonEmpty(updates.mp_ozon_name, card.name, card.title);
  bucket.description = pickFirstNonEmpty(
    updates.mp_ozon_description,
    stripHtmlLoose(card.description),
    stripHtmlLoose(card.description_html)
  );
  bucket.brand = pickFirstNonEmpty(updates.mp_ozon_brand, card.brand);
  bucket.weight = updates.weight ?? null;
  bucket.length = updates.length ?? null;
  bucket.width = updates.width ?? null;
  bucket.height = updates.height ?? null;
  bucket.barcodes = [
    ...new Set([
      ...barcodeListFromUnknown(updates.barcodes),
      ...barcodeListFromUnknown(barcodesFromOzonCard(card)),
    ]),
  ];
  bucket.attributes = attrsFromMpObject(updates.ozon_attributes);
  bucket.images = extractMarketplaceImageUrls('ozon', card).map((url) => ({ url, source: 'ozon' }));
  return finalizeMpBucket(bucket, 'live');
}

function mpBucketFromWbCard(card) {
  const bucket = emptyMpBucket();
  if (!card) return bucket;
  const updates = mapWbCardToUpdates({}, card);
  bucket.name = pickFirstNonEmpty(updates.mp_wb_name, card.title, card.name);
  bucket.description = pickFirstNonEmpty(
    updates.mp_wb_description,
    card.description,
    card.descriptionRu
  );
  bucket.brand = pickFirstNonEmpty(updates.mp_wb_brand, card.brand);
  const draftDims = dimsFromDraft(updates.wb_draft);
  bucket.weight = updates.weight ?? draftDims.weight;
  bucket.length = updates.length ?? draftDims.length;
  bucket.width = updates.width ?? draftDims.width;
  bucket.height = updates.height ?? draftDims.height;
  bucket.barcodes = [
    ...new Set([
      ...barcodeListFromUnknown(updates.barcodes),
      ...barcodeListFromUnknown(barcodesFromWbSizes(card.sizes)),
    ]),
  ];
  bucket.attributes = attrsFromMpObject(updates.wb_attributes);
  bucket.images = extractMarketplaceImageUrls('wb', card).map((url) => ({ url, source: 'wb' }));
  return finalizeMpBucket(bucket, 'live');
}

function mpBucketFromYmCard(card) {
  const bucket = emptyMpBucket();
  if (!card) return bucket;
  const updates = mapYmCardToUpdates({}, card);
  bucket.name = pickFirstNonEmpty(updates.mp_ym_name, card.name);
  bucket.description = pickFirstNonEmpty(updates.mp_ym_description, card.description);
  bucket.brand = pickFirstNonEmpty(updates.brand, card.vendor);
  const draftDims = dimsFromDraft(updates.ym_draft);
  const liveDims = ymWeightDimensionsToErp(card.weightDimensions);
  bucket.weight = updates.weight ?? liveDims?.weight ?? draftDims.weight;
  bucket.length = updates.length ?? liveDims?.length ?? draftDims.length;
  bucket.width = updates.width ?? liveDims?.width ?? draftDims.width;
  bucket.height = updates.height ?? liveDims?.height ?? draftDims.height;
  bucket.barcodes = [
    ...new Set([
      ...barcodeListFromUnknown(updates.barcodes),
      ...barcodeListFromUnknown(barcodesFromYmCard(card)),
    ]),
  ];
  bucket.attributes = attrsFromMpObject(updates.ym_attributes);
  bucket.images = extractMarketplaceImageUrls('ym', card).map((url) => ({ url, source: 'ym' }));
  return finalizeMpBucket(bucket, 'live');
}

/**
 * Заполнить пустые поля content данными с МП (Ozon → WB → YM).
 * Используется как fallback, когда PartsAPI пуст/недоступен.
 */
function applyMarketplaceFallbackToContent(content, marketplace) {
  if (!content || !marketplace) return { filled: [], sources: {} };
  const order = ['ozon', 'wb', 'ym'];
  const filled = [];
  const sources = {};

  const pickScalar = (field) => {
    for (const mp of order) {
      const b = marketplace[mp];
      if (!b?.ok) continue;
      const v = b[field];
      if (v != null && String(v).trim() !== '') return { value: v, mp };
    }
    return null;
  };

  const assignIfEmpty = (field, label) => {
    if (content[field] != null && String(content[field]).trim() !== '') return;
    const hit = pickScalar(field);
    if (!hit) return;
    content[field] = hit.value;
    sources[field] = hit.mp;
    filled.push(label || field);
  };

  assignIfEmpty('name');
  assignIfEmpty('description');
  assignIfEmpty('weight');
  assignIfEmpty('length');
  assignIfEmpty('width');
  assignIfEmpty('height');

  if (!content.attributes) content.attributes = [];
  const brandHit = pickScalar('brand');
  if (brandHit) {
    const hasBrand = content.attributes.some((a) => /бренд|brand/i.test(String(a.name || '')));
    if (!hasBrand) {
      content.attributes.push({ name: 'Бренд (МП)', value: String(brandHit.value) });
      sources.brand = brandHit.mp;
      filled.push('brand');
    }
  }

  // штрихкоды — объединяем
  const prevBc = Array.isArray(content.barcodes) ? content.barcodes : [];
  const bc = new Set(prevBc.map((x) => String(x)));
  let bcFrom = null;
  for (const mp of order) {
    const b = marketplace[mp];
    if (!b?.ok || !b.barcodes?.length) continue;
    for (const code of b.barcodes) {
      if (!code) continue;
      const s = String(code);
      if (!bc.has(s)) {
        bc.add(s);
        bcFrom = bcFrom || mp;
      }
    }
  }
  if (bc.size > prevBc.length) {
    content.barcodes = [...bc];
    if (bcFrom) sources.barcodes = bcFrom;
    filled.push('barcodes');
  }

  // атрибуты — дополняем уникальными
  if (!content.attributes) content.attributes = [];
  const seenAttr = new Set(content.attributes.map((a) => `${a.name}`.toLowerCase()));
  const prevAttrCount = content.attributes.length;
  let attrFrom = null;
  for (const mp of order) {
    const b = marketplace[mp];
    if (!b?.ok || !b.attributes?.length) continue;
    for (const a of b.attributes) {
      const k = String(a.name || '').toLowerCase();
      if (!k || seenAttr.has(k)) continue;
      content.attributes.push({ name: a.name, value: a.value });
      seenAttr.add(k);
      attrFrom = attrFrom || mp;
    }
  }
  if (content.attributes.length > prevAttrCount) {
    sources.attributes = attrFrom;
    filled.push('attributes');
  }

  // описание из атрибутов, если текста нет
  if (!content.description && content.attributes.length) {
    content.description = content.attributes.map((a) => `${a.name}: ${a.value}`).join('\n');
    if (!sources.description) sources.description = attrFrom || sources.attributes || 'mp';
    filled.push('description');
  }

  content.fieldSources = { ...(content.fieldSources || {}), ...sources };
  return { filled: [...new Set(filled)], sources };
}

/**
 * Контент карточек Ozon/WB/YM для brand+sku (без записи в ERP).
 * 1) Если есть товар в ERP — live по привязкам, иначе уже сохранённые mp_* / images.
 * 2) Если товара нет — пробуем offer_id / vendorCode = артикул по организациям профиля.
 */
async function collectMarketplaceContent(brand, sku, profileId) {
  const warnings = [];
  const steps = [];
  const marketplace = {
    ozon: emptyMpBucket(),
    wb: emptyMpBucket(),
    ym: emptyMpBucket(),
  };

  let product = null;
  try {
    const hit = await productsRepo().findBySkuAndBrand(sku, brand, { profileId });
    if (hit?.id) {
      product = await productsRepo().findById(hit.id);
    }
  } catch (err) {
    warnings.push(`ERP lookup: ${err?.message || err}`);
  }

  const orgIdFromProduct =
    product?.organization_id != null && String(product.organization_id).trim() !== ''
      ? String(product.organization_id).trim()
      : null;

  let orgs = [];
  try {
    orgs = await organizationsRepo().findAll({ profileId });
  } catch {
    orgs = [];
  }
  const orgIds = [
    ...new Set(
      [orgIdFromProduct, ...(orgs || []).map((o) => (o?.id != null ? String(o.id) : null))]
        .filter(Boolean)
    ),
  ];

  const tryOrgs = async (fn) => {
    let lastErr = null;
    for (const organizationId of orgIds) {
      try {
        const hit = await fn(organizationId);
        if (hit) return hit;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  };

  // --- Ozon ---
  try {
    let card = null;
    if (product) {
      const ozonPid =
        product.ozon_product_id != null
          ? Number(product.ozon_product_id)
          : product.marketplace_ozon_product_id != null
            ? Number(product.marketplace_ozon_product_id)
            : null;
      const offerIds = [
        ...new Set(
          [product.sku_ozon, product.marketplace_skus?.ozon]
            .map((v) => String(v || '').trim().replace(/;+\s*$/g, ''))
            .filter(Boolean)
        ),
      ];
      if ((ozonPid && ozonPid > 0) || offerIds.length) {
        card = await tryOrgs(async (organizationId) => {
          if (ozonPid && ozonPid > 0) {
            const byId = await integrationsService.getOzonProductInfo({
              product_id: ozonPid,
              organizationId,
              profileId,
            });
            if (byId) return byId;
          }
          for (const offer_id of offerIds) {
            const byOffer = await integrationsService.getOzonProductInfo({
              offer_id,
              organizationId,
              profileId,
            });
            if (byOffer) return byOffer;
          }
          return null;
        });
      }
    }
    if (!card && sku && orgIds.length) {
      // Без ERP: пробуем артикул как offer_id продавца
      try {
        card = await tryOrgs((organizationId) =>
          integrationsService.getOzonProductInfo({ offer_id: sku, organizationId, profileId })
        );
      } catch {
        /* ниже stored/none */
      }
    }
    if (card) {
      marketplace.ozon = mpBucketFromOzonCard(card);
      steps.push({ method: 'marketplace:ozon', ok: true, source: 'live' });
    } else if (product) {
      marketplace.ozon = mpBucketFromStored(product, 'ozon');
      steps.push({
        method: 'marketplace:ozon',
        ok: marketplace.ozon.ok,
        source: marketplace.ozon.source || 'none',
      });
      if (!marketplace.ozon.ok) {
        marketplace.ozon.error = 'Нет привязки/карточки Ozon и сохранённого контента';
      }
    } else {
      marketplace.ozon.error = 'Нет товара ERP и карточки Ozon по offer_id=артикул';
      steps.push({ method: 'marketplace:ozon', ok: false, source: 'none' });
    }
  } catch (err) {
    if (product) marketplace.ozon = mpBucketFromStored(product, 'ozon');
    if (!marketplace.ozon.ok) {
      marketplace.ozon.error = err?.message || String(err);
      warnings.push(`Ozon: ${marketplace.ozon.error}`);
    } else {
      warnings.push(`Ozon live: ${err?.message || err} — взяты сохранённые данные`);
    }
    steps.push({
      method: 'marketplace:ozon',
      ok: marketplace.ozon.ok,
      source: marketplace.ozon.source || 'error',
      error: err?.message || String(err),
    });
  }

  // --- WB ---
  try {
    let card = null;
    if (product) {
      const skuWbRaw = String(product.sku_wb || '').trim();
      const nmId = skuWbRaw && /^\d+$/.test(skuWbRaw) ? Number(skuWbRaw) : null;
      const vendorCodes = [
        ...new Set(
          [product.mp_wb_vendor_code, skuWbRaw && !nmId ? skuWbRaw : null, product.sku]
            .map((v) => sanitizeWbVendorCode(v))
            .filter(Boolean)
        ),
      ];
      if (nmId || vendorCodes.length) {
        card = await tryOrgs(async (organizationId) => {
          if (nmId) {
            const byNm = await integrationsService.getWildberriesProductInfo({
              nm_id: nmId,
              vendor_code: vendorCodes[0] || undefined,
              organizationId,
              profileId,
            });
            if (byNm) return byNm;
          }
          for (const vendorCode of vendorCodes) {
            const byVc = await integrationsService.getWildberriesProductByVendorCode(vendorCode, {
              organizationId,
              profileId,
            });
            if (!byVc?.nmId) continue;
            const full = await integrationsService.getWildberriesProductInfo({
              nm_id: byVc.nmId,
              vendor_code: vendorCode,
              organizationId,
              profileId,
            });
            if (full) return full;
          }
          return null;
        });
      }
    }
    if (!card && sku && orgIds.length) {
      try {
        card = await tryOrgs(async (organizationId) => {
          const vendorCode = sanitizeWbVendorCode(sku);
          if (!vendorCode) return null;
          const byVc = await integrationsService.getWildberriesProductByVendorCode(vendorCode, {
            organizationId,
            profileId,
          });
          if (!byVc?.nmId) return null;
          return integrationsService.getWildberriesProductInfo({
            nm_id: byVc.nmId,
            vendor_code: vendorCode,
            organizationId,
            profileId,
          });
        });
      } catch {
        /* ignore */
      }
    }
    if (card) {
      marketplace.wb = mpBucketFromWbCard(card);
      steps.push({ method: 'marketplace:wb', ok: true, source: 'live' });
    } else if (product) {
      marketplace.wb = mpBucketFromStored(product, 'wb');
      steps.push({
        method: 'marketplace:wb',
        ok: marketplace.wb.ok,
        source: marketplace.wb.source || 'none',
      });
      if (!marketplace.wb.ok) {
        marketplace.wb.error = 'Нет привязки/карточки WB и сохранённого контента';
      }
    } else {
      marketplace.wb.error = 'Нет товара ERP и карточки WB по vendorCode=артикул';
      steps.push({ method: 'marketplace:wb', ok: false, source: 'none' });
    }
  } catch (err) {
    if (product) marketplace.wb = mpBucketFromStored(product, 'wb');
    if (!marketplace.wb.ok) {
      marketplace.wb.error = err?.message || String(err);
      warnings.push(`WB: ${marketplace.wb.error}`);
    } else {
      warnings.push(`WB live: ${err?.message || err} — взяты сохранённые данные`);
    }
    steps.push({
      method: 'marketplace:wb',
      ok: marketplace.wb.ok,
      source: marketplace.wb.source || 'error',
      error: err?.message || String(err),
    });
  }

  // --- YM ---
  try {
    let card = null;
    const offerCandidates = [
      ...new Set(
        [product?.sku_ym, product?.sku, !product ? sku : null]
          .map((v) => String(v || '').trim())
          .filter(Boolean)
      ),
    ];
    if (offerCandidates.length && orgIds.length) {
      card = await tryOrgs(async (organizationId) => {
        for (const offer_id of offerCandidates) {
          const hit = await integrationsService.getYandexProductInfo({
            offer_id,
            organizationId,
            profileId,
          });
          if (hit) return hit;
        }
        return null;
      });
    }
    if (card) {
      marketplace.ym = mpBucketFromYmCard(card);
      steps.push({ method: 'marketplace:ym', ok: true, source: 'live' });
    } else if (product) {
      marketplace.ym = mpBucketFromStored(product, 'ym');
      steps.push({
        method: 'marketplace:ym',
        ok: marketplace.ym.ok,
        source: marketplace.ym.source || 'none',
      });
      if (!marketplace.ym.ok) {
        marketplace.ym.error = 'Нет привязки/карточки YM и сохранённого контента';
      }
    } else {
      marketplace.ym.error = 'Нет товара ERP и карточки YM по offerId=артикул';
      steps.push({ method: 'marketplace:ym', ok: false, source: 'none' });
    }
  } catch (err) {
    if (product) marketplace.ym = mpBucketFromStored(product, 'ym');
    if (!marketplace.ym.ok) {
      marketplace.ym.error = err?.message || String(err);
      warnings.push(`YM: ${marketplace.ym.error}`);
    } else {
      warnings.push(`YM live: ${err?.message || err} — взяты сохранённые данные`);
    }
    steps.push({
      method: 'marketplace:ym',
      ok: marketplace.ym.ok,
      source: marketplace.ym.source || 'error',
      error: err?.message || String(err),
    });
  }

  const marketplaceImages = [];
  const seenImg = new Set();
  for (const mp of ['ozon', 'wb', 'ym']) {
    for (const img of marketplace[mp].images || []) {
      const url = img?.url || (typeof img === 'string' ? img : '');
      if (!url || seenImg.has(url)) continue;
      // В блок «фото МП» не кладём локальные uploads ERP
      if (!isMarketplaceRemoteUrl(url) && marketplace[mp].source !== 'live') continue;
      if (!isMarketplaceRemoteUrl(url) && !/^https?:\/\//i.test(url)) continue;
      seenImg.add(url);
      marketplaceImages.push({ url, source: mp, kind: MP_LABELS[mp] });
    }
  }

  const hasAnyLink = !!(
    product &&
    (product.sku_ozon ||
      product.ozon_product_id ||
      product.marketplace_ozon_product_id ||
      product.sku_wb ||
      product.mp_wb_vendor_code ||
      product.sku_ym)
  );
  if (product && !hasAnyLink) {
    warnings.push(
      `ERP #${product.id}: нет привязок к Ozon/WB/YM — фото с кабинетов не запрашивались. Укажите организацию и артикулы МП, затем «Обновить данные с …» на карточке товара.`
    );
  } else if (product && !marketplaceImages.length) {
    const liveOk = ['ozon', 'wb', 'ym'].some((mp) => marketplace[mp].source === 'live');
    if (!liveOk) {
      warnings.push(
        `ERP #${product.id}: live с кабинетов не удалось; в ERP нет remote-фото с CDN МП (локальная галерея не считается).`
      );
    }
  }

  const filled = [];
  if (marketplaceImages.length) filled.push('mp_images');
  if (['ozon', 'wb', 'ym'].some((mp) => marketplace[mp].name)) filled.push('mp_name');
  if (['ozon', 'wb', 'ym'].some((mp) => marketplace[mp].description)) filled.push('mp_description');
  if (['ozon', 'wb', 'ym'].some((mp) => marketplace[mp].weight != null)) filled.push('mp_weight');
  if (
    ['ozon', 'wb', 'ym'].some(
      (mp) =>
        marketplace[mp].length != null ||
        marketplace[mp].width != null ||
        marketplace[mp].height != null
    )
  ) {
    filled.push('mp_dimensions');
  }
  if (['ozon', 'wb', 'ym'].some((mp) => marketplace[mp].barcodes?.length)) filled.push('mp_barcodes');
  if (['ozon', 'wb', 'ym'].some((mp) => marketplace[mp].attributes?.length)) filled.push('mp_attributes');

  const ok = filled.length > 0;
  return {
    ok,
    productId: product?.id ?? null,
    marketplace,
    marketplaceImages,
    filled,
    warnings,
    steps,
    status: ok ? 'partial' : 'not_found',
  };
}

function normToken(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9А-ЯЁ]/gi, '')
    .replace(/Ё/g, 'Е');
}

function isBlank(v) {
  return v == null || String(v).trim() === '';
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (!isBlank(v)) return String(v).trim();
  }
  return null;
}

function parseNumberLoose(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(',', '.').replace(/[^\d.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Вес → граммы */
function weightToGrams(value, unit) {
  const n = parseNumberLoose(value);
  if (n == null) return null;
  const u = String(unit || '').trim().toLowerCase();
  if (!u || u === 'g' || u === 'гр' || u === 'грамм' || u === 'граммов' || u.includes('грамм')) {
    return Math.round(n);
  }
  if (u === 'kg' || u === 'кг' || u.includes('кило')) {
    return Math.round(n * 1000);
  }
  if (u === 'mg' || u === 'мг') return Math.max(1, Math.round(n / 1000));
  // неизвестная единица — если число большое, считаем граммами; если < 50 — кг
  return n < 50 ? Math.round(n * 1000) : Math.round(n);
}

/** Длина → мм */
function lengthToMm(value, unitHint = '') {
  const n = parseNumberLoose(value);
  if (n == null) return null;
  const u = String(unitHint || '').toLowerCase();
  if (u.includes('см') || u === 'cm') return Math.round(n * 10);
  if (u.includes('м') && !u.includes('мм') && !u.includes('см')) return Math.round(n * 1000);
  if (u.includes('мм') || u === 'mm') return Math.round(n);
  // эвристика: < 20 → см, иначе мм
  return n > 0 && n < 20 ? Math.round(n * 10) : Math.round(n);
}

function criteriaMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const name = String(row.CRITERIA_NAME || row.criteria_name || row.name || '').trim();
    const value = String(row.CRITERIA_VALUE || row.criteria_value || row.value || '').trim();
    if (!name || !value) continue;
    map.set(name.toLowerCase(), { name, value });
  }
  return map;
}

function findCriteria(map, predicates) {
  for (const [key, item] of map.entries()) {
    if (predicates.some((fn) => fn(key, item))) return item;
  }
  return null;
}

function brandScore(productBrand, candidateBrand) {
  const a = normToken(productBrand);
  const b = normToken(candidateBrand);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  // частичное совпадение по префиксу
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 3 && (a.startsWith(b.slice(0, minLen)) || b.startsWith(a.slice(0, minLen)))) {
    return 50;
  }
  return 0;
}

function pickSearchMatch(rows, brand, sku) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const skuN = normToken(sku);
  const scored = list
    .map((row) => {
      const artNr = row.ART_ARTICLE_NR || row.art_article_nr || '';
      const brandName = row.ART_SUP_BRAND || row.art_sup_brand || '';
      const artScore = skuN && normToken(artNr) === skuN ? 40 : skuN && normToken(artNr).includes(skuN) ? 15 : 0;
      const bScore = brandScore(brand, brandName);
      return { row, score: artScore + bScore };
    })
    .sort((x, y) => y.score - x.score);

  const best = scored[0];
  if (!best || best.score < 40) return { match: null, candidates: scored.slice(0, 5) };
  const close = scored.filter((s) => s.score >= best.score - 5 && s.score >= 40);
  if (close.length > 1 && close[1].score === best.score) {
    return { match: null, candidates: close.slice(0, 5), ambiguous: true };
  }
  return { match: best.row, candidates: scored.slice(0, 5) };
}

function buildDescriptionFromCriteria(map, existing) {
  if (!isBlank(existing)) return null;
  const lines = [];
  for (const { name, value } of map.values()) {
    lines.push(`${name}: ${value}`);
  }
  if (!lines.length) return null;
  return lines.slice(0, 40).join('\n');
}

function extractDimsAndWeightFromCriteria(map) {
  const out = {};
  const lengthItem = findCriteria(map, [
    (k) => k.includes('длина') || k === 'length' || k.includes('length'),
  ]);
  const widthItem = findCriteria(map, [
    (k) => k.includes('ширина') || k === 'width' || k.includes('width'),
  ]);
  const heightItem = findCriteria(map, [
    (k) => k.includes('высота') || k.includes('толщина') || k === 'height' || k.includes('height'),
  ]);
  const weightItem = findCriteria(map, [
    (k) => k.includes('вес') || k.includes('масса') || k.includes('weight'),
  ]);

  if (lengthItem) out.length = lengthToMm(lengthItem.value, lengthItem.name + ' ' + lengthItem.value);
  if (widthItem) out.width = lengthToMm(widthItem.value, widthItem.name + ' ' + widthItem.value);
  if (heightItem) out.height = lengthToMm(heightItem.value, heightItem.name + ' ' + heightItem.value);
  if (weightItem) {
    out.weight = weightToGrams(weightItem.value, weightItem.name + ' ' + weightItem.value);
  }
  return out;
}

function extractEans(rows) {
  const out = [];
  for (const row of rows || []) {
    const candidates = [
      row.EAN,
      row.ean,
      row.EAN13,
      row.ean13,
      row.barcode,
      row.BARCODE,
      row.number,
      row.NUMBER,
      typeof row === 'string' || typeof row === 'number' ? row : null,
    ];
    for (const c of candidates) {
      const s = String(c || '').replace(/\D/g, '');
      if (s.length >= 8 && s.length <= 14) out.push(s);
    }
  }
  return [...new Set(out)];
}

async function ensureEnrichmentAllowed(profileId) {
  if (profileId == null) {
    const err = new Error('Обогащение доступно только в контексте аккаунта');
    err.statusCode = 403;
    throw err;
  }
  const profile = await profilesRepo().findById(profileId);
  if (!isProfileProductEnrichmentEnabled(profile)) {
    const err = new Error('Модуль обогащения выключен в настройках аккаунта');
    err.statusCode = 403;
    throw err;
  }
  return profile;
}

/**
 * @param {string|number} productId
 * @param {{ profileId: number|string, apply?: boolean, dryRun?: boolean }} opts
 */
export async function enrichProductById(productId, opts = {}) {
  const apply = opts.apply !== false && opts.dryRun !== true;
  const profile = await ensureEnrichmentAllowed(opts.profileId);
  const profileKeys = normalizePartsIndexKeys(profile.partsindex_keys);

  const product = await productsRepo().findById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }

  const sku = String(product.sku || '').trim();
  const brand = String(product.brand || product.brand_name || '').trim();
  if (!sku) {
    const err = new Error('У товара нет артикула (SKU)');
    err.statusCode = 400;
    throw err;
  }
  if (!brand) {
    const err = new Error('У товара не указан бренд');
    err.statusCode = 400;
    throw err;
  }

  let parts;
  try {
    parts = await collectPartsIndexContent(brand, sku, profileKeys);
  } catch (err) {
    const e = new Error(err?.message || String(err));
    e.statusCode = err?.statusCode || err?.status || 502;
    throw e;
  }

  const content = parts.content || {};
  const steps = [...(parts.steps || [])];
  const warnings = [...(parts.warnings || [])];
  const patch = {};
  const filled = [];
  const skipped = [];
  const entityId = parts.entityId || null;
  const matchedBrand = parts.matchedBrand || null;
  const matchedNumber = parts.matchedNumber || null;

  if (content.name) {
    if (isBlank(product.name)) {
      patch.name = content.name;
      filled.push('name');
    } else skipped.push('name');
  }
  if (content.description) {
    if (isBlank(product.description)) {
      patch.description = content.description;
      filled.push('description');
    } else skipped.push('description');
  }
  for (const field of ['weight', 'length', 'width', 'height']) {
    if (content[field] != null) {
      if (isBlank(product[field]) || Number(product[field]) === 0) {
        patch[field] = content[field];
        filled.push(field);
      } else skipped.push(field);
    }
  }

  let newBarcodes = null;
  if (content.barcodes?.length) {
    const existing = barcodeStringsFromProduct(product.barcodes || []);
    const toAdd = content.barcodes.filter((e) => !existing.includes(String(e)));
    if (toAdd.length) {
      newBarcodes = normalizeBarcodeRows([
        ...normalizeBarcodeRows(product.barcodes || []),
        ...toAdd.map((barcode) => ({ barcode, marketplaces: [] })),
      ]);
      filled.push('barcodes');
    } else skipped.push('barcodes');
  }

  let imagesAdded = 0;
  let nextImages = null;
  const imageUrls = uniqImageUrls(content.images || []);
  const existingImages = Array.isArray(product.images) ? product.images : [];
  if (imageUrls.length) {
    if (existingImages.length > 0) {
      skipped.push('images');
    } else if (apply) {
      const downloaded = [];
      const seenHashes = new Set();
      for (let i = 0; i < Math.min(imageUrls.length, 8); i++) {
        try {
          const rec = await downloadImageToProductFolder(product.id, imageUrls[i], {
            primary: downloaded.length === 0,
            marketplaces: { ozon: true, wb: true, ym: true },
          });
          if (!rec) continue;
          const hash = String(rec.content_hash || rec.contentHash || '').toLowerCase();
          if (hash && seenHashes.has(hash)) continue;
          if (hash) seenHashes.add(hash);
          downloaded.push(rec);
        } catch (imgErr) {
          warnings.push(`image ${i + 1}: ${imgErr?.message || imgErr}`);
        }
      }
      if (downloaded.length) {
        downloaded.forEach((d, i) => {
          d.primary = i === 0;
        });
        nextImages = downloaded;
        imagesAdded = downloaded.length;
        filled.push('images');
      }
    } else {
      imagesAdded = imageUrls.length;
      filled.push('images');
    }
  }

  const status =
    parts.status ||
    (filled.length >= 3 ? 'full' : filled.length ? 'partial' : 'not_found');

  const enrichmentMeta = {
    enrichment_status: status,
    enrichment_source: 'partsindex',
    enrichment_art_id: entityId,
    enrichment_matched_brand: matchedBrand,
    enrichment_matched_number: matchedNumber,
    enriched_at: new Date().toISOString(),
    enrichment_payload: {
      steps,
      warnings,
      filled,
      skipped,
      analogs: content.analogs || [],
      applicability: content.applicability || [],
    },
  };

  let updated = product;
  if (apply) {
    const attrIds = await findEnrichmentAttributeIds();
    const existingAv =
      product.attribute_values && typeof product.attribute_values === 'object'
        ? { ...product.attribute_values }
        : {};
    const nextAttrValues = mergeEnrichmentAttributeValues(
      attrIds,
      content.analogs || [],
      content.applicability || [],
      existingAv
    );
    const attrChanged =
      (attrIds.analogsId &&
        String(nextAttrValues[attrIds.analogsId] || '') !== String(existingAv[attrIds.analogsId] || '')) ||
      (attrIds.applicabilityId &&
        String(nextAttrValues[attrIds.applicabilityId] || '') !==
          String(existingAv[attrIds.applicabilityId] || ''));
    if (attrChanged) filled.push('erp_attributes');

    const updates = {
      ...patch,
      ...enrichmentMeta,
    };
    if (newBarcodes) updates.barcodes = newBarcodes;
    if (nextImages) updates.images = nextImages;
    if (attrChanged) {
      updates.attribute_values = nextAttrValues;
      const categoryId = product.categoryId ?? product.user_category_id;
      await ensureCategoryHasAttributes(categoryId, [attrIds.analogsId, attrIds.applicabilityId]);
    }
    updated = await productsRepo().update(product.id, updates);
  }

  return {
    product: updated,
    preview: {
      patch,
      barcodes: newBarcodes,
      imagesAdded,
      status,
      entityId,
      artId: entityId,
      matchedBrand,
      matchedNumber,
      filled,
      skipped,
      warnings,
      steps,
      configured: getPartsIndexConfig(profileKeys).configured,
    },
  };
}

export async function getEnrichmentStatusForProfile(profileId) {
  const profile = profileId != null ? await profilesRepo().findById(profileId) : null;
  const profileKeys = normalizePartsIndexKeys(profile?.partsindex_keys);
  const cfg = getPartsIndexConfig(profileKeys);
  return {
    enabled: isProfileProductEnrichmentEnabled(profile),
    provider: 'partsindex',
    configured: cfg.configured,
    configuredMethods: cfg.configured ? ['apiKey'] : [],
    missingMethods: cfg.configured ? [] : ['apiKey'],
  };
}

/** Убрать BigInt / циклы / несериализуемое перед res.json */
function jsonSafe(value, seen = new WeakSet(), depth = 0) {
  if (value == null) return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[MaxDepth]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => jsonSafe(v, seen, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const safe = jsonSafe(v, seen, depth + 1);
    if (safe !== undefined) out[k] = safe;
  }
  return out;
}

function safeJsonString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Массовый сбор контента по списку { brand, sku }:
 * только PartsIndex (entities / relations / cars).
 * Товары в ERP не создаются и не обновляются — только превью.
 * @param {Array<{ brand?: string, sku?: string }>} items
 * @param {{ profileId: number|string }} opts
 */
export async function enrichProductsByBrandSkuList(items, opts = {}) {
  const profile = await ensureEnrichmentAllowed(opts.profileId);
  const profileKeys = normalizePartsIndexKeys(profile.partsindex_keys);
  const list = Array.isArray(items) ? items : [];
  const results = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const brand = String(raw.brand || '').trim();
    const sku = String(raw.sku || raw.article || raw.number || '').trim();
    const row = { index: i + 1, brand, sku, ok: false };

    if (!sku || !brand) {
      row.error = 'Нужны бренд и артикул';
      results.push(row);
      continue;
    }

    let parts = null;
    let partsError = null;
    try {
      parts = await collectPartsIndexContent(brand, sku, profileKeys);
    } catch (err) {
      partsError = err?.message || String(err);
    }

    const content = parts?.content
      ? { ...parts.content }
      : {
          name: null,
          description: null,
          info: null,
          statusText: null,
          packUnit: null,
          quantityPerUnit: null,
          weight: null,
          length: null,
          width: null,
          height: null,
          barcodes: [],
          oemNumbers: [],
          images: [],
          documents: [],
          links: [],
          media360: [],
          attributes: [],
          searchHits: [],
          article: null,
          applicability: [],
          analogs: [],
          rawByMethod: {},
        };

    const filled = [...new Set([...(parts?.filled || [])])];
    const warnings = [...(parts?.warnings || [])];
    if (partsError) warnings.push(`PartsIndex: ${partsError}`);

    const methodsUsed = [...(parts?.methodsUsed || [])];
    const steps = [...(parts?.steps || [])];

    row.ok = !!parts;
    row.filled = filled;
    row.warnings = warnings;
    row.matchedBrand = parts?.matchedBrand ?? null;
    row.matchedNumber = parts?.matchedNumber ?? null;
    row.entityId = parts?.entityId ?? null;
    row.artId = parts?.entityId ?? null;
    row.methodsUsed = methodsUsed;
    row.steps = jsonSafe(steps);
    row.name = content.name || null;
    row.content = jsonSafe(content);

    if (!row.ok) {
      row.error = partsError || 'Не найдено в PartsIndex';
      row.status = 'error';
      results.push(row);
      continue;
    }

    row.status = parts.status;
    results.push(row);
  }

  const okCount = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    mode: 'collect',
    results,
  };
}

/**
 * Создать карточки товаров из собранного контента PartsIndex.
 * @param {Array<object>} items
 * @param {{ profileId: number|string }} opts
 */
export async function createProductsFromEnrichmentItems(items, opts = {}) {
  await ensureEnrichmentAllowed(opts.profileId);
  const productsService = (await import('./products.service.js')).default;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const e = new Error('Нет позиций для создания');
    e.statusCode = 400;
    throw e;
  }
  if (list.length > 200) {
    const e = new Error('За один раз не больше 200 товаров');
    e.statusCode = 400;
    throw e;
  }

  const results = [];
  const attrIds = await findEnrichmentAttributeIds();
  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const brandName = String(raw.brand || raw.matchedBrand || '').trim();
    const sku = String(raw.sku || raw.matchedNumber || '').trim();
    const name = String(raw.name || '').trim() || sku;
    const row = { index: i + 1, brand: brandName, sku, ok: false };

    if (!sku || !name) {
      row.error = 'Нужны артикул и название';
      results.push(row);
      continue;
    }

    const categoryId =
      raw.categoryId != null && raw.categoryId !== ''
        ? raw.categoryId
        : raw.user_category_id != null && raw.user_category_id !== ''
          ? raw.user_category_id
          : null;
    const organizationId =
      raw.organizationId != null && raw.organizationId !== ''
        ? raw.organizationId
        : raw.organization_id != null && raw.organization_id !== ''
          ? raw.organization_id
          : null;
    if (categoryId == null || organizationId == null) {
      row.error = 'Нужны категория и организация';
      results.push(row);
      continue;
    }

    try {
      const analogs = Array.isArray(raw.analogs)
        ? raw.analogs
        : Array.isArray(raw.content?.analogs)
          ? raw.content.analogs
          : [];
      const applicability = Array.isArray(raw.applicability)
        ? raw.applicability
        : Array.isArray(raw.content?.applicability)
          ? raw.content.applicability
          : [];
      const attrIdsForRow = attrIds;
      const attributeValues = mergeEnrichmentAttributeValues(attrIdsForRow, analogs, applicability);
      await ensureCategoryHasAttributes(categoryId, [attrIdsForRow.analogsId, attrIdsForRow.applicabilityId]);

      const payload = {
        profileId: opts.profileId,
        name,
        sku,
        brand: brandName || undefined,
        brand_id:
          raw.brandId != null && raw.brandId !== ''
            ? Number(raw.brandId)
            : raw.brand_id != null && raw.brand_id !== ''
              ? Number(raw.brand_id)
              : undefined,
        categoryId,
        organizationId,
        description: raw.description != null ? String(raw.description) : null,
        weight: raw.weight != null && raw.weight !== '' ? Number(raw.weight) : null,
        length: raw.length != null && raw.length !== '' ? Number(raw.length) : null,
        width: raw.width != null && raw.width !== '' ? Number(raw.width) : null,
        height: raw.height != null && raw.height !== '' ? Number(raw.height) : null,
        barcodes: Array.isArray(raw.barcodes)
          ? raw.barcodes.map((b) => (typeof b === 'string' ? { barcode: b, marketplaces: [] } : b))
          : [],
      };
      if (Object.keys(attributeValues).length) {
        payload.attribute_values = attributeValues;
      }
      if (payload.brand_id != null && !Number.isFinite(payload.brand_id)) {
        delete payload.brand_id;
      }

      const product = await productsService.create(payload);
      const productId = product?.id;
      let imagesAdded = 0;
      const imageUrls = uniqImageUrls(raw.imageUrls || raw.images || []).slice(0, 8);

      if (productId != null && imageUrls.length) {
        const downloaded = [];
        const seenHashes = new Set();
        for (let imgIdx = 0; imgIdx < imageUrls.length; imgIdx++) {
          try {
            const rec = await downloadImageToProductFolder(productId, imageUrls[imgIdx], {
              primary: downloaded.length === 0,
              marketplaces: { ozon: true, wb: true, ym: true },
            });
            if (!rec) continue;
            const hash = String(rec.content_hash || rec.contentHash || '').toLowerCase();
            if (hash && seenHashes.has(hash)) continue;
            if (hash) seenHashes.add(hash);
            downloaded.push(rec);
          } catch (imgErr) {
            row.imageWarning = row.imageWarning
              ? `${row.imageWarning}; ${imgErr?.message || imgErr}`
              : String(imgErr?.message || imgErr);
          }
        }
        if (downloaded.length) {
          downloaded.forEach((d, i) => {
            d.primary = i === 0;
          });
          await productsRepo().update(productId, { images: downloaded });
          imagesAdded = downloaded.length;
        }
      }

      row.ok = true;
      row.productId = productId;
      row.imagesAdded = imagesAdded;
      row.name = product?.name || name;
    } catch (err) {
      row.error = err?.message || String(err);
      row.statusCode = err?.statusCode || null;
    }
    results.push(row);
  }

  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

export default {
  enrichProductById,
  enrichProductsByBrandSkuList,
  createProductsFromEnrichmentItems,
  getEnrichmentStatusForProfile,
};
