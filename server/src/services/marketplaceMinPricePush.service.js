/**
 * Пуш цен ERP → маркетплейсы.
 *
 * Временный режим (по умолчанию): цена продажи = рассчитанный минимум.
 * Позже: отдельная цена продажи + min_price / пол как нижний порог
 * (MARKETPLACE_SYNC_PRICE_TO_MIN=0 → только не давать продавать ниже пола).
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';
import { assertMarketplacePricePushAllowed } from '../utils/organizationMarketplacePricePushPolicy.js';
import { filtersFromPricePushSettings, parsePricePushSettings, resolvePushFloorForMarketplace, isProductInPricePushScope } from '../utils/pricePushSettings.js';
import { SYSTEM_ATTR_KEYS } from '../utils/attributeFormula.js';
import { refreshComputedAttributeValues } from './computedAttributes.service.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMinPricePushEnabled() {
  const v = process.env.MARKETPLACE_MIN_PRICE_PUSH_ENABLED;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/**
 * true — ставить текущую цену продажи равной ERP-минимуму (временный режим).
 * false — только поднимать цену/пол, если на МП ниже рассчитанного минимума.
 */
export function isSyncSellingPriceToMinEnabled() {
  const v = process.env.MARKETPLACE_SYNC_PRICE_TO_MIN;
  if (v == null || String(v).trim() === '') return true;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** Округление пола вверх до целых рублей (как обычно на МП). */
export function floorRub(minPrice) {
  if (minPrice == null || minPrice === '') return null;
  const n = Number(minPrice);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.max(1, Math.ceil(n));
}

/** Артикулы в product_skus иногда с хвостом «;» — API YM/Ozon его не принимают. */
export function normalizeMpOfferId(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  while (s.endsWith(';')) s = s.slice(0, -1).trim();
  return s || null;
}

export function pricesRoughlyEqual(a, b, eps = 1) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= eps;
}

export function wbEffectivePrice(price, discountPercent) {
  const p = Number(price);
  const d = Math.max(0, Math.min(99, Number(discountPercent) || 0));
  if (!Number.isFinite(p) || p <= 0) return null;
  return Math.round(p * (1 - d / 100) * 100) / 100;
}

/** Новая цена до скидки, чтобы effective >= floor при той же скидке. */
export function wbPriceToMeetFloor(floor, discountPercent) {
  const f = floorRub(floor);
  if (f == null) return null;
  const d = Math.max(0, Math.min(99, Number(discountPercent) || 0));
  const denom = 1 - d / 100;
  if (denom <= 0.01) return f;
  return Math.ceil(f / denom);
}

export function needsOzonMinPricePush({ erpFloor, mpMinPrice, mpPrice }) {
  const floor = floorRub(erpFloor);
  if (floor == null) return false;
  const minOk = pricesRoughlyEqual(mpMinPrice, floor);
  if (isSyncSellingPriceToMinEnabled()) {
    // Цена продажи и min_price на Ozon = ERP-минимум.
    const priceOk =
      mpPrice != null && Number.isFinite(Number(mpPrice)) && pricesRoughlyEqual(mpPrice, floor);
    return !(minOk && priceOk);
  }
  // Режим порога: min_price = пол; price не ниже пола.
  const priceOk = mpPrice == null || !Number.isFinite(Number(mpPrice)) || Number(mpPrice) >= floor - 0.5;
  return !(minOk && priceOk);
}

export function needsWbFloorPush({ erpFloor, price, discount }) {
  const floor = floorRub(erpFloor);
  if (floor == null) return false;
  const eff = wbEffectivePrice(price, discount);
  if (eff == null) return false;
  if (isSyncSellingPriceToMinEnabled()) {
    return !pricesRoughlyEqual(eff, floor);
  }
  return eff < floor - 0.5;
}

export function needsYmFloorPush({ erpFloor, currentPrice }) {
  const floor = floorRub(erpFloor);
  if (floor == null) return false;
  const cur = Number(currentPrice);
  if (!Number.isFinite(cur) || cur <= 0) return false;
  if (isSyncSellingPriceToMinEnabled()) {
    return !pricesRoughlyEqual(cur, floor);
  }
  return cur < floor - 0.5;
}

/** Цена для Ozon import/prices: в режиме sync-to-min = пол, иначе max(факт, пол). */
export function resolveOzonPushTargetPrice(floor, sellingTarget) {
  const floorVal = floorRub(floor);
  if (floorVal == null) return null;
  if (isSyncSellingPriceToMinEnabled()) return floorVal;
  const selling = floorRub(sellingTarget) ?? floorVal;
  return Math.max(selling, floorVal);
}

/** Payload для Ozon import/prices (price >= min_price). */
export function buildOzonPriceImportEntry({
  floor,
  sellingTarget,
  ozonProductId,
  offerId,
  priceBeforeDiscount = null,
}) {
  const floorVal = floorRub(floor);
  const targetPrice = resolveOzonPushTargetPrice(floor, sellingTarget);
  if (floorVal == null || targetPrice == null) return null;

  const entry = {
    price: String(targetPrice),
    currency_code: 'RUB',
    auto_action_enabled: 'DISABLED',
    auto_add_to_ozon_actions_list_enabled: 'DISABLED',
  };
  if (floorVal <= targetPrice) {
    entry.min_price = String(floorVal);
  }
  const before = floorRub(priceBeforeDiscount);
  if (before != null && before > targetPrice + 0.009) {
    entry.old_price = String(before);
  }
  if (ozonProductId) entry.product_id = ozonProductId;
  else if (offerId) entry.offer_id = offerId;
  else return null;
  return entry;
}

