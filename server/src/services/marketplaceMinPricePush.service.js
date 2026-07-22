/**
 * Пуш минимальных цен ERP → маркетплейсы.
 * Ozon: поле min_price (+ price, если ниже пола).
 * WB / Яндекс: поднять цену продажи, если effective < пола.
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { ozonApiPostWithRetry } from '../utils/ozonSellerApi.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMinPricePushEnabled() {
  const v = process.env.MARKETPLACE_MIN_PRICE_PUSH_ENABLED;
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
  const priceOk = mpPrice == null || !Number.isFinite(Number(mpPrice)) || Number(mpPrice) >= floor - 0.5;
  return !(minOk && priceOk);
}

export function needsWbFloorPush({ erpFloor, price, discount }) {
  const floor = floorRub(erpFloor);
  if (floor == null) return false;
  const eff = wbEffectivePrice(price, discount);
  if (eff == null) return false;
  return eff < floor - 0.5;
}

export function needsYmFloorPush({ erpFloor, currentPrice }) {
  const floor = floorRub(erpFloor);
  if (floor == null) return false;
  const cur = Number(currentPrice);
  if (!Number.isFinite(cur) || cur <= 0) return false;
  return cur < floor - 0.5;
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

async function loadProductPushContext(productId) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid < 1) return null;

  const prodRes = await query(
    `SELECT id, profile_id, organization_id, sku, wb_draft,
            mp_wb_vendor_code
     FROM products WHERE id = $1 LIMIT 1`,
    [pid]
  );
  const product = prodRes.rows?.[0];
  if (!product) return null;

  const pricesRes = await query(
    `SELECT marketplace, min_price
     FROM product_marketplace_prices
     WHERE product_id = $1 AND min_price IS NOT NULL AND min_price > 0`,
    [pid]
  );
  const floors = {};
  for (const row of pricesRes.rows || []) {
    const mp = String(row.marketplace || '').toLowerCase();
    const f = floorRub(row.min_price);
    if (f != null) floors[mp] = f;
  }

  const skusRes = await query(
    `SELECT marketplace, sku, marketplace_product_id, mp_extra
     FROM product_skus WHERE product_id = $1`,
    [pid]
  );
  const productSkus = skusRes.rows || [];

  return { product, floors, productSkus };
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

async function pushOzonForProduct(ctx, floor, orgId, profileId) {
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

  const ozonApiOpts = { ozonOverride: { client_id: clientId, api_key: apiKey } };
  let mpMin = null;
  let mpPrice = null;
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
  } catch (e) {
    logger.warn('[MP MinPrice Push] Ozon read failed', { message: e?.message || String(e) });
  }

  if (!needsOzonMinPricePush({ erpFloor: floor, mpMinPrice: mpMin, mpPrice })) {
    return { marketplace: 'ozon', skipped: true, reason: 'already_ok', floor };
  }

  const entry = {
    min_price: String(floor),
    currency_code: 'RUB',
    auto_action_enabled: 'DISABLED',
    auto_add_to_ozon_actions_list_enabled: 'DISABLED',
  };
  if (ozonProductId) entry.product_id = ozonProductId;
  else entry.offer_id = offerId;
  // Не занижаем цену: поднимаем только если знаем текущую и она ниже пола.
  if (Number.isFinite(mpPrice) && mpPrice < floor) {
    entry.price = String(floor);
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
    ozonProductId,
    offerId,
    raisedPrice: Boolean(entry.price),
  });
  return { marketplace: 'ozon', ok: true, floor, raisedPrice: Boolean(entry.price) };
}

async function pushWbForProduct(ctx, floor, orgId, profileId) {
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
  if (!needsWbFloorPush({ erpFloor: floor, price, discount })) {
    return { marketplace: 'wb', skipped: true, reason: 'already_ok', floor };
  }

  const newPrice = wbPriceToMeetFloor(floor, discount);
  if (newPrice == null) {
    return { marketplace: 'wb', skipped: true, reason: 'invalid_floor' };
  }

  const payload = {
    data: [
      {
        nmID,
        price: newPrice,
        ...(Number.isFinite(discount) ? { discount: Math.round(discount) } : {}),
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
    newPrice,
    discount,
  });
  return { marketplace: 'wb', ok: true, floor, newPrice };
}

async function pushYmForProduct(ctx, floor, orgId, profileId) {
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

  // Кабинеты с onlyDefaultPrice правятся через businesses/*, не campaigns/*.
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
  if (!needsYmFloorPush({ erpFloor: floor, currentPrice })) {
    return { marketplace: 'ym', skipped: true, reason: 'already_ok', floor };
  }

  const newValue = Math.max(floor, Math.ceil(currentPrice));
  const agent = getYandexHttpsAgent();
  const offerPayload = useBusiness
    ? { offerId, price: { value: newValue, currencyId: 'RUR' } }
    : { id: offerId, price: { value: newValue, currencyId: 'RUR' } };
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
    previous: currentPrice,
    via: useBusiness ? 'business' : 'campaign',
  });
  return { marketplace: 'ym', ok: true, floor, newValue };
}

/**
 * Пуш мин. цен для одного товара ERP.
 */
