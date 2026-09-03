/**
 * Контент-рейтинг карточек: Ozon (rating-by-sku), Яндекс.Маркет (offer-cards).
 * WB официально не отдаёт балл качества карточки через API.
 */

import { query } from '../config/database.js';
import logger from '../utils/logger.js';
import repositoryFactory from '../config/repository-factory.js';
import integrationsService from './integrations.service.js';
import {
  parseCardQualitySettings,
  isCardQualityBelowThreshold,
  CARD_QUALITY_MARKETPLACES,
} from '../utils/cardQualitySettings.js';

const MP_LABEL = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };
const OZON_RATING_CHUNK = 80;
const YM_OFFER_CHUNK = 50;
const WB_UNAVAILABLE = {
  score: null,
  max: 100,
  source: 'wb',
  unavailable: true,
  unavailable_reason: 'api',
  fetched_at: null,
  groups: [],
  recommendations: [],
};

function parseExtra(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function toIsoNow() {
  return new Date().toISOString();
}

function uniqNums(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = String(Math.trunc(n));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Math.trunc(n));
  }
  return out;
}

export function collectOzonMarketSkus(info, extra = {}) {
  const candidates = [
    info?.sku,
    info?.ozon_sku,
    info?.ozonSku,
    extra?.ozon_sku,
    extra?.ozonSku,
    extra?.marketSku,
    ...(Array.isArray(info?.sources) ? info.sources.map((s) => s?.sku) : []),
    ...(Array.isArray(info?.stocks?.stocks) ? info.stocks.stocks.map((s) => s?.sku) : []),
  ];
  return uniqNums(candidates);
}

function truncateText(s, max = 220) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function normalizeOzonRatingProduct(raw, skuFallback = null) {
  if (!raw || typeof raw !== 'object') return null;
  const scoreRaw = raw.rating ?? raw.content_rating ?? raw.contentRating;
  const score = Number(scoreRaw);
  const groupsIn = Array.isArray(raw.groups) ? raw.groups : [];
  const groups = groupsIn.slice(0, 12).map((g) => ({
    key: g?.key != null ? String(g.key) : null,
    name: g?.name != null ? String(g.name) : null,
    rating: Number.isFinite(Number(g?.rating)) ? Number(g.rating) : null,
    weight: Number.isFinite(Number(g?.weight)) ? Number(g.weight) : null,
  }));
  const recommendations = [];
  for (const g of groupsIn) {
    const conds = Array.isArray(g?.conditions) ? g.conditions : [];
    for (const c of conds) {
      if (c?.fulfilled === true) continue;
      const text = truncateText(c?.description || c?.name || c?.key);
      if (!text) continue;
      recommendations.push({
        text,
        group: g?.name != null ? String(g.name) : null,
      });
      if (recommendations.length >= 12) break;
    }
    if (recommendations.length >= 12) break;
    const recs = Array.isArray(g?.recommendations) ? g.recommendations : [];
    for (const r of recs) {
      const text = truncateText(typeof r === 'string' ? r : r?.description || r?.text);
      if (!text) continue;
      recommendations.push({ text, group: g?.name != null ? String(g.name) : null });
      if (recommendations.length >= 12) break;
    }
    if (recommendations.length >= 12) break;
  }
  return {
    score: Number.isFinite(score) ? score : null,
    max: 100,
    sku: raw.sku != null ? String(raw.sku) : skuFallback != null ? String(skuFallback) : null,
    source: 'ozon',
    unavailable: false,
    fetched_at: toIsoNow(),
    groups,
    recommendations,
  };
}

const YM_REC_LABELS = {
  MAIN: 'Заполните ключевые характеристики',
  ADDITIONAL: 'Заполните дополнительные характеристики',
  PICTURE: 'Добавьте фотографии',
  VIDEO: 'Добавьте видео',
  DESCRIPTION: 'Дополните описание',
  TITLE: 'Уточните название',
};

function ymRecommendationText(rec) {
  if (!rec) return '';
  if (typeof rec === 'string') return truncateText(rec);
  const type = String(rec.type || rec.recommendationType || '').toUpperCase();
  const mapped = YM_REC_LABELS[type];
  const extra = rec.message || rec.text || rec.description || rec.hint;
  if (mapped && extra) return truncateText(`${mapped}: ${extra}`);
  if (mapped) return mapped;
  return truncateText(extra || type);
}