/** price + discount для WB upload/task (effective >= floor). */
export function buildWbPriceUploadPayload({
  floor,
  sellingTarget,
  priceBeforeDiscount = null,
  discountPercent = null,
  currentWbDiscount = 0,
}) {
  const targetEff = resolveOzonPushTargetPrice(floor, sellingTarget) ?? floorRub(floor);
  if (targetEff == null) return null;

  const erpBefore = floorRub(priceBeforeDiscount);
  let erpDiscount = null;
  if (discountPercent != null && discountPercent !== '' && Number.isFinite(Number(discountPercent))) {
    erpDiscount = Math.max(0, Math.min(99, Math.round(Number(discountPercent))));
  }

  // Цена до скидки + %: после скидки должна быть ровно targetEff (мин. цена).
  // Целое % скидки почти никогда не даёт exact match при фиксированном before —
  // поэтому подбираем discount от «до скидки», а price до скидки чуть корректируем
  // через wbPriceToMeetFloor, чтобы effective == floor.
  if (erpBefore != null && erpBefore > targetEff) {
    const discount =
      erpDiscount != null && erpDiscount > 0
        ? erpDiscount
        : Math.max(1, Math.min(99, Math.round((1 - targetEff / erpBefore) * 100)));
    if (isSyncSellingPriceToMinEnabled()) {
      const price = wbPriceToMeetFloor(targetEff, discount);
      if (price == null) return null;
      return { price, discount, targetEff };
    }
    return { price: erpBefore, discount, targetEff };
  }

  if (erpDiscount != null && erpDiscount > 0) {
    const price = wbPriceToMeetFloor(targetEff, erpDiscount);
    if (price == null) return null;
    return { price, discount: erpDiscount, targetEff };
  }

  if (isSyncSellingPriceToMinEnabled()) {
    return { price: targetEff, discount: 0, targetEff };
  }

  const d = Math.max(0, Math.min(99, Math.round(Number(currentWbDiscount) || 0)));
  const price = wbPriceToMeetFloor(targetEff, d);
  if (price == null) return null;
  return { price, discount: d, targetEff };
}

/**
 * YM offer price: value = после скидки; discountBase = до скидки (скидка 5–99%).
 * @see https://yandex.ru/dev/market/partner-api/doc/ru/reference/business-assortment/updateBusinessPrices
 */
export function buildYmOfferPrice({ value, priceBeforeDiscount = null }) {
  const v = floorRub(value);
  if (v == null) return null;
  const price = { value: v, currencyId: 'RUR' };
  const before = floorRub(priceBeforeDiscount);
  if (before != null && before > v) {
    const discountPct = (1 - v / before) * 100;
    if (discountPct >= 5 && discountPct <= 99) {
      price.discountBase = before;
    }
  }
  return price;
}

function isRateLimitStatus(status, text = '') {
  if (Number(status) === 429) return true;
  const t = String(text || '').toLowerCase();
  return t.includes('too many requests') || t.includes('rate limit');
}

