/**
 * Синхронизация отзывов покупателей с Ozon, Wildberries, Яндекс.Маркет.
 */

import integrationsService from './integrations.service.js';
import repositoryFactory from '../config/repository-factory.js';
import marketplaceReviewsRepo from '../repositories/marketplace_reviews.repository.pg.js';
import reviewAutoReplyRulesRepo from '../repositories/review_auto_reply_rules.repository.pg.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { applyReviewTemplate } from '../utils/reviewTemplateText.js';
import logger from '../utils/logger.js';

function parseIsoDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeRating(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

function normalizeBody(v) {
  const s = v == null ? '' : String(v);
  return s.trim();
}

async function getReviewsMarketplaceConfig(type, profileId) {
  return integrationsService.getMarketplaceConfig(type, { profileId, organizationId: null });
}

const OZON_PREMIUM_PLUS_HINT =
  'Ozon: загрузка отзывов через Seller API доступна только с подпиской Premium Plus в кабинете продавца Ozon (метод /v1/review/list). Без подписки API возвращает отказ доступа.';

function isOzonPremiumPlusReviewsError(err) {
  const m = String(err?.message || err || '');
  return (
    m.includes('403') ||
    m.includes('Premium Plus') ||
    m.includes('PermissionDenied') ||
    m.includes('checkSellerPremiumPlus') ||
    m.includes('premium')
  );
}

function isOzonReviewProcessed(r) {
  const st = String(r?.status ?? '').trim().toUpperCase();
  return st === 'PROCESSED' || st === 'ANSWERED';
}

function isWbReviewAnswered(fb) {
  const answerText = fb?.answer?.text ?? fb?.answer?.message ?? fb?.answerText ?? null;
  return answerText != null && String(answerText).trim() !== '';
}

function mapOzonReview(r, profileId) {
  if (isOzonReviewProcessed(r)) return null;
  const ext = String(r.id ?? r.review_id ?? r.reviewId ?? '').trim();
  if (!ext) return null;
  const rating = safeRating(r.rating ?? r.score);
  const body = normalizeBody(r.text ?? r.body ?? r.review_text ?? '');
  const hasText = body !== '';
  const skuOrOffer =
    r.sku != null && String(r.sku).trim() !== ''
      ? String(r.sku).trim()
      : r.offer_id != null
        ? String(r.offer_id).trim()
        : null;
  const status = r.status ?? null;
  const sourceCreatedAt =
    parseIsoDate(r.published_at) ??
    parseIsoDate(r.publishedAt) ??
    parseIsoDate(r.created_at) ??
    parseIsoDate(r.createdAt) ??
    null;
  return {
    profile_id: profileId,
    marketplace: 'ozon',
    external_id: ext,
    rating,
    body,
    has_text: hasText,
    answer_text: null,
    status: status != null ? String(status) : null,
    sku_or_offer: skuOrOffer,
    source_created_at: sourceCreatedAt,
    raw_payload: null,
  };
}

async function syncOzon(profileId) {
  const ozonCfg = await getReviewsMarketplaceConfig('ozon', profileId);
  const ozonOverride =
    ozonCfg?.client_id && ozonCfg?.api_key
      ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
      : null;
  if (!ozonOverride) {
    throw new Error('Ozon API не настроен (client_id / api_key)');
  }
  let imported = 0;
  const externalIds = [];
  let lastId = null;
  try {
    for (let page = 0; page < 20; page++) {
      /* eslint-disable no-await-in-loop */
      const body = {
        limit: 100,
        ...(lastId ? { last_id: String(lastId) } : {}),
        sort_dir: 'DESC',
        status: 'UNPROCESSED',
      };
      const data = await integrationsService._ozonApiPost('/v1/review/list', body, {
        profileId,
        ozonOverride,
      });
      // Ответ Ozon: { reviews, has_next, last_id } — иногда внутри result
      const r = data?.result ?? data ?? {};
      const reviews = Array.isArray(r?.reviews)
        ? r.reviews
        : Array.isArray(r?.items)
          ? r.items
          : Array.isArray(data?.reviews)
            ? data.reviews
            : [];
      for (const it of reviews) {
        const ext = String(it.id ?? it.review_id ?? it.reviewId ?? '').trim();
        if (ext) externalIds.push(ext);
        const row = mapOzonReview(it, profileId);
        if (!row) continue;
        await marketplaceReviewsRepo.upsertRow(row);
        imported += 1;
      }
      const hasNext = Boolean(r?.has_next ?? data?.has_next);
      if (!hasNext) break;
      lastId = r?.last_id ?? r?.lastId ?? data?.last_id ?? data?.lastId ?? null;
      if (!lastId) break;
      /* eslint-enable no-await-in-loop */
    }
  } catch (e) {
    if (isOzonPremiumPlusReviewsError(e)) {
      const err = new Error(OZON_PREMIUM_PLUS_HINT);
      err.code = 'OZON_PREMIUM_PLUS_REQUIRED';
      err.statusCode = 403;
      throw err;
    }
    throw e;
  }
  return { imported, externalIds };
}

function wbProductDetails(raw) {
  return raw.productDetails ?? raw.product_details ?? {};
}

function mapWbFeedback(fb, profileId) {
  if (isWbReviewAnswered(fb)) return null;
  const ext = String(fb.id ?? fb.feedbackId ?? '').trim();
  if (!ext) return null;
  const rating = safeRating(fb.productValuation ?? fb.valuation ?? fb.rating ?? fb.stars);
  const body = normalizeBody(fb.text ?? fb.feedbackText ?? '');
  const hasText = body !== '';
  const pd = wbProductDetails(fb);
  const skuOrOffer =
    (pd.supplierArticle ?? pd.vendorCode ?? fb.vendorCode ?? fb.vendor_code ?? null) != null
      ? String(pd.supplierArticle ?? pd.vendorCode ?? fb.vendorCode ?? fb.vendor_code).trim()
      : null;
  const status = fb.state ?? fb.status ?? null;
  const sourceCreatedAt = parseIsoDate(fb.createdDate ?? fb.created_at ?? fb.createdAt);
  return {
    profile_id: profileId,
    marketplace: 'wildberries',
    external_id: ext,
    rating,
    body,
    has_text: hasText,
    answer_text: null,
    status: status != null ? String(status) : null,
    sku_or_offer: skuOrOffer,
    source_created_at: sourceCreatedAt,
    raw_payload: null,
  };
}

async function syncWildberries(profileId) {
  const config = await getReviewsMarketplaceConfig('wildberries', profileId);
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    throw new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
  }
  let imported = 0;
  const externalIds = [];
  let skip = 0;
  const take = 500;
  for (let page = 0; page < 10; page++) {
    /* eslint-disable no-await-in-loop */
    const qs = new URLSearchParams();
    qs.set('take', String(take));
    qs.set('skip', String(skip));
    qs.set('isAnswered', 'false');
    const url = `https://feedbacks-api.wildberries.ru/api/v1/feedbacks?${qs.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Wildberries API ${response.status}: ${text.substring(0, 400)}`);
    }
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const root = json?.data ?? json;
    const list = Array.isArray(root?.feedbacks) ? root.feedbacks : Array.isArray(root) ? root : [];
    for (const fb of list) {
      const ext = String(fb.id ?? fb.feedbackId ?? '').trim();
      if (ext) externalIds.push(ext);
      const row = mapWbFeedback(fb, profileId);
      if (!row) continue;
      await marketplaceReviewsRepo.upsertRow(row);
      imported += 1;
    }
    if (list.length < take) break;
    skip += take;
    /* eslint-enable no-await-in-loop */
  }
  return { imported, externalIds };
}