export function normalizeYmContentRating(offerCard) {
  if (!offerCard || typeof offerCard !== 'object') return null;
  const scoreRaw = offerCard.contentRating ?? offerCard.content_rating;
  const score = Number(scoreRaw);
  const recsIn = Array.isArray(offerCard.recommendations) ? offerCard.recommendations : [];
  const recommendations = recsIn
    .map((r) => ({ text: ymRecommendationText(r), type: r?.type != null ? String(r.type) : null }))
    .filter((r) => r.text)
    .slice(0, 12);
  if (!Number.isFinite(score) && !recommendations.length && !offerCard.cardStatus) return null;
  return {
    score: Number.isFinite(score) ? score : null,
    max: 100,
    source: 'ym',
    unavailable: false,
    fetched_at: toIsoNow(),
    card_status: offerCard.cardStatus != null ? String(offerCard.cardStatus) : null,
    content_rating_status:
      offerCard.contentRatingStatus != null ? String(offerCard.contentRatingStatus) : null,
    groups: [],
    recommendations,
  };
}

export function parseStoredContentRating(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unavailable = raw.unavailable === true;
  const score = Number(raw.score);
  return {
    score: Number.isFinite(score) ? score : null,
    max: Number.isFinite(Number(raw.max)) ? Number(raw.max) : 100,
    source: raw.source != null ? String(raw.source) : null,
    unavailable,
    unavailable_reason: raw.unavailable_reason != null ? String(raw.unavailable_reason) : null,
    fetched_at: raw.fetched_at || raw.fetchedAt || null,
    sku: raw.sku != null ? String(raw.sku) : null,
    card_status: raw.card_status || raw.cardStatus || null,
    content_rating_status: raw.content_rating_status || raw.contentRatingStatus || null,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    recommendations: Array.isArray(raw.recommendations) ? raw.recommendations : [],
  };
}