export async function pushForProduct(productId) {
  if (!isMinPricePushEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }
  const ctx = await loadProductPushContext(productId);
  if (!ctx) return { skipped: true, reason: 'product_not_found' };
  if (!Object.keys(ctx.floors).length) {
    return { skipped: true, reason: 'no_stored_min_prices' };
  }

  const orgId = ctx.product.organization_id != null ? Number(ctx.product.organization_id) : null;
  const profileId = ctx.product.profile_id != null ? Number(ctx.product.profile_id) : null;
  const results = [];

  if (ctx.floors.ozon != null) {
    try {
      results.push(await pushOzonForProduct(ctx, ctx.floors.ozon, orgId, profileId));
    } catch (e) {
      results.push({ marketplace: 'ozon', ok: false, error: e?.message || String(e) });
    }
  }
  if (ctx.floors.wb != null) {
    try {
      results.push(await pushWbForProduct(ctx, ctx.floors.wb, orgId, profileId));
    } catch (e) {
      results.push({ marketplace: 'wb', ok: false, error: e?.message || String(e) });
    }
  }
  if (ctx.floors.ym != null) {
    try {
      results.push(await pushYmForProduct(ctx, ctx.floors.ym, orgId, profileId));
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

function normVendorKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

async function fetchAllWbGoodsPrices(token) {
  const byNm = new Map();
  const byVendor = new Map();
  const limit = 1000;
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const { response, text } = await fetchWithRetry(
      `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?${qs}`,
      {
        method: 'GET',
        headers: { Authorization: String(token), Accept: 'application/json' },
      },
      { label: 'WB list/goods page' }
    );
    if (!response.ok) {
      throw new Error(`WB list/goods ${response.status}: ${text.substring(0, 200)}`);
    }
    const data = JSON.parse(text || '{}');
    const list = data?.data?.listGoods || [];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const g of list) {
      const nm = Number(g.nmID ?? g.nmId);
      if (Number.isFinite(nm) && nm > 0) byNm.set(nm, g);
      const vc = normVendorKey(g.vendorCode);
      if (vc) byVendor.set(vc, g);
    }
    if (list.length < limit) break;
    offset += limit;
    await sleep(650);
  }
  return { byNm, byVendor };
}

async function uploadWbPriceBatch(token, items) {
  let uploaded = 0;
  for (let i = 0; i < items.length; i += 1000) {
    const chunk = items.slice(i, i + 1000);
    const { response, text } = await fetchWithRetry(
      'https://discounts-prices-api.wildberries.ru/api/v2/upload/task',
      {
        method: 'POST',
        headers: {
          Authorization: String(token),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ data: chunk }),
      },
      { label: 'WB upload/task batch' }
    );
    if (!response.ok) {
      throw new Error(`WB upload/task ${response.status}: ${text.substring(0, 200)}`);
    }
    uploaded += chunk.length;
    if (i + 1000 < items.length) await sleep(700);
  }
  return uploaded;
}

/**
 * Дневная сверка: батч-чтение цен WB → поднять только effective &lt; пола;
 * для затронутых SKU дополнительно точечный пуш Ozon/YM.
 * Полный каталог по всем МП остаётся на ночном cron.
 */