function yandexFeedbackBody(fb) {
  const desc = fb?.description && typeof fb.description === 'object' ? fb.description : {};
  const parts = [];
  const advantages = normalizeBody(desc.advantages);
  const disadvantages = normalizeBody(desc.disadvantages);
  const comment = normalizeBody(desc.comment ?? fb.comment ?? fb.text ?? '');
  if (advantages) parts.push(`Достоинства: ${advantages}`);
  if (disadvantages) parts.push(`Недостатки: ${disadvantages}`);
  if (comment) parts.push(comment);
  return parts.join('\n').trim();
}

function mapYandexFeedback(fb, profileId) {
  if (!fb || fb.needReaction === false) return null;
  const ext = String(fb.feedbackId ?? fb.id ?? '').trim();
  if (!ext) return null;
  const rating = safeRating(fb.statistics?.rating ?? fb.rating ?? fb.statistics?.ratingValue);
  const body = yandexFeedbackBody(fb);
  const hasText = body !== '';
  const offerId = fb.identifiers?.offerId ?? fb.offerId ?? fb.identifiers?.offer_id ?? null;
  const skuOrOffer = offerId != null && String(offerId).trim() !== '' ? String(offerId).trim() : null;
  const sourceCreatedAt = parseIsoDate(fb.createdAt ?? fb.created_at ?? fb.updatedAt);
  return {
    profile_id: profileId,
    marketplace: 'yandex',
    external_id: ext,
    rating,
    body,
    has_text: hasText,
    answer_text: null,
    status: fb.needReaction === false ? 'READ' : 'NEED_REACTION',
    sku_or_offer: skuOrOffer,
    source_created_at: sourceCreatedAt,
    raw_payload: null,
  };
}