async function fetchWithRetry(url, options, { maxAttempts = 4, label = 'API' } = {}) {
  let lastResponse = null;
  let lastText = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(url, options);
    lastResponse = response;
    lastText = await response.text().catch(() => '');
    if (!isRateLimitStatus(response.status, lastText) || attempt >= maxAttempts - 1) {
      return { response, text: lastText };
    }
    const retryAfter = parseInt(response.headers?.get?.('retry-after'), 10);
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1500 * 2 ** attempt);
    logger.warn(`[MP MinPrice Push] ${label} 429, retry in ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
  return { response: lastResponse, text: lastText };
}

const _debounceTimers = new Map();

export function schedulePushForProduct(productId, delayMs = 2500) {
  if (!isMinPricePushEnabled()) return;
  const id = Number(productId);
  if (!Number.isFinite(id) || id < 1) return;
  const prev = _debounceTimers.get(id);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    _debounceTimers.delete(id);
    pushForProduct(id).catch((e) => {
      logger.warn('[MP MinPrice Push] schedulePushForProduct failed', {
        productId: id,
        message: e?.message || String(e),
      });
    });
  }, delayMs);
  _debounceTimers.set(id, t);
}

async function loadProfilePushSchemes(profileId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return parsePricePushSettings(null);
  }
  try {
    const res = await query('SELECT price_push_settings FROM profiles WHERE id = $1 LIMIT 1', [pid]);
    return parsePricePushSettings(res.rows?.[0]?.price_push_settings);
  } catch {
    return parsePricePushSettings(null);
  }
}

async function loadCardPriceAttributes(productId) {
  const out = { before: null, after: null };
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return out;
  try {
    await refreshComputedAttributeValues(query, pid);
  } catch (e) {
    logger.warn('[MP MinPrice Push] refresh card prices failed', e?.message || e);
  }
  try {
    const r = await query(
      `SELECT pa.system_key, pav.value
       FROM product_attributes pa
       LEFT JOIN product_attribute_values pav
         ON pav.attribute_id = pa.id AND pav.product_id = $1
       WHERE pa.system_key IN ($2, $3)`,
      [pid, SYSTEM_ATTR_KEYS.PRICE_BEFORE_DISCOUNT, SYSTEM_ATTR_KEYS.PRICE_AFTER_DISCOUNT]
    );
    for (const row of r.rows || []) {
      const n = floorRub(row.value);
      if (n == null) continue;
      if (row.system_key === SYSTEM_ATTR_KEYS.PRICE_BEFORE_DISCOUNT) out.before = n;
      if (row.system_key === SYSTEM_ATTR_KEYS.PRICE_AFTER_DISCOUNT) out.after = n;
    }
  } catch (e) {
    logger.warn('[MP MinPrice Push] load card price attributes failed', e?.message || e);
  }
  return out;
}

async function loadProductPushContext(productId, pushSchemes = null) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return null;

  const schemes = pushSchemes || parsePricePushSettings(null);

  const prodRes = await query(
    `SELECT id, profile_id, organization_id, sku, wb_draft,
            mp_wb_vendor_code
     FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  const product = prodRes.rows?.[0];
  if (!product) return null;

  const pricesRes = await query(
    `SELECT marketplace, min_price, min_price_fbs, min_price_fbo, selling_price,
            price_before_discount, discount_percent
     FROM product_marketplace_prices
     WHERE product_id = $1
       AND (
         (min_price IS NOT NULL AND min_price > 0)
         OR (min_price_fbs IS NOT NULL AND min_price_fbs > 0)
         OR (min_price_fbo IS NOT NULL AND min_price_fbo > 0)
       )`,
    [pid]
  );
  const floors = {};
  const selling = {};
  const priceBeforeDiscount = {};
  const discountPercent = {};
  for (const row of pricesRes.rows || []) {
    const mp = String(row.marketplace || '').toLowerCase();
    const floor = resolvePushFloorForMarketplace(row, mp, schemes);
    if (floor != null) floors[mp] = floor;
    const s = row.selling_price != null ? floorRub(row.selling_price) : null;
    if (s != null) selling[mp] = s;
    const before = row.price_before_discount != null ? floorRub(row.price_before_discount) : null;
    if (before != null) priceBeforeDiscount[mp] = before;
    if (row.discount_percent != null && Number.isFinite(Number(row.discount_percent))) {
      discountPercent[mp] = Math.max(0, Math.min(99, Math.round(Number(row.discount_percent))));
    }
  }

  // Источник цен «до/после скидки» — атрибуты карточки (источник истины при пуше).
  const cardPrices = await loadCardPriceAttributes(pid);
  if (cardPrices.before != null) {
    for (const mp of Object.keys(floors)) {
      priceBeforeDiscount[mp] = cardPrices.before;
    }
  }
  if (cardPrices.after != null) {
    for (const mp of Object.keys(floors)) {
      selling[mp] = cardPrices.after;
    }
  }
  // Часто price_before_discount заполнен только у Ozon в product_marketplace_prices —
  // раздаём общий «до скидки» на WB/YM, иначе на них уходит только цена после скидки.
  const beforeCandidates = Object.values(priceBeforeDiscount).filter(
    (v) => v != null && Number.isFinite(Number(v)) && Number(v) > 0
  );
  if (beforeCandidates.length) {
    const sharedBefore = Math.max(...beforeCandidates.map((v) => Number(v)));
    for (const mp of Object.keys(floors)) {
      if (priceBeforeDiscount[mp] == null) priceBeforeDiscount[mp] = sharedBefore;
    }
  }

  const skusRes = await query(
    `SELECT marketplace, sku, marketplace_product_id, mp_extra
     FROM product_skus WHERE product_id = $1`,
    [pid]
  );
  const productSkus = skusRes.rows || [];

  return { product, floors, selling, priceBeforeDiscount, discountPercent, productSkus };
}

function resolveOzonIds(productSkus, product) {
  const row = productSkus.find((s) => String(s.marketplace).toLowerCase() === 'ozon');
  const productId =
    row?.marketplace_product_id != null && String(row.marketplace_product_id).trim() !== ''
      ? Number(row.marketplace_product_id)
      : null;
  const offerId = normalizeMpOfferId(row?.sku || product?.sku || null);
  return {
    ozonProductId: Number.isFinite(productId) && productId > 0 ? productId : null,
    offerId,
  };
}

function resolveWbNmIdSync(productSkus, product) {
  const row = productSkus.find((s) => String(s.marketplace).toLowerCase() === 'wb');
  let draft = product?.wb_draft;
  if (typeof draft === 'string') {
    try {
      draft = JSON.parse(draft);
    } catch {
      draft = null;
    }
  }
  const fromDraft = draft?.nmId ?? draft?.nmID ?? draft?.nm_id ?? null;
  if (fromDraft != null && /^\d+$/.test(String(fromDraft).trim())) {
    return Number(String(fromDraft).trim());
  }
  const sku = row?.sku != null ? String(row.sku).trim() : '';
  if (/^\d{5,}$/.test(sku)) return Number(sku);
  return null;
}

