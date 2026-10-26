/**
 * Вход и выход из акций Ozon, Wildberries и Яндекс Маркета.
 * Вход разрешён только если цена акции не ниже сохранённого пола.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import integrationsService from './integrations.service.js';
import pricesService from './prices.service.js';
import { netProfitAtSalePrice } from './min-price-calculator.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { joinBlockMessage, ozonEntryPrice, promoJoinDecision } from '../utils/promoParticipation.js';

const YM_API = 'https://api.partner.market.yandex.ru';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scopeOf(options = {}) {
  return pricesService._integrationScopeFromOptions(options);
}

async function loadFloors(productIds, marketplace) {
  const ids = [...new Set(productIds.map((id) => Number(id)).filter((n) => n > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const sqlWithSchemes = `
    SELECT product_id, min_price, min_price_fbs, min_price_fbo
    FROM product_marketplace_prices
    WHERE product_id = ANY($1::bigint[]) AND marketplace = $2`;
  const sqlPlain = `
    SELECT product_id, min_price
    FROM product_marketplace_prices
    WHERE product_id = ANY($1::bigint[]) AND marketplace = $2`;
  let rows = [];
  try {
    rows = (await query(sqlWithSchemes, [ids, marketplace])).rows || [];
  } catch (e) {
    if (!String(e?.message || '').includes('min_price_fbs')) throw e;
    rows = (await query(sqlPlain, [ids, marketplace])).rows || [];
  }
  for (const row of rows) {
    const fbs = num(row.min_price_fbs);
    const fbo = num(row.min_price_fbo);
    const plain = num(row.min_price);
    const plainOk = plain != null && plain > 0 ? plain : null;
    const fbsOk = fbs != null && fbs > 0 ? fbs : null;
    const fboOk = fbo != null && fbo > 0 ? fbo : null;
    const parts = [fbsOk, fboOk, plainOk].filter((n) => n != null);
    const floor = parts.length ? Math.max(...parts) : null;
    let scheme = marketplace === 'wb' ? 'FBO' : 'FBS';
    if (fboOk != null && (fbsOk == null || fboOk >= fbsOk)) scheme = 'FBO';
    else if (fbsOk != null) scheme = 'FBS';
    // Как в карточке: для Ozon/ЯМ пустой FBS подменяется общей мин. ценой, для WB — пустой FBO.
    const cardFbs = marketplace === 'wb' ? fbsOk : (fbsOk ?? plainOk);
    const cardFbo = marketplace === 'wb' ? (fboOk ?? plainOk) : fboOk;
    map.set(Number(row.product_id), {
      floor,
      scheme,
      card_min: plainOk,
      card_min_fbs: cardFbs,
      card_min_fbo: cardFbo,
    });
  }
  return map;
}

async function loadProducts(productIds) {
  const ids = [...new Set(productIds.map((id) => Number(id)).filter((n) => n > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const result = await query(
    `SELECT p.id, p.cost, p.additional_expenses, p.min_price,
            p.min_profit_ozon, p.min_profit_wb, p.min_profit_ym,
            p.buyout_rate, p.buyout_rate_ozon, p.buyout_rate_wb, p.buyout_rate_ym,
            p.length, p.width, p.height,
            o.tax_system AS organization_tax_system, o.vat AS organization_vat
     FROM products p
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = ANY($1::bigint[])`,
    [ids]
  );
  for (const row of result.rows || []) map.set(Number(row.id), row);
  return map;
}

async function loadCalculators(productIds, marketplace) {
  const ids = [...new Set(productIds.map((id) => Number(id)).filter((n) => n > 0))];
  const map = new Map();
  if (!ids.length) return map;
  try {
    const result = await query(
      `SELECT product_id, calculator
       FROM product_mp_calculator_cache
       WHERE product_id = ANY($1::bigint[]) AND marketplace = $2`,
      [ids, marketplace]
    );
    for (const row of result.rows || []) {
      let calc = row.calculator;
      if (typeof calc === 'string') {
        try { calc = JSON.parse(calc); } catch { calc = null; }
      }
      if (calc && typeof calc === 'object') map.set(Number(row.product_id), calc);
    }
  } catch (e) {
    logger.warn('[Promotions] calculator cache read failed', e?.message || e);
  }
  return map;
}

async function loadSpp(marketplace, options) {
  const scope = scopeOf(options);
  const key = marketplace === 'wb' ? 'wildberries' : marketplace === 'ym' ? 'yandex' : 'ozon';
  try {
    const cfg = await integrationsService.getMarketplaceConfig(key, scope);
    const spp = num(cfg?.spp_percent);
    return {
      spp: spp != null && spp >= 0 ? spp : null,
      wbAcquiring: num(cfg?.acquiring_percent),
      wbGem: num(cfg?.gem_services_percent),
    };
  } catch {
    return { spp: null, wbAcquiring: null, wbGem: null };
  }
}

function entryPriceOf(marketplace, row) {
  if (marketplace === 'ozon') return ozonEntryPrice(row);
  if (marketplace === 'wb') {
    const plan = num(row.planPrice ?? row.plan_price);
    return plan != null && plan > 0 ? plan : null;
  }
  const current = num(row.promo_price ?? row.promoPrice);
  const max = num(row.max_promo_price ?? row.maxPromoPrice);
  if (row.participating && current != null && current > 0) return current;
  if (max != null && max > 0) return max;
  return current != null && current > 0 ? current : null;
}

export async function attachPromoEconomics(rows, marketplace, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = list.map((row) => Number(row.our_product_id)).filter((n) => n > 0);
  const [floors, products, calculators, fees] = await Promise.all([
    loadFloors(ids, marketplace),
    loadProducts(ids),
    loadCalculators(ids, marketplace),
    loadSpp(marketplace, options),
  ]);
  return list.map((row) => {
    const pid = Number(row.our_product_id);
    const known = floors.get(pid);
    const floor = known?.floor ?? null;
    const entry = entryPriceOf(marketplace, row);
    const decision = promoJoinDecision({ entryPrice: entry, floor });
    const product = products.get(pid);
    const calculator = calculators.get(pid);
    let profit = null;
    if (product && calculator && entry != null) {
      const base = (num(product.cost) || 0) + (num(product.additional_expenses) || 0);
      profit = netProfitAtSalePrice(
        entry,
        base,
        calculator,
        marketplace,
        product,
        marketplace === 'wb' ? fees.wbAcquiring : null,
        marketplace === 'wb' ? fees.wbGem : null,
        null,
        known?.scheme || null,
        fees.spp
      );
    }
    return {
      ...row,
      entry_price: entry,
      floor,
      card_min: known?.card_min ?? null,
      card_min_fbs: known?.card_min_fbs ?? null,
      card_min_fbo: known?.card_min_fbo ?? null,
      profit_rub: profit,
      below_floor: decision.reason === 'below_floor',
      join_block_reason: decision.ok ? null : decision.reason,
    };
  });
}

async function floorForProduct(productId, marketplace) {
  const floors = await loadFloors([productId], marketplace);
  return floors.get(Number(productId))?.floor ?? null;
}

export async function joinOzonAction({ actionId, products = [] }, options = {}) {
  const id = Number(actionId);
  if (!Number.isFinite(id) || id < 1) return { ok: false, error: 'Некорректный ID акции' };
  const { client_id, api_key } = await pricesService._getOzonApiCredentials(options);
  if (!client_id || !api_key) return { ok: false, error: 'Настройте интеграцию Ozon' };

  const allowed = [];
  const blocked = [];
  for (const row of products) {
    const ozonProductId = Number(row.ozonProductId ?? row.product_id ?? row.id);
    const actionPrice = num(row.actionPrice ?? row.action_price ?? row.entry_price);
    const ourProductId = Number(row.ourProductId ?? row.our_product_id);
    if (!Number.isFinite(ozonProductId) || ozonProductId < 1 || actionPrice == null) {
      blocked.push({ ozonProductId, reason: 'no_entry_price', message: joinBlockMessage('no_entry_price') });
      continue;
    }
    const floor = Number.isFinite(ourProductId) ? await floorForProduct(ourProductId, 'ozon') : null;
    const decision = promoJoinDecision({ entryPrice: actionPrice, floor });
    if (!decision.ok) {
      blocked.push({ ozonProductId, ourProductId, reason: decision.reason, message: joinBlockMessage(decision.reason) });
      continue;
    }
    // action_price — та же единая предельная цена, что и в «Ценах»: Ozon копирует её во все разделы.
    const item = { product_id: ozonProductId, action_price: actionPrice };
    const stock = num(row.stock);
    if (stock != null && stock > 0) item.stock = Math.round(stock);
    allowed.push(item);
  }
  if (!allowed.length) {
    return { ok: false, error: blocked[0]?.message || 'Нет товаров, которые можно добавить', blocked, added: 0 };
  }

  const response = await fetch('https://api-seller.ozon.ru/v2/actions/products/activate', {
    method: 'POST',
    headers: pricesService._ozonApiHeaders(client_id, api_key),
    body: JSON.stringify({ action_id: id, products: allowed }),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    return { ok: false, error: `Ozon ${response.status}: ${text.slice(0, 240)}`, blocked, added: 0 };
  }
  await pricesService.forgetOzonActionProductsCache(id, options).catch(() => {});
  const result = data?.result && typeof data.result === 'object' ? data.result : data || {};
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];
  const added = Array.isArray(result.product_ids) ? result.product_ids.length : Math.max(0, allowed.length - rejected.length);
  return {
    ok: rejected.length === 0,
    added,
    blocked,
    rejected,
    error: rejected.length ? 'Ozon отклонил часть товаров' : undefined,
  };
}

export async function leaveOzonAction({ actionId, ozonProductIds = [] }, options = {}) {
  const id = Number(actionId);
  if (!Number.isFinite(id) || id < 1) return { ok: false, error: 'Некорректный ID акции' };
  const { client_id, api_key } = await pricesService._getOzonApiCredentials(options);
  if (!client_id || !api_key) return { ok: false, error: 'Настройте интеграцию Ozon' };
  const result = await pricesService._deactivateOzonActionProducts(client_id, api_key, id, ozonProductIds);
  await pricesService.forgetOzonActionProductsCache(id, options).catch(() => {});
  if (!result.ok) return { ok: false, error: result.error || 'Не удалось выйти из акции', ...result };
  return { ok: true, deactivated: result.deactivated, rejected: result.rejected || [] };
}

export async function joinWbPromotion({ promotionId, items = [] }, options = {}) {
  const id = Number(promotionId);
  if (!Number.isFinite(id) || id < 1) return { ok: false, error: 'Некорректный ID акции' };
  const { api_key } = await pricesService._getWbApiCredentials(options);
  if (!api_key) return { ok: false, error: 'Настройте интеграцию Wildberries' };

  const allowed = [];
  const blocked = [];
  for (const row of items) {
    const nmId = Number(row.nmId ?? row.id);
    const planPrice = num(row.planPrice ?? row.plan_price ?? row.entry_price);
    const ourProductId = Number(row.ourProductId ?? row.our_product_id);
    if (!Number.isFinite(nmId) || nmId < 1 || planPrice == null) {
      blocked.push({ nmId, reason: 'no_entry_price', message: joinBlockMessage('no_entry_price') });
      continue;
    }
    const floor = Number.isFinite(ourProductId) ? await floorForProduct(ourProductId, 'wb') : null;
    const decision = promoJoinDecision({ entryPrice: planPrice, floor });
    if (!decision.ok) {
      blocked.push({ nmId, ourProductId, reason: decision.reason, message: joinBlockMessage(decision.reason) });
      continue;
    }
    allowed.push(nmId);
  }
  if (!allowed.length) {
    return { ok: false, error: blocked[0]?.message || 'Нет товаров, которые можно добавить', blocked, added: 0 };
  }

  const response = await fetch('https://dp-calendar-api.wildberries.ru/api/v1/calendar/promotions/upload', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: String(api_key),
    },
    body: JSON.stringify({
      data: { promotionID: id, uploadNow: true, nomenclatures: allowed },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `WB ${response.status}: ${text.slice(0, 240)}`, blocked, added: 0 };
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  await pricesService.forgetActionsListCache('wbPromotionsCache', options).catch(() => {});
  return {
    ok: true,
    added: allowed.length,
    blocked,
    uploadId: data?.data?.uploadID ?? data?.data?.uploadId ?? null,
  };
}

async function ymContext(options) {
  const scope = scopeOf(options);
  const cfg = await integrationsService.getMarketplaceConfig('yandex', scope);
  const apiKey = integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
  const businessId = String(cfg?.business_id ?? cfg?.businessId ?? '').trim();
  if (!apiKey || !businessId) {
    return { error: 'Настройте интеграцию Яндекс Маркета: API-ключ и business id' };
  }
  return { apiKey, businessId };
}

async function ymPost(path, apiKey, body) {
  const response = await fetch(`${YM_API}${path}`, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    agent: getYandexHttpsAgent(),
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok || data?.status === 'ERROR') {
    const msg = data?.errors?.[0]?.message || text.slice(0, 240) || `HTTP ${response.status}`;
    return { ok: false, error: `Яндекс Маркет: ${msg}`, data };
  }
  return { ok: true, data };
}

export async function listYmPromos(options = {}) {
  const ctx = await ymContext(options);
  if (ctx.error) return { ok: false, error: ctx.error, promos: [] };
  const result = await ymPost(`/v2/businesses/${encodeURIComponent(ctx.businessId)}/promos`, ctx.apiKey, {});
  if (!result.ok) return { ok: false, error: result.error, promos: [] };
  const promos = result.data?.result?.promos || result.data?.promos || [];
  const list = (Array.isArray(promos) ? promos : []).map((promo) => ({
    ...promo,
    id: promo.id || promo.promoId,
  }));
  return { ok: true, promos: list };
}

function ymOfferView(offer, our) {
  const discount = offer?.params?.discountParams || {};
  const status = String(offer?.status || '');
  const participating = status !== '' && status !== 'NOT_PARTICIPATING';
  return {
    offer_id: offer?.offerId ?? null,
    status,
    participating,
    price: num(discount.price),
    promo_price: num(discount.promoPrice),
    max_promo_price: num(discount.maxPromoPrice),
    our_product_id: our?.id ?? null,
    our_product_name: our?.name ?? null,
    our_sku: our?.sku ?? null,
  };
}

export async function listYmPromoOffers(promoId, options = {}) {
  const ctx = await ymContext(options);
  if (ctx.error) return { ok: false, error: ctx.error, offers: [] };
  const id = String(promoId || '').trim();
  if (!id) return { ok: false, error: 'Некорректный ID акции', offers: [] };

  const offers = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const path = `/v2/businesses/${encodeURIComponent(ctx.businessId)}/promos/offers?limit=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const result = await ymPost(path, ctx.apiKey, { promoId: id });
    if (!result.ok) return { ok: false, error: result.error, offers: [] };
    const chunk = result.data?.result?.offers || [];
    if (Array.isArray(chunk)) offers.push(...chunk);
    pageToken = result.data?.result?.paging?.nextPageToken || '';
    if (!pageToken || !chunk.length) break;
  }

  const offerIds = offers.map((o) => String(o.offerId || '').trim()).filter(Boolean);
  const scope = scopeOf(options);
  const params = [offerIds];
  let sql = `
    SELECT p.id, p.name, p.sku, ps.sku AS offer_id
    FROM products p
    JOIN product_skus ps ON ps.product_id = p.id AND ps.marketplace = 'ym'
    WHERE TRIM(TRAILING ';' FROM TRIM(ps.sku)) = ANY($1::text[])`;
  if (scope.profileId != null && String(scope.profileId).trim() !== '') {
    params.push(Number(scope.profileId));
    sql += ` AND p.profile_id = $${params.length}`;
  }
  if (scope.organizationId != null && String(scope.organizationId).trim() !== '') {
    params.push(Number(scope.organizationId));
    sql += ` AND p.organization_id = $${params.length}`;
  }
  const our = new Map();
  if (offerIds.length) {
    const found = await query(sql, params);
    for (const row of found.rows || []) {
      our.set(String(row.offer_id).trim().toLowerCase(), row);
    }
  }
  const views = offers
    .map((offer) => {
      const key = String(offer.offerId || '').trim().toLowerCase();
      const match = our.get(key);
      if (!match) return null;
      return ymOfferView(offer, match);
    })
    .filter(Boolean);
  const enriched = await attachPromoEconomics(views, 'ym', options);
  return { ok: true, offers: enriched };
}

export async function joinYmPromo({ promoId, offers = [] }, options = {}) {
  const ctx = await ymContext(options);
  if (ctx.error) return { ok: false, error: ctx.error };
  const id = String(promoId || '').trim();
  const live = await listYmPromoOffers(id, options);
  if (!live.ok) return live;
  const byOffer = new Map((live.offers || []).map((row) => [String(row.offer_id), row]));

  const allowed = [];
  const blocked = [];
  for (const row of offers) {
    const offerId = String(row.offerId ?? row.offer_id ?? '').trim();
    const known = byOffer.get(offerId);
    const entry = num(row.promoPrice ?? row.promo_price) ?? known?.max_promo_price ?? known?.entry_price;
    const floor = known?.floor ?? (known?.our_product_id ? await floorForProduct(known.our_product_id, 'ym') : null);
    const decision = promoJoinDecision({ entryPrice: entry, floor });
    if (!decision.ok) {
      blocked.push({ offerId, reason: decision.reason, message: joinBlockMessage(decision.reason) });
      continue;
    }
    const regular = num(known?.price) ?? entry;
    allowed.push({
      offerId,
      params: { discountParams: { price: regular, promoPrice: entry } },
    });
  }
  if (!allowed.length) {
    return { ok: false, error: blocked[0]?.message || 'Нет товаров, которые можно добавить', blocked, added: 0 };
  }
  const result = await ymPost(
    `/v2/businesses/${encodeURIComponent(ctx.businessId)}/promos/offers/update`,
    ctx.apiKey,
    { promoId: id, offers: allowed }
  );
  if (!result.ok) return { ok: false, error: result.error, blocked, added: 0 };
  const rejected = result.data?.result?.rejectedOffers || [];
  return {
    ok: rejected.length === 0,
    added: allowed.length - rejected.length,
    blocked,
    rejected,
    error: rejected.length ? 'Яндекс Маркет отклонил часть товаров' : undefined,
  };
}

export async function leaveYmPromo({ promoId, offerIds = [] }, options = {}) {
  const ctx = await ymContext(options);
  if (ctx.error) return { ok: false, error: ctx.error };
  const ids = [...new Set(offerIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'Не указаны товары' };
  const result = await ymPost(
    `/v2/businesses/${encodeURIComponent(ctx.businessId)}/promos/offers/delete`,
    ctx.apiKey,
    { promoId: String(promoId || '').trim(), offerIds: ids }
  );
  if (!result.ok) return result;
  const rejected = result.data?.result?.rejectedOffers || [];
  return { ok: rejected.length === 0, removed: ids.length - rejected.length, rejected };
}

export async function attachWbNomenclatures(nomenclatures, options = {}) {
  const list = Array.isArray(nomenclatures) ? nomenclatures : [];
  const nmIds = list.map((row) => Number(row.id)).filter((n) => n > 0);
  const scope = scopeOf(options);
  const our = new Map();
  if (nmIds.length) {
    const params = [nmIds.map(String), nmIds];
    let sql = `
      SELECT p.id, p.name, p.sku,
             TRIM(TRAILING ';' FROM TRIM(ps.sku)) AS mp_sku,
             ps.marketplace_product_id
      FROM product_skus ps
      JOIN products p ON p.id = ps.product_id
      WHERE ps.marketplace = 'wb'
        AND (
          TRIM(TRAILING ';' FROM TRIM(ps.sku)) = ANY($1::text[])
          OR ps.marketplace_product_id = ANY($2::bigint[])
        )`;
    if (scope.profileId != null && String(scope.profileId).trim() !== '') {
      params.push(Number(scope.profileId));
      sql += ` AND p.profile_id = $${params.length}`;
    }
    if (scope.organizationId != null && String(scope.organizationId).trim() !== '') {
      params.push(Number(scope.organizationId));
      sql += ` AND p.organization_id = $${params.length}`;
    }
    const found = await query(sql, params);
    for (const row of found.rows || []) {
      if (row.mp_sku) our.set(String(row.mp_sku), row);
      if (row.marketplace_product_id != null) our.set(String(row.marketplace_product_id), row);
    }
  }
  const linked = list.map((row) => {
    const match = our.get(String(row.id));
    return {
      ...row,
      our_product_id: match?.id ?? null,
      our_product_name: match?.name ?? null,
      our_sku: match?.sku ?? null,
    };
  });
  return attachPromoEconomics(linked, 'wb', options);
}