async function syncYandex(profileId) {
  const config = await getReviewsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error(
      'Яндекс.Маркет: не настроен Api-Key (нужен доступ «Общение с покупателями» / communication).'
    );
    err.statusCode = 400;
    throw err;
  }
  const { businessId } = await getYandexBusinessAndCampaigns(config);
  if (businessId == null || Number.isNaN(Number(businessId)) || Number(businessId) < 1) {
    const err = new Error(
      'Яндекс.Маркет: не удалось определить businessId. Укажите Business ID в интеграции или проверьте api_key.'
    );
    err.statusCode = 400;
    throw err;
  }
  const agent = getYandexHttpsAgent();
  let imported = 0;
  const externalIds = [];
  let pageToken = '';
  for (let i = 0; i < 80; i++) {
    /* eslint-disable no-await-in-loop */
    const qs = new URLSearchParams();
    qs.set('limit', '50');
    if (pageToken) qs.set('pageToken', pageToken);
    const url = `https://api.partner.market.yandex.ru/v2/businesses/${businessId}/goods-feedback?${qs.toString()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reactionStatus: 'NEED_REACTION' }),
      ...(agent && { agent }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Яндекс.Маркет API ${response.status}: ${text.substring(0, 400)}`);
    }
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error('Яндекс.Маркет: неверный JSON в ответе');
    }
    const result = json?.result ?? json;
    const feedbacks = Array.isArray(result?.feedbacks) ? result.feedbacks : [];
    for (const fb of feedbacks) {
      const row = mapYandexFeedback(fb, profileId);
      if (!row) continue;
      externalIds.push(row.external_id);
      await marketplaceReviewsRepo.upsertRow(row);
      imported += 1;
    }
    pageToken = result?.paging?.nextPageToken ?? '';
    if (!pageToken || feedbacks.length === 0) break;
    /* eslint-enable no-await-in-loop */
  }
  return { imported, externalIds };
}

/** Убираем из БД отзывы, на которые уже ответили или которых нет в списке неотвеченных на МП. */
async function purgeAnsweredMissingFromMarketplace(profileId, marketplace, externalIds) {
  const missing = await marketplaceReviewsRepo.findNeedingReplyMissingFromMarketplace(
    profileId,
    marketplace,
    externalIds,
    { allIfEmpty: true }
  );
  let deleted = 0;
  for (const row of missing) {
    await marketplaceReviewsRepo.deleteByIdAndProfile(row.id, profileId);
    deleted += 1;
  }
  return { deleted };
}

function parseAnsweredFilter(query) {
  const raw = query.answered ?? query.status ?? null;
  if (raw == null || String(raw).trim() === '') return 'new';
  const a = String(raw).trim().toLowerCase();
  if (a === 'new' || a === 'unanswered' || a === 'pending') return 'new';
  if (a === 'answered' || a === 'done') return 'answered';
  if (a === 'all') return 'all';
  return 'new';
}

/**
 * @param {number} profileId
 * @param {{ only?: 'ozon'|'wildberries'|'yandex'|null, skipAutoReply?: boolean }} [opts]
 */