function resolveWbVendorCode(productSkus, product) {
  const row = productSkus.find((s) => String(s.marketplace).toLowerCase() === 'wb');
  return (
    normalizeMpOfferId(product?.mp_wb_vendor_code) ||
    normalizeMpOfferId(row?.sku) ||
    normalizeMpOfferId(product?.sku)
  );
}

async function resolveWbNmId(productSkus, product, orgId, profileId) {
  const sync = resolveWbNmIdSync(productSkus, product);
  if (sync) return sync;
  const vendorCode = resolveWbVendorCode(productSkus, product);
  if (!vendorCode) return null;
  try {
    const card = await integrationsService.getWildberriesProductByVendorCode(vendorCode, {
      organizationId: orgId,
      profileId,
    });
    const nm = Number(card?.nmId ?? card?.nmID);
    return Number.isFinite(nm) && nm > 0 ? nm : null;
  } catch (e) {
    logger.warn('[MP MinPrice Push] WB nmId by vendorCode failed', {
      vendorCode,
      message: e?.message || String(e),
    });
    return null;
  }
}

function resolveYmOfferId(productSkus, product) {
  const row = productSkus.find((s) => {
    const m = String(s.marketplace).toLowerCase();
    return m === 'ym' || m === 'yandex' || m === 'yandexmarket';
  });
  return normalizeMpOfferId(row?.sku || product?.sku || null);
}

async function pushOzonForProduct(ctx, floor, sellingTarget, orgId, profileId) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', {
    organizationId: orgId,
    profileId,
  });
  if (!integrationsService._hasOzonCredentials(cfg)) {
    return { marketplace: 'ozon', skipped: true, reason: 'no_credentials' };
  }
  const clientId = cfg.client_id ?? cfg.clientId;
  const apiKey = cfg.api_key ?? cfg.apiKey;
  const { ozonProductId, offerId } = resolveOzonIds(ctx.productSkus, ctx.product);
  if (!ozonProductId && !offerId) {
    return { marketplace: 'ozon', skipped: true, reason: 'not_linked' };
  }

  const targetPrice = resolveOzonPushTargetPrice(floor, sellingTarget);
  if (targetPrice == null) {
    return { marketplace: 'ozon', skipped: true, reason: 'invalid_floor' };
  }
  const ozonApiOpts = { ozonOverride: { client_id: clientId, api_key: apiKey } };
  let mpMin = null;
  let mpPrice = null;
  let mpOldPrice = null;
  try {
    const filter = ozonProductId
      ? { product_id: [ozonProductId] }
      : { offer_id: [offerId] };
    const data = await ozonApiPostWithRetry(
      '/v5/product/info/prices',
      { cursor: '', filter: { visibility: 'ALL', ...filter }, limit: 100 },
      ozonApiOpts
    );
    const items = data?.items || data?.result?.items || [];
    const item = items[0];
    const priceBlock = item?.price || item;
    mpMin = priceBlock?.min_price != null ? Number(priceBlock.min_price) : null;
    mpPrice = priceBlock?.price != null ? Number(priceBlock.price) : null;
    mpOldPrice = priceBlock?.old_price != null ? Number(priceBlock.old_price) : null;
  } catch (e) {
    logger.warn('[MP MinPrice Push] Ozon read failed', { message: e?.message || String(e) });
  }

  const entry = buildOzonPriceImportEntry({
    floor,
    sellingTarget,
    ozonProductId,
    offerId,
    priceBeforeDiscount: ctx.priceBeforeDiscount?.ozon ?? null,
  });
  if (!entry) {
    return { marketplace: 'ozon', skipped: true, reason: 'invalid_entry' };
  }
  const oldPriceOk =
    !entry.old_price ||
    (Number.isFinite(mpOldPrice) && pricesRoughlyEqual(mpOldPrice, Number(entry.old_price)));
  if (!needsOzonMinPricePush({ erpFloor: floor, mpMinPrice: mpMin, mpPrice }) && oldPriceOk) {
    return { marketplace: 'ozon', skipped: true, reason: 'already_ok', floor, selling: targetPrice };
  }

  try {
    await ozonApiPostWithRetry('/v1/product/import/prices', { prices: [entry] }, ozonApiOpts);
  } catch (e) {
    return {
      marketplace: 'ozon',
      ok: false,
      error: `import/prices: ${e?.message || String(e)}`.substring(0, 240),
    };
  }
  logger.info('[MP MinPrice Push] Ozon OK', {
    productId: ctx.product.id,
    floor,
    selling: targetPrice,
    ozonProductId,
    offerId,
  });
  return { marketplace: 'ozon', ok: true, floor, selling: targetPrice, raisedPrice: true };
}

