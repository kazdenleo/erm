/**
 * Синхронизация отзывов покупателей с Ozon, Wildberries, Яндекс.Маркет.
 *
 * Реализация по аналогии с marketplaceQuestions.service.js.
 */

import integrationsService from './integrations.service.js';
import repositoryFactory from '../config/repository-factory.js';
import marketplaceReviewsRepo from '../repositories/marketplace_reviews.repository.pg.js';
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

function mapOzonReview(r, profileId) {
  const ext = String(r.id ?? r.review_id ?? r.reviewId ?? '').trim();
  if (!ext) return null;
  const rating = safeRating(r.rating ?? r.score);
  const body = normalizeBody(r.text ?? r.body ?? r.review_text ?? '');
  const hasText = body !== '';
  // SKU в ответе /v1/review/list
  const skuOrOffer = r.sku != null && String(r.sku).trim() !== '' ? String(r.sku).trim() : (r.offer_id != null ? String(r.offer_id).trim() : null);
  const status = r.status ?? null; // PROCESSED/UNPROCESSED/...
  const sourceCreatedAt =
    parseIsoDate(r.published_at) ??
    parseIsoDate(r.publishedAt) ??
    parseIsoDate(r.created_at) ??
    parseIsoDate(r.createdAt) ??
    null;
  // В ответах списка у Ozon есть comments_amount, но это не гарантирует seller comment.
  // Доверяем локально сохранённому answer_text.
  const answerText = null;
  return {
    profile_id: profileId,
    marketplace: 'ozon',
    external_id: ext,
    rating,
    body,
    has_text: hasText,
    answer_text: answerText,
    status: status != null ? String(status) : null,
    sku_or_offer: skuOrOffer,
    source_created_at: sourceCreatedAt,
    raw_payload: r,
  };
}

async function syncOzon(profileId) {
  const cfg = await integrationsService.getMarketplaceConfig('ozon', { profileId });
  const client_id = cfg?.client_id ?? cfg?.clientId;
  const api_key = cfg?.api_key ?? cfg?.apiKey;
  if (!client_id || !api_key) {
    throw new Error('Ozon API не настроен (client_id / api_key)');
  }
  let imported = 0;
  let lastId = null;
  for (let page = 0; page < 20; page++) {
    /* eslint-disable no-await-in-loop */
    const body = {
      limit: 100,
      ...(lastId ? { last_id: String(lastId) } : {}),
      sort_dir: 'DESC',
      status: 'ALL',
    };
    const data = await integrationsService._ozonApiPost('/v1/review/list', body, { profileId });
    const r = data?.result ?? data;
    const reviews = Array.isArray(r?.reviews) ? r.reviews : (Array.isArray(r?.items) ? r.items : []);
    for (const it of reviews) {
      const row = mapOzonReview(it, profileId);
      if (!row) continue;
      await marketplaceReviewsRepo.upsertRow(row);
      imported += 1;
    }
    if (!r?.has_next) break;
    lastId = r?.last_id ?? r?.lastId ?? null;
    if (!lastId) break;
    /* eslint-enable no-await-in-loop */
  }
  return imported;
}

function wbProductDetails(raw) {
  return raw.productDetails ?? raw.product_details ?? {};
}

function mapWbFeedback(fb, profileId) {
  const ext = String(fb.id ?? fb.feedbackId ?? '').trim();
  if (!ext) return null;
  const rating = safeRating(fb.productValuation ?? fb.valuation ?? fb.rating ?? fb.stars);
  const body = normalizeBody(fb.text ?? fb.feedbackText ?? '');
  const hasText = body !== '';
  const answerText = fb.answer?.text ?? fb.answer?.message ?? fb.answerText ?? null;
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
    answer_text: answerText != null && String(answerText).trim() !== '' ? String(answerText).trim() : null,
    status: status != null ? String(status) : null,
    sku_or_offer: skuOrOffer,
    source_created_at: sourceCreatedAt,
    raw_payload: fb,
  };
}