export async function syncMarketplaceReviews(profileId, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Синхронизация отзывов доступна только при PostgreSQL');
    err.statusCode = 501;
    throw err;
  }
  const only = opts.only != null && opts.only !== '' ? String(opts.only).trim().toLowerCase() : null;
  const order = ['ozon', 'wildberries', 'yandex'];
  const run = [];
  if (only) {
    if (!order.includes(only)) {
      const err = new Error('Неверный marketplace');
      err.statusCode = 400;
      throw err;
    }
    run.push(only);
  } else {
    run.push(...order);
  }
  const results = [];
  const cleanupStart = await marketplaceReviewsRepo.deleteNotNeedingReplyByProfile(profileId);
  if ((cleanupStart.deleted ?? 0) > 0) {
    logger.info(`[MarketplaceReviews] profile=${profileId} purged answered on sync start: ${cleanupStart.deleted}`);
  }
  for (const mp of run) {
    try {
      let imported = 0;
      let externalIds = [];
      if (mp === 'ozon') ({ imported, externalIds } = await syncOzon(profileId));
      else if (mp === 'wildberries') ({ imported, externalIds } = await syncWildberries(profileId));
      else if (mp === 'yandex') ({ imported, externalIds } = await syncYandex(profileId));
      const purgeStats = await purgeAnsweredMissingFromMarketplace(profileId, mp, externalIds);
      const cleanup = await marketplaceReviewsRepo.deleteNotNeedingReplyByProfile(profileId);
      results.push({
        marketplace: mp,
        ok: true,
        imported,
        purged: (purgeStats.deleted ?? 0) + (cleanup.deleted ?? 0),
        error: null,
      });
      logger.info(
        `[MarketplaceReviews] ${mp} profile=${profileId} imported=${imported} purged=${purgeStats.deleted ?? 0} cleanup=${cleanup.deleted ?? 0}`
      );
    } catch (e) {
      const msg = e?.message || String(e);
      logger.warn(`[MarketplaceReviews] ${mp} profile=${profileId} failed: ${msg}`);
      results.push({ marketplace: mp, ok: false, imported: 0, error: msg });
    }
  }

  let autoReply = null;
  if (!opts.skipAutoReply) {
    try {
      autoReply = await processReviewAutoReplies(profileId, { limit: 80 });
    } catch (e) {
      logger.warn(`[MarketplaceReviews] auto-reply profile=${profileId} failed: ${e?.message || e}`);
      autoReply = { answered: 0, errors: [e?.message || String(e)] };
    }
  }

  return { results, autoReply };
}

export async function listMarketplaceReviews(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) return [];
  return await marketplaceReviewsRepo.list(profileId, {
    ...query,
    answered: parseAnsweredFilter(query),
  });
}

export async function getMarketplaceReviewsStats(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return {
      newCount: 0,
      counts: { all: 0, new: 0, answered: 0 },
      countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
    };
  }
  return await marketplaceReviewsRepo.getStats(profileId, query);
}

async function submitAnswerOzon(profileId, row, text) {
  const reviewId = String(row.external_id ?? '').trim();
  if (!reviewId) throw new Error('Ozon: нет external_id отзыва.');
  const ozonCfg = await getReviewsMarketplaceConfig('ozon', profileId);
  const ozonOverride =
    ozonCfg?.client_id && ozonCfg?.api_key
      ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
      : null;
  try {
    await integrationsService._ozonApiPost(
      '/v1/review/comment/create',
      { review_id: reviewId, text: String(text).trim(), mark_review_as_processed: true },
      { profileId, ozonOverride }
    );
  } catch (e) {
    if (isOzonPremiumPlusReviewsError(e)) {
      const err = new Error(OZON_PREMIUM_PLUS_HINT);
      err.code = 'OZON_PREMIUM_PLUS_REQUIRED';
      err.statusCode = 403;
      throw err;
    }
    throw e;
  }
}