async function pushWbForProduct(ctx, floor, sellingTarget, orgId, profileId) {
  const cfg = await integrationsService.getMarketplaceConfig('wildberries', {
    organizationId: orgId,
    profileId,
  });
  const token = integrationsService._normalizeWbToken(cfg?.api_key ?? cfg?.apiKey);
  if (!token) {
    return { marketplace: 'wb', skipped: true, reason: 'no_credentials' };
  }
  const nmID = await resolveWbNmId(ctx.productSkus, ctx.product, orgId, profileId);
  if (!nmID) {
    return { marketplace: 'wb', skipped: true, reason: 'not_linked' };
  }

  let price = null;
  let discount = 0;
  try {
    const qs = new URLSearchParams({
      limit: '10',
      offset: '0',
      filterNmID: String(nmID),
    });
    const { response, text } = await fetchWithRetry(
      `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?${qs}`,
      {
        method: 'GET',
        headers: {
          Authorization: String(token),
          Accept: 'application/json',
        },
      },
      { label: 'WB list/goods' }
    );
    if (response.ok) {
      const data = JSON.parse(text || '{}');
      const goods = data?.data?.listGoods || data?.listGoods || data?.data || [];
      const list = Array.isArray(goods) ? goods : [];
      const hit = list.find((g) => Number(g.nmID ?? g.nmId) === nmID) || list[0];
      if (hit) {
        const size0 = Array.isArray(hit.sizes) ? hit.sizes[0] : null;
        price =
          hit.price != null
            ? Number(hit.price)
            : size0?.price != null
              ? Number(size0.price)
              : null;
        discount = hit.discount != null ? Number(hit.discount) : 0;
      }
    }
  } catch (e) {
    logger.warn('[MP MinPrice Push] WB read failed', { message: e?.message || String(e) });
  }

  if (price == null || !Number.isFinite(price)) {
    return { marketplace: 'wb', skipped: true, reason: 'unknown_current' };
  }

  const uploadPack = buildWbPriceUploadPayload({
    floor,
    sellingTarget,
    priceBeforeDiscount: ctx.priceBeforeDiscount?.wb ?? null,
    discountPercent: ctx.discountPercent?.wb ?? null,
    currentWbDiscount: discount,
  });
  if (!uploadPack) {
    return { marketplace: 'wb', skipped: true, reason: 'invalid_floor' };
  }

  const targetEff = uploadPack.targetEff;
  const currentEff = wbEffectivePrice(price, discount);
  const priceMatch =
    Math.round(Number(price)) === Math.round(uploadPack.price) &&
    Math.round(Number(discount) || 0) === Math.round(uploadPack.discount);
  if (priceMatch && currentEff != null && pricesRoughlyEqual(currentEff, targetEff)) {
    return { marketplace: 'wb', skipped: true, reason: 'already_ok', floor, selling: targetEff };
  }

  const payload = {
    data: [
      {
        nmID,
        price: uploadPack.price,
        ...(Number.isFinite(uploadPack.discount) ? { discount: Math.round(uploadPack.discount) } : {}),
      },
    ],
  };
  const { response, text } = await fetchWithRetry(
    'https://discounts-prices-api.wildberries.ru/api/v2/upload/task',
    {
      method: 'POST',
      headers: {
        Authorization: String(token),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    },
    { label: 'WB upload/task' }
  );
  if (!response.ok) {
    return {
      marketplace: 'wb',
      ok: false,
      error: `upload/task ${response.status}: ${text.substring(0, 200)}`,
    };
  }
  logger.info('[MP MinPrice Push] WB OK', {
    productId: ctx.product.id,
    nmID,
    floor,
    selling: uploadPack.targetEff,
    newPrice: uploadPack.price,
    discount: uploadPack.discount,
  });
  return {
    marketplace: 'wb',
    ok: true,
    floor,
    selling: uploadPack.targetEff,
    newPrice: uploadPack.price,
    discount: uploadPack.discount,
    before: uploadPack.discount > 0 ? uploadPack.price : null,
  };
}

async function pushYmForProduct(ctx, floor, sellingTarget, orgId, profileId) {
  const cfg = await integrationsService.getMarketplaceConfig('yandex', {
    organizationId: orgId,
    profileId,
  });
  const apiKey = integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
  const campaignId = String(cfg?.campaign_id ?? cfg?.campaignId ?? '').trim();
  const businessIdRaw = cfg?.business_id ?? cfg?.businessId;
  const businessId =
    businessIdRaw != null && String(businessIdRaw).trim() !== ''
      ? String(businessIdRaw).trim()
      : '';
  if (!apiKey || (!campaignId && !businessId)) {
    return { marketplace: 'ym', skipped: true, reason: 'no_credentials' };
  }
  const offerId = resolveYmOfferId(ctx.productSkus, ctx.product);
  if (!offerId) {
    return { marketplace: 'ym', skipped: true, reason: 'not_linked' };
  }

  const targetPrice = resolveOzonPushTargetPrice(floor, sellingTarget) ?? floorRub(floor);
  const useBusiness = Boolean(businessId);
  const pricesPath = useBusiness
    ? `/v2/businesses/${encodeURIComponent(businessId)}/offer-prices`
    : `/v2/campaigns/${encodeURIComponent(campaignId)}/offer-prices`;
  const updatesPath = useBusiness
    ? `/v2/businesses/${encodeURIComponent(businessId)}/offer-prices/updates`
    : `/v2/campaigns/${encodeURIComponent(campaignId)}/offer-prices/updates`;

  let currentPrice = null;
  try {
    const agent = getYandexHttpsAgent();
    const { response, text } = await fetchWithRetry(
      `https://api.partner.market.yandex.ru${pricesPath}`,
      {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        agent,
        body: JSON.stringify({ offerIds: [offerId] }),
      },
      { label: 'YM offer-prices get' }
    );
    if (response.ok) {
      const data = JSON.parse(text || '{}');
      const offers = data?.result?.offers || data?.offers || [];
      const hit =
        offers.find((o) => String(o.offerId || o.id) === offerId) || offers[0];
      const val = hit?.price?.value ?? hit?.price;
      if (val != null) currentPrice = Number(val);
    }
  } catch (e) {
    logger.warn('[MP MinPrice Push] YM read failed', { message: e?.message || String(e) });
  }

  if (currentPrice == null || !Number.isFinite(currentPrice)) {
    return { marketplace: 'ym', skipped: true, reason: 'unknown_current' };
  }

  const priceObj = buildYmOfferPrice({
    value: targetPrice,
    priceBeforeDiscount: ctx.priceBeforeDiscount?.ym ?? null,
  });
  if (!priceObj) {
    return { marketplace: 'ym', skipped: true, reason: 'invalid_floor' };
  }
  const needsBefore = priceObj.discountBase != null;
  if (!needsYmFloorPush({ erpFloor: floor, currentPrice }) && !needsBefore) {
    return { marketplace: 'ym', skipped: true, reason: 'already_ok', floor, selling: targetPrice };
  }

  const agent = getYandexHttpsAgent();
  const offerPayload = useBusiness
    ? { offerId, price: priceObj }
    : { id: offerId, price: priceObj };
  const { response, text } = await fetchWithRetry(
    `https://api.partner.market.yandex.ru${updatesPath}`,
    {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      agent,
      body: JSON.stringify({ offers: [offerPayload] }),
    },
    { label: 'YM offer-prices updates' }
  );
  if (!response.ok) {
    return {
      marketplace: 'ym',
      ok: false,
      error: `offer-prices ${response.status}: ${text.substring(0, 200)}`,
    };
  }
  logger.info('[MP MinPrice Push] YM OK', {
    productId: ctx.product.id,
    offerId,
    floor,
    selling: targetPrice,
    before: priceObj.discountBase ?? null,
    previous: currentPrice,
    via: useBusiness ? 'business' : 'campaign',
  });
  return {
    marketplace: 'ym',
    ok: true,
    floor,
    selling: targetPrice,
    newValue: priceObj.value,
    before: priceObj.discountBase ?? null,
  };
}

/**
 * Пуш мин. цен для одного товара ERP.
 * Только если у организации включено auto_push_marketplace_prices.
 */
export async function pushForProduct(productId) {
  if (!isMinPricePushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }
  let profileIdForSettings = null;
  const prodPeek = await query(
    'SELECT id, profile_id, user_category_id FROM products WHERE id = $1 LIMIT 1',
    [Number(productId)]
  );
  const peek = prodPeek.rows?.[0];
  profileIdForSettings = peek?.profile_id ?? null;
  const pushSchemes = await loadProfilePushSchemes(profileIdForSettings);

  // Область из «Цены → Настройки»: schedule после пересчёта / push-one
  // раньше игнорировали список товаров и пушили любой SKU с auto_push org.
  if (Number.isFinite(Number(profileIdForSettings)) && Number(profileIdForSettings) > 0) {
    try {
      const res = await query('SELECT price_push_settings FROM profiles WHERE id = $1 LIMIT 1', [
        Number(profileIdForSettings),
      ]);
      if (!isProductInPricePushScope(peek, res.rows?.[0]?.price_push_settings)) {
        return {
          skipped: true,
          reason: 'out_of_push_scope',
          productId: Number(productId),
        };
      }
    } catch (e) {
      logger.warn('[MP MinPrice Push] push scope check failed', {
        productId,
        message: e?.message || String(e),
      });
    }
  }

  let ctx = await loadProductPushContext(productId, pushSchemes);
  if (!ctx) return { skipped: true, reason: 'product_not_found' };
  if (!Object.keys(ctx.floors).length) {
    return { skipped: true, reason: 'no_stored_min_prices' };
  }

  const orgId = ctx.product.organization_id != null ? Number(ctx.product.organization_id) : null;
  const profileId = ctx.product.profile_id != null ? Number(ctx.product.profile_id) : null;

  const gate = await assertMarketplacePricePushAllowed({
    organizationId: orgId,
    productId: ctx.product.id,
    source: 'pushForProduct',
  });
  if (!gate.allowed) {
    return { skipped: true, reason: gate.reason || 'org_price_push_disabled', productId: Number(productId) };
  }

  try {
    const { recalculateSellingPricesForProduct } = await import('./pricingStrategy.service.js');
    await recalculateSellingPricesForProduct(productId);
    ctx = (await loadProductPushContext(productId, pushSchemes)) || ctx;
  } catch (e) {
    logger.warn('[MP MinPrice Push] strategy recalc failed', {
      productId,
      message: e?.message || String(e),
    });
  }

  const results = [];

  if (ctx.floors.ozon != null) {
    try {
      const selling = ctx.selling?.ozon ?? ctx.floors.ozon;
      results.push(await pushOzonForProduct(ctx, ctx.floors.ozon, selling, orgId, profileId));
    } catch (e) {
      results.push({ marketplace: 'ozon', ok: false, error: e?.message || String(e) });
    }
  }
  if (ctx.floors.wb != null) {
    try {
      const selling = ctx.selling?.wb ?? ctx.floors.wb;
      results.push(await pushWbForProduct(ctx, ctx.floors.wb, selling, orgId, profileId));
    } catch (e) {
      results.push({ marketplace: 'wb', ok: false, error: e?.message || String(e) });
    }
  }
  if (ctx.floors.ym != null) {
    try {
      const selling = ctx.selling?.ym ?? ctx.floors.ym;
      results.push(await pushYmForProduct(ctx, ctx.floors.ym, selling, orgId, profileId));
    } catch (e) {
      results.push({ marketplace: 'ym', ok: false, error: e?.message || String(e) });
    }
  }

  return {
    productId: Number(productId),
    results,
    pushed: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.ok === false).length,
  };
}