async function storeRating(productId, marketplace, rating) {
  const numId = Number(productId);
  const mp = String(marketplace || '').toLowerCase();
  if (!Number.isFinite(numId) || numId < 1 || !rating || typeof rating !== 'object') return null;
  const payload = { content_rating: rating };
  if (mp === 'ozon' && rating.sku) {
    payload.ozon_sku = String(rating.sku);
    payload.ozonSku = String(rating.sku);
  }
  await repositoryFactory.getProductsRepository().patchProductSkuMpExtra(numId, mp, payload);
  return rating;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class MarketplaceCardQualityService {
  async getSettings(profileId) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return parseCardQualitySettings({});
    try {
      const res = await query('SELECT card_quality_settings FROM profiles WHERE id = $1 LIMIT 1', [pid]);
      return parseCardQualitySettings(res.rows?.[0]?.card_quality_settings);
    } catch (e) {
      if (String(e?.message || '').includes('card_quality_settings')) {
        return parseCardQualitySettings({});
      }
      throw e;
    }
  }

  async fetchOzonRatingBySkus(skus, apiOpts = {}) {
    const list = uniqNums(skus);
    if (!list.length) return [];
    const out = [];
    for (let i = 0; i < list.length; i += OZON_RATING_CHUNK) {
      const chunk = list.slice(i, i + OZON_RATING_CHUNK);
      try {
        const data = await integrationsService._ozonApiPost(
          '/v1/product/rating-by-sku',
          { skus: chunk },
          apiOpts
        );
        const products = data?.products ?? data?.result?.products ?? [];
        if (Array.isArray(products)) out.push(...products);
      } catch (e) {
        logger.warn('[CardQuality] Ozon rating-by-sku failed', {
          count: chunk.length,
          message: e?.message || String(e),
        });
      }
      if (i + OZON_RATING_CHUNK < list.length) await sleep(250);
    }
    return out;
  }

  async ratingFromOzonItem(item, apiOpts = {}) {
    const skus = collectOzonMarketSkus(item);
    if (!skus.length) return null;
    const products = await this.fetchOzonRatingBySkus(skus, apiOpts);
    const hit =
      products.find((p) => skus.includes(Number(p?.sku))) ||
      products[0] ||
      null;
    return normalizeOzonRatingProduct(hit, skus[0]);
  }

  ratingFromYmItem(item) {
    const card = item?.raw?.offerCard && typeof item.raw.offerCard === 'object' ? item.raw.offerCard : item;
    return normalizeYmContentRating(card);
  }

  wbUnavailableRating() {
    return { ...WB_UNAVAILABLE, fetched_at: toIsoNow() };
  }

  async persistRating(productId, marketplace, rating) {
    return storeRating(productId, marketplace, rating);
  }

  /**
   * Обновить оценку одного товара с МП и записать в mp_extra.
   */
  async refreshForProduct({
    productId,
    marketplace,
    profileId = null,
    organizationId = null,
    ozonItem = null,
    ymItem = null,
  } = {}) {
    const mp = String(marketplace || '').toLowerCase();
    const numId = Number(productId);
    if (!Number.isFinite(numId) || numId < 1) {
      const err = new Error('Укажите товар');
      err.statusCode = 400;
      throw err;
    }
    const product = await repositoryFactory.getProductsRepository().findById(numId);
    if (!product) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }
    const orgId =
      organizationId ??
      product.organization_id ??
      product.organizationId ??
      null;
    const apiOpts = { profileId: profileId ?? product.profile_id ?? null, organizationId: orgId };

    if (mp === 'wb') {
      const rating = this.wbUnavailableRating();
      await storeRating(numId, 'wb', rating);
      return rating;
    }

    if (mp === 'ozon') {
      let item = ozonItem;
      if (!item) {
        const productIdOzon = Number(product.ozon_product_id || product.marketplace_ozon_product_id);
        const offerId = String(product.sku_ozon || product.marketplace_skus?.ozon || '').trim();
        if (Number.isFinite(productIdOzon) && productIdOzon > 0) {
          item = await integrationsService.getOzonProductInfo({
            ...apiOpts,
            product_id: productIdOzon,
            skipContentRating: true,
          });
        }
        if (!item && offerId) {
          item = await integrationsService.getOzonProductInfo({
            ...apiOpts,
            offer_id: offerId,
            skipContentRating: true,
          });
        }
      }
      const extra = {};
      if (product.ozon_market_sku) extra.ozon_sku = product.ozon_market_sku;
      let rating = item ? await this.ratingFromOzonItem({ ...item, ...extra }, apiOpts) : null;
      if (!rating) {
        const skus = collectOzonMarketSkus(item, extra);
        if (skus.length) {
          const products = await this.fetchOzonRatingBySkus(skus, apiOpts);
          rating = normalizeOzonRatingProduct(products[0], skus[0]);
        }
      }
      if (!rating) {
        const err = new Error('Не удалось получить контент-рейтинг Ozon: нет SKU карточки.');
        err.statusCode = 404;
        throw err;
      }
      await storeRating(numId, 'ozon', rating);
      return rating;
    }

    if (mp === 'ym') {
      let item = ymItem;
      if (!item) {
        const offerId = String(product.sku_ym || product.marketplace_skus?.ym || product.sku || '').trim();
        if (!offerId) {
          const err = new Error('Укажите артикул Яндекс.Маркета.');
          err.statusCode = 400;
          throw err;
        }
        item = await integrationsService.getYandexProductInfo({
          ...apiOpts,
          offer_id: offerId,
        });
      }
      const rating = this.ratingFromYmItem(item);
      if (!rating) {
        const err = new Error('Яндекс.Маркет не вернул рейтинг карточки.');
        err.statusCode = 404;
        throw err;
      }
      await storeRating(numId, 'ym', rating);
      return rating;
    }

    const err = new Error('Укажите маркетплейс: ozon, wb или ym.');
    err.statusCode = 400;
    throw err;
  }

  async persistFromFetchedItem(productId, marketplace, item, apiOpts = {}) {
    const mp = String(marketplace || '').toLowerCase();
    try {
      if (mp === 'ozon') {
        const rating = item?.content_rating || (await this.ratingFromOzonItem(item, apiOpts));
        if (rating) await storeRating(productId, 'ozon', rating);
        return rating || null;
      }
      if (mp === 'ym') {
        const rating = item?.content_rating || this.ratingFromYmItem(item);
        if (rating) await storeRating(productId, 'ym', rating);
        return rating || null;
      }
      if (mp === 'wb') {
        const rating = this.wbUnavailableRating();
        await storeRating(productId, 'wb', rating);
        return rating;
      }
    } catch (e) {
      logger.warn('[CardQuality] persistFromFetchedItem failed', {
        productId,
        marketplace: mp,
        message: e?.message || String(e),
      });
    }
    return null;
  }

  /**
   * Товары, у которых сохранённый балл ниже порога.
   */
  async listBelowThreshold({ profileId, marketplace = 'all' } = {}) {
    const settings = await this.getSettings(profileId);
    if (!settings.showInCardWork) return [];
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return [];

    const mpFilter = String(marketplace || 'all').toLowerCase();
    const mps =
      mpFilter && mpFilter !== 'all' && CARD_QUALITY_MARKETPLACES.includes(mpFilter)
        ? [mpFilter]
        : ['ozon', 'ym'];

    let rows = [];
    try {
      const res = await query(
        `SELECT ps.product_id, ps.marketplace, ps.mp_extra,
                p.sku AS erp_sku, p.name AS product_name
           FROM product_skus ps
           JOIN products p ON p.id = ps.product_id
          WHERE p.profile_id = $1
            AND ps.marketplace = ANY($2::text[])
            AND COALESCE(p.is_archived, false) = false
            AND ps.mp_extra ? 'content_rating'`,
        [pid, mps]
      );
      rows = res.rows || [];
    } catch (e) {
      logger.warn('[CardQuality] listBelowThreshold query failed', { message: e?.message || String(e) });
      return [];
    }

    const out = [];
    for (const row of rows) {
      const extra = parseExtra(row.mp_extra);
      const rating = parseStoredContentRating(extra.content_rating);
      if (!rating || rating.unavailable || rating.score == null) continue;
      const mp = String(row.marketplace || '').toLowerCase();
      const threshold = settings.thresholds[mp];
      if (!isCardQualityBelowThreshold(rating.score, threshold)) continue;
      out.push({
        productId: Number(row.product_id) || null,
        sku: row.erp_sku,
        erpSku: row.erp_sku,
        productName: row.product_name,
        marketplace: mp,
        score: rating.score,
        threshold,
        rating,
      });
    }
    return out;
  }

  /**
   * Ночное обновление оценок Ozon/YM по кабинету.
   */
  async refreshForProfile(profileId, { maxProducts = 4000 } = {}) {
    const pid = Number(profileId);
    if (!Number.isFinite(pid) || pid < 1) return { ok: false, reason: 'no_profile' };
    const started = Date.now();
    let ozonUpdated = 0;
    let ymUpdated = 0;
    let failed = 0;

    let rows = [];
    try {
      const res = await query(
        `SELECT ps.product_id, ps.marketplace, ps.sku, ps.marketplace_product_id, ps.mp_extra,
                p.organization_id
           FROM product_skus ps
           JOIN products p ON p.id = ps.product_id
          WHERE p.profile_id = $1
            AND ps.marketplace IN ('ozon', 'ym')
            AND COALESCE(p.is_archived, false) = false
          ORDER BY ps.product_id ASC
          LIMIT $2`,
        [pid, Math.max(1, Number(maxProducts) || 4000)]
      );
      rows = res.rows || [];
    } catch (e) {
      logger.warn('[CardQuality] refreshForProfile load failed', { message: e?.message || String(e) });
      return { ok: false, reason: e?.message || String(e) };
    }

    const byOrg = new Map();
    for (const row of rows) {
      const orgId = row.organization_id != null ? String(row.organization_id) : '';
      if (!byOrg.has(orgId)) byOrg.set(orgId, []);
      byOrg.get(orgId).push(row);
    }

    for (const [orgId, orgRows] of byOrg.entries()) {
      const apiOpts = { profileId: pid, organizationId: orgId || null };
      const ozonRows = orgRows.filter((r) => r.marketplace === 'ozon');
      const ymRows = orgRows.filter((r) => r.marketplace === 'ym');

      const skuToProducts = new Map();
      const missingInfoIds = [];
      for (const row of ozonRows) {
        const extra = parseExtra(row.mp_extra);
        const skus = collectOzonMarketSkus(null, extra);
        if (skus.length) {
          for (const sku of skus) {
            if (!skuToProducts.has(sku)) skuToProducts.set(sku, []);
            skuToProducts.get(sku).push(row);
          }
        } else if (row.marketplace_product_id) {
          missingInfoIds.push(row);
        }
      }

      if (missingInfoIds.length) {
        for (let i = 0; i < missingInfoIds.length; i += 100) {
          const chunk = missingInfoIds.slice(i, i + 100);
          const ids = chunk
            .map((r) => Number(r.marketplace_product_id))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (!ids.length) continue;
          try {
            const data = await integrationsService._ozonApiPost(
              '/v3/product/info/list',
              { product_id: ids },
              apiOpts
            );
            const items = data?.result?.items ?? data?.items ?? [];
            const byPid = new Map();
            for (const item of Array.isArray(items) ? items : []) {
              byPid.set(Number(item?.id), item);
            }
            for (const row of chunk) {
              const item = byPid.get(Number(row.marketplace_product_id));
              const skus = collectOzonMarketSkus(item);
              for (const sku of skus) {
                if (!skuToProducts.has(sku)) skuToProducts.set(sku, []);
                skuToProducts.get(sku).push(row);
              }
            }
          } catch (e) {
            logger.warn('[CardQuality] Ozon info/list for ratings failed', {
              message: e?.message || String(e),
            });
            failed += chunk.length;
          }
          await sleep(200);
        }
      }

      const allSkus = [...skuToProducts.keys()];
      const rated = await this.fetchOzonRatingBySkus(allSkus, apiOpts);
      const bySku = new Map();
      for (const p of rated) {
        const sku = Number(p?.sku);
        if (Number.isFinite(sku)) bySku.set(sku, p);
      }
      const writtenOzon = new Set();
      for (const [sku, prodRows] of skuToProducts.entries()) {
        const raw = bySku.get(Number(sku));
        const rating = normalizeOzonRatingProduct(raw, sku);
        if (!rating || rating.score == null) continue;
        for (const row of prodRows) {
          const key = Number(row.product_id);
          if (writtenOzon.has(key)) continue;
          writtenOzon.add(key);
          try {
            await storeRating(key, 'ozon', rating);
            ozonUpdated += 1;
          } catch (e) {
            failed += 1;
            logger.warn('[CardQuality] store ozon failed', {
              productId: key,
              message: e?.message || String(e),
            });
          }
        }
      }

      for (let i = 0; i < ymRows.length; i += YM_OFFER_CHUNK) {
        const chunk = ymRows.slice(i, i + YM_OFFER_CHUNK).filter((r) => String(r.sku || '').trim());
        if (!chunk.length) continue;
        try {
          const cards = await integrationsService.fetchYandexOfferCardsByOfferIds(
            chunk.map((r) => String(r.sku).trim()),
            apiOpts
          );
          const byOffer = new Map();
          for (const card of cards) {
            const oid = String(card?.offerId ?? card?.offer?.offerId ?? '').trim();
            if (oid) byOffer.set(oid, card);
          }
          for (const row of chunk) {
            const oid = String(row.sku).trim();
            const card = byOffer.get(oid);
            const rating = normalizeYmContentRating(card);
            if (!rating) continue;
            await storeRating(Number(row.product_id), 'ym', rating);
            ymUpdated += 1;
          }
        } catch (e) {
          failed += chunk.length;
          logger.warn('[CardQuality] YM offer-cards ratings failed', {
            message: e?.message || String(e),
          });
        }
        await sleep(250);
      }
    }

    const result = {
      ok: true,
      ozonUpdated,
      ymUpdated,
      failed,
      ms: Date.now() - started,
    };
    logger.info('[CardQuality] refreshForProfile done', { profileId: pid, ...result });
    return result;
  }
}

export default new MarketplaceCardQualityService();