async function submitAnswerWildberries(profileId, row, text) {
  const config = await getReviewsMarketplaceConfig('wildberries', profileId);
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    throw new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
  }
  const ext = String(row.external_id ?? '').trim();
  if (!ext) throw new Error('Wildberries: нет external_id отзыва.');
  const url = 'https://feedbacks-api.wildberries.ru/api/v1/feedbacks/answer';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: ext, text: String(text).trim() }),
  });
  const respText = await response.text();
  if (!response.ok) {
    throw new Error(`Wildberries API ${response.status}: ${respText.substring(0, 400)}`);
  }
  try {
    const json = respText ? JSON.parse(respText) : null;
    if (json && typeof json === 'object') {
      const errFlag = Boolean(json.error);
      const errText = json.errorText ? String(json.errorText).trim() : '';
      const addErr =
        json.additionalErrors != null
          ? String(
              Array.isArray(json.additionalErrors) ? json.additionalErrors.join('; ') : json.additionalErrors
            ).trim()
          : '';
      if (errFlag || errText) {
        throw new Error(`Wildberries API: ответ не принят${errText ? ` — ${errText.substring(0, 300)}` : ''}`);
      }
      if (addErr) {
        throw new Error(`Wildberries API: ответ не принят — ${addErr.substring(0, 300)}`);
      }
    }
  } catch (e) {
    if (e?.message && String(e.message).startsWith('Wildberries API: ответ не принят')) throw e;
  }

  const verifyUrl = `https://feedbacks-api.wildberries.ru/api/v1/feedback?id=${encodeURIComponent(ext)}`;
  let verified = false;
  let lastVerifyErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    /* eslint-disable no-await-in-loop */
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    /* eslint-enable no-await-in-loop */
    try {
      const vr = await fetch(verifyUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      const vt = await vr.text();
      if (!vr.ok) {
        lastVerifyErr = `verify HTTP ${vr.status}: ${vt.substring(0, 200)}`;
        continue;
      }
      const json = vt ? JSON.parse(vt) : null;
      const root = json?.data ?? json;
      const ans = root?.answer?.text ?? root?.answer?.message ?? null;
      const ansStr = ans != null ? String(ans).trim() : '';
      if (ansStr && ansStr === String(text).trim()) {
        verified = true;
        break;
      }
      lastVerifyErr = ansStr ? `verify mismatch: "${ansStr.substring(0, 80)}"` : 'verify: answer missing';
    } catch (e) {
      lastVerifyErr = e?.message || String(e);
    }
  }
  if (!verified) {
    const err = new Error(
      `Wildberries: ответ отправлен, но не подтверждён маркетплейсом. Попробуйте позже. (${lastVerifyErr || 'no details'})`
    );
    err.statusCode = 502;
    throw err;
  }
}

async function submitAnswerYandex(profileId, row, text) {
  const config = await getReviewsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error(
      'Яндекс.Маркет: не настроен Api-Key (нужен доступ «Общение с покупателями» / communication).'
    );
    err.statusCode = 400;
    throw err;
  }
  const { businessId } = await getYandexBusinessAndCampaigns(config);
  if (businessId == null || Number.isNaN(Number(businessId)) || Number(businessId) < 1) {
    const err = new Error(
      'Яндекс.Маркет: не удалось определить businessId. Укажите Business ID в интеграции.'
    );
    err.statusCode = 400;
    throw err;
  }
  const feedbackId = Number(String(row.external_id ?? '').trim());
  if (!Number.isFinite(feedbackId) || feedbackId < 1) {
    throw new Error('Яндекс.Маркет: нет корректного feedbackId отзыва.');
  }
  const agent = getYandexHttpsAgent();
  const url = `https://api.partner.market.yandex.ru/v2/businesses/${businessId}/goods-feedback/comments/update`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      feedbackId,
      comment: { text: String(text).trim() },
    }),
    ...(agent && { agent }),
  });
  const respText = await response.text();
  if (!response.ok) {
    throw new Error(`Яндекс.Маркет API ${response.status}: ${respText.substring(0, 400)}`);
  }
}

/**
 * Отправить ответ на отзыв в API маркетплейса и удалить строку из БД.
 */
export async function submitMarketplaceReviewAnswer(profileId, reviewRowId, text) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Ответы на отзывы доступны только при PostgreSQL');
    err.statusCode = 501;
    throw err;
  }
  const trimmed = String(text ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 5000) {
    const err = new Error('Текст ответа: от 1 до 5000 символов');
    err.statusCode = 400;
    throw err;
  }
  const row = await marketplaceReviewsRepo.findRowByIdAndProfile(reviewRowId, profileId);
  if (!row) {
    const err = new Error('Отзыв не найден');
    err.statusCode = 404;
    throw err;
  }
  const mp = String(row.marketplace || '').trim().toLowerCase();
  if (mp === 'ozon') await submitAnswerOzon(profileId, row, trimmed);
  else if (mp === 'wildberries') await submitAnswerWildberries(profileId, row, trimmed);
  else if (mp === 'yandex') await submitAnswerYandex(profileId, row, trimmed);
  else {
    const err = new Error('Неверный marketplace');
    err.statusCode = 400;
    throw err;
  }
  await marketplaceReviewsRepo.deleteByIdAndProfile(reviewRowId, profileId);
  return {
    id: String(reviewRowId),
    deleted: true,
    marketplace: mp,
  };
}