async function syncWildberries(profileId) {
  const config = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    throw new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
  }
  let imported = 0;
  // WB API требует isAnswered=true|false (в некоторых версиях без параметра отдаёт 400)
  const answerFlags = ['false', 'true'];
  for (const isAnswered of answerFlags) {
    const qs = new URLSearchParams();
    qs.set('take', '500');
    qs.set('skip', '0');
    qs.set('isAnswered', isAnswered);
    const url = `https://feedbacks-api.wildberries.ru/api/v1/feedbacks?${qs.toString()}`;
    /* eslint-disable no-await-in-loop */
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
    const list = Array.isArray(root?.feedbacks) ? root.feedbacks : (Array.isArray(root) ? root : []);
    for (const fb of list) {
      const row = mapWbFeedback(fb, profileId);
      if (!row) continue;
      await marketplaceReviewsRepo.upsertRow(row);
      imported += 1;
    }
    /* eslint-enable no-await-in-loop */
  }
  return imported;
}

async function syncYandex(profileId) {
  // Пока не реализовано: оставим точку расширения, как в вопросах.
  // Яндекс имеет отдельные API по общению; добавим позже.
  void profileId;
  return 0;
}

/**
 * @param {number} profileId
 * @param {{ only?: 'ozon'|'wildberries'|'yandex'|null }} [opts]
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
  for (const mp of run) {
    try {
      let imported = 0;
      if (mp === 'ozon') imported = await syncOzon(profileId);
      else if (mp === 'wildberries') imported = await syncWildberries(profileId);
      else if (mp === 'yandex') imported = await syncYandex(profileId);
      results.push({ marketplace: mp, ok: true, imported, error: null });
      logger.info(`[MarketplaceReviews] ${mp} profile=${profileId} imported=${imported}`);
    } catch (e) {
      const msg = e?.message || String(e);
      logger.warn(`[MarketplaceReviews] ${mp} profile=${profileId} failed: ${msg}`);
      results.push({ marketplace: mp, ok: false, imported: 0, error: msg });
    }
  }
  return { results };
}

export async function listMarketplaceReviews(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) return [];
  return await marketplaceReviewsRepo.list(profileId, query);
}

export async function getMarketplaceReviewsStats(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return { newCount: 0, counts: { all: 0, new: 0, answered: 0 }, countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 } };
  }
  return await marketplaceReviewsRepo.getStats(profileId, query);
}

async function submitAnswerOzon(profileId, row, text) {
  const reviewId = String(row.external_id ?? '').trim();
  if (!reviewId) throw new Error('Ozon: нет external_id отзыва.');
  await integrationsService._ozonApiPost(
    '/v1/review/comment/create',
    { review_id: reviewId, text: String(text).trim(), mark_review_as_processed: true },
    { profileId }
  );
}

async function submitAnswerWildberries(profileId, row, text) {
  const config = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
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
  // WB может вернуть error=true в теле
  try {
    const json = respText ? JSON.parse(respText) : null;
    if (json && typeof json === 'object') {
      const errFlag = Boolean(json.error);
      const errText = json.errorText ? String(json.errorText).trim() : '';
      const addErr =
        json.additionalErrors != null
          ? String(Array.isArray(json.additionalErrors) ? json.additionalErrors.join('; ') : json.additionalErrors).trim()
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

  // Подтверждаем, что WB действительно сохранил ответ (иначе отзыв останется «неотвеченным» на МП).
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

/**
 * Отправить ответ на отзыв в API маркетплейса и сохранить текст в БД.
 * @param {number} profileId
 * @param {string|number} reviewRowId — id строки в marketplace_reviews
 * @param {string} text
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
  else if (mp === 'yandex') {
    const err = new Error('Ответы на отзывы Яндекс.Маркета пока не поддерживаются');
    err.statusCode = 501;
    throw err;
  } else {
    const err = new Error('Неверный marketplace');
    err.statusCode = 400;
    throw err;
  }
  // Сохраняем ответ локально (не ждём, пока список маркетплейса отразит его)
  return await marketplaceReviewsRepo.updateAnswerFields(reviewRowId, profileId, trimmed);
}