let _fullRunInProgress = false;

/** Sentinel «без категории» — как на странице цен/товаров. */
export const PUSH_FILTER_CATEGORY_NONE = '__no_category__';

function parsePositiveIntList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
}

function parseCategoryIdList(raw) {
  if (raw == null || raw === '') return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];
}

/**
 * ID товаров для пуша цен по фильтрам (только org с auto_push и сохранённым min_price).
 */
export async function resolvePushProductIds(filters = {}) {
  const organizationId =
    filters.organizationId != null && filters.organizationId !== ''
      ? Number(filters.organizationId)
      : null;
  const brandId =
    filters.brandId != null && filters.brandId !== '' ? Number(filters.brandId) : null;
  const productIds = parsePositiveIntList(filters.productIds);
  const categoryIds = parseCategoryIdList(filters.categoryIds);

  const params = [];
  let i = 1;
  let sql = `
    SELECT DISTINCT pmp.product_id
    FROM product_marketplace_prices pmp
    JOIN products p ON p.id = pmp.product_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE (
      (pmp.min_price IS NOT NULL AND pmp.min_price > 0)
      OR (pmp.min_price_fbs IS NOT NULL AND pmp.min_price_fbs > 0)
      OR (pmp.min_price_fbo IS NOT NULL AND pmp.min_price_fbo > 0)
    )
      AND o.auto_push_marketplace_prices = true`;

  if (Number.isFinite(organizationId) && organizationId > 0) {
    sql += ` AND p.organization_id = $${i++}`;
    params.push(organizationId);
  }
  if (Number.isFinite(brandId) && brandId > 0) {
    sql += ` AND p.brand_id = $${i++}`;
    params.push(brandId);
  }
  if (productIds.length) {
    sql += ` AND p.id = ANY($${i++}::bigint[])`;
    params.push(productIds);
  }
  const profileId =
    filters.profileId != null && filters.profileId !== '' ? Number(filters.profileId) : null;
  if (Number.isFinite(profileId) && profileId > 0) {
    sql += ` AND o.profile_id = $${i++}`;
    params.push(profileId);
  }

  if (categoryIds.length) {
    const normal = categoryIds.filter((c) => c !== PUSH_FILTER_CATEGORY_NONE);
    const wantNone = categoryIds.includes(PUSH_FILTER_CATEGORY_NONE);
    if (normal.length && wantNone) {
      sql += ` AND (p.user_category_id IS NULL OR p.user_category_id::text = ANY($${i++}::text[]))`;
      params.push(normal);
    } else if (wantNone) {
      sql += ' AND p.user_category_id IS NULL';
    } else if (normal.length) {
      sql += ` AND p.user_category_id::text = ANY($${i++}::text[])`;
      params.push(normal);
    }
  }

  sql += ' ORDER BY pmp.product_id ASC';

  const r = await query(sql, params);
  return (r.rows || [])
    .map((row) => Number(row.product_id))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function pushProductIdList(ids, logMeta = {}) {
  let pushed = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < ids.length; i++) {
    const out = await pushForProduct(ids[i]).catch((e) => ({
      failed: 1,
      error: e?.message || String(e),
    }));
    pushed += out.pushed || 0;
    failed += out.failed || 0;
    skipped += out.skipped || (out.reason ? 1 : 0);
    if (i > 0 && i % 20 === 0) await sleep(200);
  }
  const result = { products: ids.length, pushed, failed, skipped, ...logMeta };
  return result;
}