/**
 * Автоответ по включённым правилам (рейтинг × наличие текста → шаблон).
 * Запускается после синхронизации отзывов (по умолчанию раз в час) и вручную.
 */
export async function processReviewAutoReplies(profileId, { limit = 50 } = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return { answered: 0, skipped: 0, errors: [] };
  }
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) {
    return { answered: 0, skipped: 0, errors: ['Некорректный profileId'] };
  }
  const rules = await reviewAutoReplyRulesRepo.listEnabledWithTemplates(pid);
  if (!rules.length) {
    return { answered: 0, skipped: 0, errors: [], rules: 0 };
  }

  const fetchLimit = Math.min(500, Math.max(limit * 3, 80));
  const items = await marketplaceReviewsRepo.listMatchingAutoReplyRules(pid, rules, {
    limit: fetchLimit,
  });

  let answered = 0;
  let skipped = 0;
  const errors = [];

  /** Нормализованный рейтинг правила: 1–5 или null («любой» — не используем для автоответа). */
  const ruleRatingOf = (rule) => {
    if (rule?.rating == null || rule.rating === '') return null;
    const n = Number(rule.rating);
    if (!Number.isFinite(n)) return null;
    const r = Math.round(n);
    return r >= 1 && r <= 5 ? r : null;
  };

  /** true/false или null («любой текст»). */
  const ruleHasTextOf = (rule) => {
    if (rule?.hasText === true || rule?.hasText === false) return Boolean(rule.hasText);
    return null;
  };

  const ruleSpecificity = (rule) => {
    let score = 0;
    if (ruleRatingOf(rule) != null) score += 2;
    if (ruleHasTextOf(rule) != null) score += 1;
    return score;
  };

  const ruleMatches = (rule, rating, hasText) => {
    const wantRating = ruleRatingOf(rule);
    const wantText = ruleHasTextOf(rule);
    // Без звёзд правило слишком широкое — не применяем (иначе один шаблон уходит на все отзывы).
    if (wantRating == null) return false;
    if (wantRating !== Number(rating)) return false;
    if (wantText != null && wantText !== Boolean(hasText)) return false;
    return true;
  };

  /** Среди подходящих берём самое узкое (сначала звёзды, затем наличие текста). */
  const matchRule = (rating, hasText) => {
    let best = null;
    let bestScore = -1;
    for (const rule of rules) {
      if (!ruleMatches(rule, rating, hasText)) continue;
      const score = ruleSpecificity(rule);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      }
    }
    return best;
  };

  for (const item of items) {
    if (answered >= limit) break;
    const rating = safeRating(item.rating);
    if (rating == null) {
      skipped += 1;
      continue;
    }
    const hasText = Boolean(item.hasText ?? item.has_text);
    const rule = matchRule(rating, hasText);
    if (!rule?.templateBody) {
      skipped += 1;
      continue;
    }
    const text = applyReviewTemplate(rule.templateBody, {
      skuOrOffer: item.skuOrOffer ?? item.sku_or_offer,
    });
    if (!text) {
      skipped += 1;
      continue;
    }
    try {
      logger.info('[MarketplaceReviews] auto-reply', {
        reviewId: item.id,
        rating,
        hasText,
        ruleId: rule.id,
        ruleTitle: rule.title,
      });
      // eslint-disable-next-line no-await-in-loop
      await submitMarketplaceReviewAnswer(pid, item.id, text);
      answered += 1;
      // WB/Ozon лимитируют ответы — пауза между отправками
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1200));
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`#${item.id}: ${msg}`);
      logger.warn(`[MarketplaceReviews] auto-reply failed id=${item.id}: ${msg}`);
      if (/429|too many requests|rate limit/i.test(msg)) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return { answered, skipped, errors, rules: rules.length, candidates: items.length };
}