export async function reconcileBelowFloor() {
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

    const floorsRes = await query(
      `SELECT p.id AS product_id, p.profile_id, p.organization_id, p.sku, p.wb_draft, p.mp_wb_vendor_code,
              pmp.marketplace, pmp.min_price
       FROM product_marketplace_prices pmp
       JOIN products p ON p.id = pmp.product_id
       WHERE pmp.min_price IS NOT NULL AND pmp.min_price > 0`
    );

    /** @type {Map<number, { product: object, floors: Record<string, number>, productSkus: object[] }>} */
    const byProduct = new Map();
    for (const row of floorsRes.rows || []) {
      const pid = Number(row.product_id);
      if (!Number.isFinite(pid)) continue;
      let entry = byProduct.get(pid);
      if (!entry) {
        entry = {
          product: {
            id: pid,
            profile_id: row.profile_id,
            organization_id: row.organization_id,
            sku: row.sku,
            wb_draft: row.wb_draft,
            mp_wb_vendor_code: row.mp_wb_vendor_code,
          },
          floors: {},
          productSkus: [],
        };
        byProduct.set(pid, entry);
      }
      const mp = String(row.marketplace || '').toLowerCase();
      const f = floorRub(row.min_price);
      if (f != null) entry.floors[mp] = f;
    }

    const productIds = [...byProduct.keys()];
    if (productIds.length) {
      const skusRes = await query(
        `SELECT product_id, marketplace, sku, marketplace_product_id, mp_extra
         FROM product_skus WHERE product_id = ANY($1::bigint[])`,
        [productIds]
      );
      for (const s of skusRes.rows || []) {
        const entry = byProduct.get(Number(s.product_id));
        if (entry) entry.productSkus.push(s);
      }
    }

    /** org|profile → [{ctx, floor}] */
    const wbGroups = new Map();
    for (const entry of byProduct.values()) {
      if (entry.floors.wb == null) continue;
      const orgId = entry.product.organization_id != null ? Number(entry.product.organization_id) : null;
      const profileId = entry.product.profile_id != null ? Number(entry.product.profile_id) : null;
      const key = `${orgId ?? 'x'}|${profileId ?? 'x'}`;
      if (!wbGroups.has(key)) wbGroups.set(key, { orgId, profileId, items: [] });
      wbGroups.get(key).items.push(entry);
    }

    let wbScanned = 0;
    let wbBelow = 0;
    let wbUploaded = 0;
    const touchedProductIds = new Set();

    for (const group of wbGroups.values()) {
      const cfg = await integrationsService.getMarketplaceConfig('wildberries', {
        organizationId: group.orgId,
        profileId: group.profileId,
      });
      const token = integrationsService._normalizeWbToken(cfg?.api_key ?? cfg?.apiKey);
      if (!token) continue;

      let catalog;
      try {
        catalog = await fetchAllWbGoodsPrices(token);
      } catch (e) {
        logger.warn('[MP MinPrice Push] reconcile WB catalog failed', {
          message: e?.message || String(e),
        });
        continue;
      }
      wbScanned += catalog.byNm.size;

      const uploads = [];
      for (const entry of group.items) {
        const nmSync = resolveWbNmIdSync(entry.productSkus, entry.product);
        const vendor = resolveWbVendorCode(entry.productSkus, entry.product);
        const hit =
          (nmSync && catalog.byNm.get(nmSync)) ||
          (vendor && catalog.byVendor.get(normVendorKey(vendor))) ||
          null;
        if (!hit) continue;
        const size0 = Array.isArray(hit.sizes) ? hit.sizes[0] : null;
        const price =
          hit.price != null
            ? Number(hit.price)
            : size0?.price != null
              ? Number(size0.price)
              : null;
        const discount = hit.discount != null ? Number(hit.discount) : 0;
        if (!needsWbFloorPush({ erpFloor: entry.floors.wb, price, discount })) continue;
        const newPrice = wbPriceToMeetFloor(entry.floors.wb, discount);
        const nmID = Number(hit.nmID ?? hit.nmId);
        if (newPrice == null || !Number.isFinite(nmID)) continue;
        uploads.push({
          nmID,
          price: newPrice,
          ...(Number.isFinite(discount) ? { discount: Math.round(discount) } : {}),
        });
        touchedProductIds.add(Number(entry.product.id));
        wbBelow += 1;
      }

      if (uploads.length) {
        try {
          wbUploaded += await uploadWbPriceBatch(token, uploads);
        } catch (e) {
          logger.warn('[MP MinPrice Push] reconcile WB upload failed', {
            message: e?.message || String(e),
            count: uploads.length,
          });
        }
      }
    }

    // Точечно Ozon/YM для SKU, где на WB ушли ниже пола (часто те же карточки).
    let sidePushed = 0;
    let sideFailed = 0;
    const sideIds = [...touchedProductIds];
    for (let i = 0; i < sideIds.length; i++) {
      const out = await pushForProduct(sideIds[i]).catch((e) => ({
        failed: 1,
        error: e?.message || String(e),
      }));
      sidePushed += out.pushed || 0;
      sideFailed += out.failed || 0;
      if (i > 0 && i % 10 === 0) await sleep(300);
    }

    const result = {
      mode: 'reconcile',
      products: byProduct.size,
      wbScanned,
      wbBelow,
      wbUploaded,
      sideProducts: sideIds.length,
      sidePushed,
      sideFailed,
    };
    logger.info('[MP MinPrice Push] reconcile done', result);
    return result;
  } finally {
    _fullRunInProgress = false;
  }
}

/**
 * Полный прогон: все товары с сохранёнными мин. ценами.
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

    const lim = limit != null && Number.isFinite(Number(limit)) ? Number(limit) : null;
    const r = await query(
      `SELECT DISTINCT product_id
       FROM product_marketplace_prices
       WHERE min_price IS NOT NULL AND min_price > 0
       ORDER BY product_id ASC
       ${lim != null ? `LIMIT ${Math.max(1, Math.floor(lim))}` : ''}`
    );
    const ids = (r.rows || [])
      .map((row) => Number(row.product_id))
      .filter((n) => Number.isFinite(n) && n > 0);

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

    logger.info('[MP MinPrice Push] full run done', {
      products: ids.length,
      pushed,
      failed,
      skipped,
    });
    return { products: ids.length, pushed, failed, skipped };
  } finally {
    _fullRunInProgress = false;
  }
}

export default {
  isMinPricePushEnabled,
  floorRub,
  normalizeMpOfferId,
  pricesRoughlyEqual,
  wbEffectivePrice,
  wbPriceToMeetFloor,
  needsOzonMinPricePush,
  needsWbFloorPush,
  needsYmFloorPush,
  schedulePushForProduct,
  pushForProduct,
  pushForAllProfiles,
  reconcileBelowFloor,
};