/**
 * Пуш по явному списку product_id (после фильтра auto_push / min_price).
 */
export async function pushForProductIds(productIds, opts = {}) {
  if (!isMinPricePushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }
  if (_fullRunInProgress) {
    return { skipped: true, reason: 'in_progress' };
  }
  const ids = parsePositiveIntList(productIds);
  if (!ids.length) {
    return { skipped: true, reason: 'no_products', products: 0, pushed: 0, failed: 0, skipped: 0 };
  }
  _fullRunInProgress = true;
  try {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { skipped: true, reason: 'not_pg' };
    }
    const resolved = await resolvePushProductIds({
      productIds: ids,
      ...(opts.filters || {}),
    });
    if (!resolved.length) {
      return { skipped: true, reason: 'no_products', products: 0, pushed: 0, failed: 0, skipped: 0 };
    }
    const out = await pushProductIdList(resolved, { mode: 'product_ids', requested: ids.length });
    logger.info('[MP MinPrice Push] product ids run done', out);
    return out;
  } finally {
    _fullRunInProgress = false;
  }
}

/**
 * Пуш с фильтрами: organizationId, brandId, categoryIds, productIds.
 */
export async function pushWithFilters(filters = {}) {
  if (!isMinPricePushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }
  if (_fullRunInProgress) {
    return { skipped: true, reason: 'in_progress' };
  }
  _fullRunInProgress = true;
  try {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { skipped: true, reason: 'not_pg' };
    }
    const ids = await resolvePushProductIds(filters);
    if (!ids.length) {
      return { skipped: true, reason: 'no_products', products: 0, pushed: 0, failed: 0, skipped: 0 };
    }
    const out = await pushProductIdList(ids, { mode: 'filters', filters });
    logger.info('[MP MinPrice Push] filtered run done', out);
    return out;
  } finally {
    _fullRunInProgress = false;
  }
}

/**
 * Дневная сверка (каждые ~2 ч): для org с auto_push пересчитывает стратегию и
 * пушит на МП, если цена/пол отличаются от целевых в ERP (selling или мин.).
 * Раньше — только WB «ниже пола»; теперь тот же проход, что и полный пуш,
 * но без ночного sync кэша калькулятора.
 */
export async function reconcileBelowFloor() {
  const result = await pushForAllProfiles();
  if (result?.skipped) {
    return { mode: 'reconcile', ...result };
  }
  const out = { mode: 'reconcile', ...result };
  logger.info('[MP MinPrice Push] reconcile done', out);
  return out;
}

/**
 * Полный прогон: все товары с сохранёнными мин. ценами (только org с auto_push).
 */
export async function pushForAllProfiles({ limit = null } = {}) {
  if (!isMinPricePushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }
  if (_fullRunInProgress) {
    return { skipped: true, reason: 'in_progress' };
  }
  _fullRunInProgress = true;
  try {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { skipped: true, reason: 'not_pg' };
    }

    const profilesRes = await query(
      'SELECT id, price_push_settings FROM profiles ORDER BY id ASC'
    );
    const idSet = new Set();
    for (const row of profilesRes.rows || []) {
      const filters = filtersFromPricePushSettings(row.price_push_settings, row.id);
      const chunk = await resolvePushProductIds(filters);
      chunk.forEach((id) => idSet.add(id));
    }
    let ids = [...idSet].sort((a, b) => a - b);
    const lim = limit != null && Number.isFinite(Number(limit)) ? Number(limit) : null;
    if (lim != null) ids = ids.slice(0, Math.max(1, Math.floor(lim)));

    const out = await pushProductIdList(ids, { mode: 'all' });
    logger.info('[MP MinPrice Push] full run done', out);
    return out;
  } finally {
    _fullRunInProgress = false;
  }
}

/**
 * Пуш сохранённых мин. цен на МП для товаров одной организации.
 * Требует organizations.auto_push_marketplace_prices = true.
 */
export async function pushForOrganization(organizationId, { limit = null } = {}) {
  if (!isMinPricePushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }
  const orgId = Number(organizationId);
  if (!Number.isFinite(orgId) || orgId < 1) {
    return { skipped: true, reason: 'invalid_organization' };
  }

  const gate = await assertMarketplacePricePushAllowed({
    organizationId: orgId,
    source: 'pushForOrganization',
  });
  if (!gate.allowed) {
    return { skipped: true, reason: gate.reason || 'org_price_push_disabled', organizationId: orgId };
  }

  if (_fullRunInProgress) {
    return { skipped: true, reason: 'in_progress' };
  }
  _fullRunInProgress = true;
  try {
    if (!repositoryFactory.isUsingPostgreSQL()) {
      return { skipped: true, reason: 'not_pg' };
    }

    const lim = limit != null && Number.isFinite(Number(limit)) ? Number(limit) : null;
    let ids = await resolvePushProductIds({ organizationId: orgId });
    if (lim != null) ids = ids.slice(0, Math.max(1, Math.floor(lim)));

    const out = await pushProductIdList(ids, { mode: 'organization', organizationId: orgId });
    logger.info('[MP MinPrice Push] org run done', { organizationId: orgId, ...out });
    return { organizationId: orgId, ...out };
  } finally {
    _fullRunInProgress = false;
  }
}

export default {
  isMinPricePushEnabled,
  isSyncSellingPriceToMinEnabled,
  floorRub,
  normalizeMpOfferId,
  pricesRoughlyEqual,
  wbEffectivePrice,
  wbPriceToMeetFloor,
  needsOzonMinPricePush,
  needsWbFloorPush,
  needsYmFloorPush,
  buildOzonPriceImportEntry,
  buildWbPriceUploadPayload,
  buildYmOfferPrice,
  schedulePushForProduct,
  pushForProduct,
  pushForProductIds,
  pushWithFilters,
  resolvePushProductIds,
  pushForAllProfiles,
  pushForOrganization,
  reconcileBelowFloor,
  PUSH_FILTER_CATEGORY_NONE,
};
