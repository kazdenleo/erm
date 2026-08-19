/**
 * Синхронизация вопросов покупателей с Ozon, Wildberries, Яндекс.Маркет.
 */

import integrationsService from './integrations.service.js';
import repositoryFactory from '../config/repository-factory.js';
import marketplaceQuestionsRepo from '../repositories/marketplace_questions.repository.pg.js';
import { query } from '../config/database.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { extractYandexGoodsQuestionOfferId } from '../utils/yandex-goods-question-offer.js';
import {
  buildThreadMessagesFromRow,
  getYandexLastSellerAnswerId,
  inferYandexAnswerAuthor,
  sortYandexAnswers,
} from '../utils/marketplaceQuestionThread.js';
import logger from '../utils/logger.js';

/**
 * Вопросы хранятся по profile_id. Кабинет выбранной организации может быть другим продавцом
 * на том же маркетплейсе — для синка и ответов всегда берём интеграцию профиля.
 */
async function getQuestionsMarketplaceConfig(type, profileId) {
  return integrationsService.getMarketplaceConfig(type, { profileId, organizationId: null });
}

async function enrichYandexQuestionWithAnswers(profileId, rawQuestion, questionId) {
  const config = await getQuestionsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) return rawQuestion;
  const { businessId } = await getYandexBusinessAndCampaigns(config);
  if (businessId == null || Number.isNaN(Number(businessId)) || Number(businessId) < 1) return rawQuestion;

  const agent = getYandexHttpsAgent();

  const all = [];
  let pageToken = '';
  for (let i = 0; i < 80; i++) {
    const qs = new URLSearchParams();
    qs.set('limit', '50');
    if (pageToken) qs.set('pageToken', pageToken);
    const url = `https://api.partner.market.yandex.ru/v1/businesses/${businessId}/goods-questions/answers?${qs.toString()}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ questionId: Number(questionId) }),
      ...(agent && { agent }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Яндекс.Маркет API ${resp.status}: ${text.substring(0, 400)}`);
      err.statusCode = resp.status === 401 ? 403 : resp.status;
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      break;
    }
    const result = json.result ?? json;
    const answers = result.answers ?? [];
    if (Array.isArray(answers) && answers.length > 0) {
      all.push(...answers);
    } else {
      break;
    }
    pageToken = result.paging?.nextPageToken ?? '';
    if (!pageToken) break;
  }

  // Совмещаем: в raw_payload.question — вопрос; raw_payload.answers — ответы (с комментариями).
  return {
    ...(rawQuestion && typeof rawQuestion === 'object' ? rawQuestion : {}),
    answers: all,
  };
}

/** Ozon API: допустимые status — NEW, ALL, VIEWED, PROCESSED, UNPROCESSED (UNANSWERED снят). */
const OZON_SYNC_STATUSES = ['UNPROCESSED', 'VIEWED', 'NEW'];

function isOzonQuestionProcessedStatus(status) {
  const st = String(status ?? '').trim().toUpperCase();
  // VIEWED = просмотрен, но без ответа — не считаем закрытым.
  return st === 'PROCESSED' || st === 'ANSWERED';
}

/** Закрыть ветку локально: на МП вопроса уже нет в списке без ответа. */
function finalizeQuestionRowAsAnsweredOnMarketplace(row) {
  if (!row) return row;
  let tm =
    Array.isArray(row.thread_messages) && row.thread_messages.length > 0
      ? row.thread_messages.map((m) => ({ ...m }))
      : buildThreadMessagesFromRow({
          marketplace: row.marketplace,
          rawPayload: row.raw_payload,
          body: row.body,
          answerText: row.answer_text,
          sourceCreatedAt: row.source_created_at,
        });
  const lastRole = String(tm[tm.length - 1]?.role || '').toLowerCase();
  if (lastRole !== 'buyer') {
    return { ...row, thread_messages: tm };
  }
  const existingAnswer =
    row.answer_text != null && String(row.answer_text).trim() !== ''
      ? String(row.answer_text).trim()
      : null;
  tm.push({
    role: 'seller',
    text: existingAnswer || '—',
    at: row.updated_at ?? row.synced_at ?? null,
    externalId: null,
  });
  return {
    ...row,
    answer_text: existingAnswer ?? row.answer_text,
    thread_messages: tm,
    status: isOzonQuestionProcessedStatus(row.status) ? row.status : 'answered',
  };
}

function extractOzonQuestions(data) {
  const r = data?.result ?? data;
  if (!r) return [];
  if (Array.isArray(r.questions)) return r.questions;
  if (Array.isArray(r.items)) return r.items;
  if (Array.isArray(r.list)) return r.list;
  return [];
}

function parseIsoDate(v) {
  if (v == null || v === '') return null;
  // Ozon/YM/WB могут отдавать дату как ISO или как unix timestamp (секунды/миллисекунды)
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  const asDate =
    Number.isFinite(n) && n > 0
      ? new Date(n < 1_000_000_000_000 ? n * 1000 : n) // seconds -> ms
      : new Date(v);
  const d = asDate;
  return Number.isNaN(d.getTime()) ? null : d;
}

function isOzonNumericMarketSku(value) {
  return /^\d{6,}$/.test(String(value ?? '').trim());
}

async function lookupOzonProductByMarketSku(ozonSku) {
  const skuStr = String(ozonSku ?? '').trim();
  if (!skuStr || !isOzonNumericMarketSku(skuStr)) return null;
  const skuNum = Number(skuStr);
  try {
    const result = await query(
      `SELECT p.name,
              TRIM(COALESCE(ps.sku, p.sku, '')) AS offer_id,
              TRIM(COALESCE(p.sku, '')) AS erp_sku
       FROM product_skus ps
       JOIN products p ON p.id = ps.product_id
       WHERE ps.marketplace = 'ozon'
         AND (
           ($1::bigint IS NOT NULL AND ps.marketplace_product_id = $1::bigint)
           OR TRIM(COALESCE(ps.mp_extra->>'ozonSku', '')) = $2
           OR TRIM(COALESCE(ps.mp_extra->>'ozon_sku', '')) = $2
           OR TRIM(COALESCE(ps.mp_extra->>'marketSku', '')) = $2
         )
       ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
       LIMIT 1`,
      [Number.isFinite(skuNum) ? skuNum : null, skuStr]
    );
    const row = result.rows[0];
    if (!row) return null;
    const offer = row.offer_id != null ? String(row.offer_id).trim() : '';
    const erp = row.erp_sku != null ? String(row.erp_sku).trim() : '';
    const sellerSku = offer && !isOzonNumericMarketSku(offer) ? offer : erp && !isOzonNumericMarketSku(erp) ? erp : null;
    const name = row.name != null ? String(row.name).trim() : '';
    if (!sellerSku && !name) return null;
    return { offerId: sellerSku, name: name || null };
  } catch (e) {
    logger.warn('[MarketplaceQuestions] Ozon catalog lookup failed', { ozonSku: skuStr, error: e?.message });
    return null;
  }
}

async function fetchOzonProductMetaBySku(profileId, ozonSku) {
  const fromDb = await lookupOzonProductByMarketSku(ozonSku);
  if (fromDb?.offerId) return fromDb;

  const skuStr = String(ozonSku ?? '').trim();
  if (!skuStr || !isOzonNumericMarketSku(skuStr)) return null;
  const skuNum = Number(skuStr);
  if (!Number.isFinite(skuNum)) return null;

  try {
    const ozonCfg = await getQuestionsMarketplaceConfig('ozon', profileId);
    const ozonOverride =
      ozonCfg?.client_id && ozonCfg?.api_key
        ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
        : null;
    if (!ozonOverride) return null;
    const data = await integrationsService._ozonApiPost(
      '/v3/product/info/list',
      { sku: [skuNum] },
      { profileId, ozonOverride }
    );
    const item = data?.result?.items?.[0] ?? data?.items?.[0];
    if (!item || typeof item !== 'object') return null;
    const offerRaw = item.offer_id ?? item.offerId ?? null;
    const offerId = offerRaw != null ? String(offerRaw).trim() : null;
    const nameRaw = item.name ?? item.title ?? item.product_name ?? null;
    const name = nameRaw != null ? String(nameRaw).trim() : null;
    if (!offerId && !name) return null;
    return {
      offerId: offerId && !isOzonNumericMarketSku(offerId) ? offerId : null,
      name: name || null,
    };
  } catch (e) {
    logger.warn('[MarketplaceQuestions] Ozon product/info/list by sku failed', {
      ozonSku: skuStr,
      error: e?.message || String(e),
    });
    return null;
  }
}

async function enrichOzonQuestionFromCatalog(row, profileId = null) {
  if (!row || row.marketplace !== 'ozon') return row;
  const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  const ozonSku = raw.sku ?? raw.product_sku;
  if (ozonSku == null || String(ozonSku).trim() === '') return row;
  if (row.sku_or_offer && !isOzonNumericMarketSku(row.sku_or_offer) && row.subject) return row;

  const pid = profileId ?? row.profile_id ?? null;
  const info = pid != null ? await fetchOzonProductMetaBySku(pid, ozonSku) : await lookupOzonProductByMarketSku(ozonSku);
  if (!info?.offerId && !info?.name) return row;

  if (info.offerId) row.sku_or_offer = info.offerId;
  if (info.name && info.offerId) {
    row.subject = `${info.offerId} — ${info.name}`;
  } else if (info.name) {
    row.subject = info.name;
  } else if (info.offerId) {
    row.subject = info.offerId;
  }
  return row;
}

async function finalizeOzonQuestionRow(q, profileId) {
  const row = mapOzonQuestion(q, profileId);
  if (!row) return null;
  return enrichOzonQuestionFromCatalog(row, profileId);
}

function mapOzonQuestion(q, profileId) {
  const ext = String(q.id ?? q.question_id ?? q.questionId ?? '').trim();
  if (!ext) return null;
  let answerText = null;
  if (Array.isArray(q.answers) && q.answers.length > 0) {
    for (let i = q.answers.length - 1; i >= 0; i--) {
      const a = q.answers[i];
      const authorType = String(a?.author?.type ?? a?.author_type ?? '').toUpperCase();
      const sellerish =
        !authorType ||
        authorType.includes('SELLER') ||
        authorType.includes('SHOP') ||
        authorType.includes('PARTNER') ||
        authorType.includes('BUSINESS');
      if (!sellerish) continue;
      const t = a.text ?? a.message ?? a.answer_text ?? null;
      if (t != null && String(t).trim() !== '') {
        answerText = String(t).trim();
        break;
      }
    }
    if (answerText == null) {
      const a = q.answers[q.answers.length - 1];
      answerText = a.text ?? a.message ?? a.answer_text ?? null;
    }
  }
  if (answerText == null && q.answer) {
    answerText = q.answer.text ?? q.answer.message ?? null;
  }
  const body = String(q.text ?? q.question_text ?? '').trim() || '—';
  const offerId =
    q.offer_id != null && String(q.offer_id).trim() !== '' ? String(q.offer_id).trim() : null;
  const ozonMarketSku = q.sku != null && String(q.sku).trim() !== '' ? String(q.sku).trim() : null;
  const baseName = q.product_name ?? q.product_title ?? q.name ?? null;
  let subject = baseName != null && String(baseName).trim() !== '' ? String(baseName).trim() : null;
  if (subject && offerId) {
    subject = `${offerId} — ${subject}`;
  } else if (!subject && offerId) {
    subject = offerId;
  } else if (!subject && ozonMarketSku && !isOzonNumericMarketSku(ozonMarketSku)) {
    subject = ozonMarketSku;
  }
  const sku = offerId;
  const status = q.status ?? q.question_status ?? null;
  const sourceCreatedAt =
    parseIsoDate(q.published_at) ??
    parseIsoDate(q.publishedAt) ??
    parseIsoDate(q.created_at) ??
    parseIsoDate(q.createdAt) ??
    parseIsoDate(q.date) ??
    null;
  const row = {
    profile_id: profileId,
    marketplace: 'ozon',
    external_id: ext,
    subject,
    body,
    answer_text: answerText,
    status: status != null ? String(status) : null,
    sku_or_offer: sku,
    source_created_at: sourceCreatedAt,
    raw_payload: q,
  };
  row.thread_messages = buildThreadMessagesFromRow({
    marketplace: 'ozon',
    rawPayload: q,
    body: row.body,
    answerText: row.answer_text,
    sourceCreatedAt: row.source_created_at,
  });
  if (
    isOzonQuestionProcessedStatus(status) ||
    (answerText != null && String(answerText).trim() !== '')
  ) {
    return finalizeQuestionRowAsAnsweredOnMarketplace(row);
  }
  return row;
}

function wbProductDetails(q) {
  return q.productDetails ?? q.product_details ?? {};
}

function wbSupplierArticleFromPd(pd, q) {
  const candidates = [
    pd.supplierArticle,
    pd.supplier_article,
    pd.vendorCode,
    pd.vendor_code,
    pd.article,
    q.vendorCode,
    q.vendor_code,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Если в ответе «Вопросов» нет supplierArticle, подставляем vendorCode из Content API (см. syncWildberries).
 */
function applyWbVendorCodeToRow(row, vendorByNm) {
  if (!vendorByNm?.size) return;
  const q = row.raw_payload;
  const pd = wbProductDetails(q);
  const nmRaw = pd.nmId ?? pd.nmID ?? null;
  if (nmRaw == null) return;
  const nmStr = String(nmRaw).trim();
  const vc = vendorByNm.get(nmStr);
  if (!vc) return;
  const sku = row.sku_or_offer != null ? String(row.sku_or_offer).trim() : '';
  if (sku !== '' && sku !== nmStr) return;
  row.sku_or_offer = vc;
  const baseName = pd.productName ?? pd.product_name ?? null;
  let subject = baseName != null && String(baseName).trim() !== '' ? String(baseName).trim() : null;
  if (subject && vc) {
    row.subject = `${subject} · ${vc}`;
  } else if (!subject && vc) {
    row.subject = vc;
  }
}

async function wbFetchVendorCodesForQuestions(questions, profileId) {
  const needNm = [];
  for (const q of questions) {
    const pd = wbProductDetails(q);
    if (wbSupplierArticleFromPd(pd, q)) continue;
    const nm = pd.nmId ?? pd.nmID;
    if (nm == null) continue;
    needNm.push(nm);
  }
  if (needNm.length === 0) return new Map();
  try {
    return await integrationsService.getWildberriesVendorCodeMapByNmIds(needNm, profileId);
  } catch (e) {
    logger.warn('[MarketplaceQuestions] WB vendorCode lookup failed:', e?.message || e);
    return new Map();
  }
}

function mapWbQuestion(q, profileId) {
  const ext = String(q.id ?? '').trim();
  if (!ext) return null;
  const body = String(q.text ?? '').trim() || '—';
  const answerText = q.answer?.text ?? q.answer?.message ?? null;
  const pd = wbProductDetails(q);
  const nmRaw = pd.nmId ?? pd.nmID ?? null;
  const nm = nmRaw != null ? String(nmRaw).trim() : null;
  const supplierArt = wbSupplierArticleFromPd(pd, q);
  const articleForLabel = supplierArt || nm;
  const baseName = pd.productName ?? pd.product_name ?? null;
  let subject =
    baseName != null && String(baseName).trim() !== '' ? String(baseName).trim() : null;
  if (subject && articleForLabel) {
    subject = `${subject} · ${articleForLabel}`;
  } else if (!subject && articleForLabel) {
    subject = String(articleForLabel);
  } else if (!subject && nm) {
    subject = `nmId ${nm}`;
  }
  /** До артикула из Content API может быть только nmId — колонку потом поправит applyWbVendorCodeToRow */
  const sku = supplierArt ?? (nmRaw != null ? String(nmRaw).trim() : null);
  const status = q.state ?? q.status ?? null;
  const sourceCreatedAt = parseIsoDate(q.createdDate ?? q.created_at);
  const row = {
    profile_id: profileId,
    marketplace: 'wildberries',
    external_id: ext,
    subject,
    body,
    answer_text: answerText,
    status: status != null ? String(status) : null,
    sku_or_offer: sku,
    source_created_at: sourceCreatedAt,
    raw_payload: q,
  };
  row.thread_messages = buildThreadMessagesFromRow({
    marketplace: 'wildberries',
    rawPayload: q,
    body: row.body,
    answerText: row.answer_text,
    sourceCreatedAt: row.source_created_at,
  });
  return row;
}

function getYandexQuestionExternalId(q) {
  const qi = q.questionIdentifiers ?? q.question_identifiers ?? {};
  const extRaw = qi.id ?? q.id ?? q.questionId ?? q.question_id;
  if (extRaw == null || extRaw === '') return null;
  const ext = String(extRaw).trim();
  return ext || null;
}

function mapYandexQuestion(q, profileId) {
  const ext = getYandexQuestionExternalId(q);
  if (!ext) return null;
  const body = String(q.text ?? '').trim() || '—';
  let answerText = null;
  const sortedAns = sortYandexAnswers(q.answers);
  for (let i = sortedAns.length - 1; i >= 0; i--) {
    if (inferYandexAnswerAuthor(sortedAns[i]) === 'seller') {
      answerText = sortedAns[i].text ?? sortedAns[i].body ?? null;
      if (answerText != null) answerText = String(answerText).trim() || null;
      break;
    }
  }
  const offerIdStr = extractYandexGoodsQuestionOfferId(q);
  const baseName =
    q.modelName != null && String(q.modelName).trim() !== ''
      ? String(q.modelName).trim()
      : q.shopSku != null && String(q.shopSku).trim() !== ''
        ? String(q.shopSku).trim()
        : q.product?.name != null && String(q.product.name).trim() !== ''
          ? String(q.product.name).trim()
          : null;
  let subject = baseName;
  if (subject && offerIdStr) {
    subject = `${subject} · ${offerIdStr}`;
  } else if (!subject && offerIdStr) {
    subject = String(offerIdStr);
  } else if (!subject) {
    subject = null;
  }
  const sourceCreatedAt = parseIsoDate(q.createdAt ?? q.created_at);
  const status = q.status ?? (answerText ? 'ANSWERED' : 'UNANSWERED');
  const row = {
    profile_id: profileId,
    marketplace: 'yandex',
    external_id: ext,
    subject: subject != null ? String(subject) : null,
    body,
    answer_text: answerText,
    status: status != null ? String(status) : null,
    sku_or_offer: offerIdStr,
    source_created_at: sourceCreatedAt,
    raw_payload: q,
  };
  row.thread_messages = buildThreadMessagesFromRow({
    marketplace: 'yandex',
    rawPayload: q,
    body: row.body,
    answerText: row.answer_text,
    sourceCreatedAt: row.source_created_at,
  });
  return row;
}

const OZON_PREMIUM_PLUS_HINT =
  'Ozon: загрузка вопросов через Seller API доступна только с подпиской Premium Plus в кабинете продавца Ozon (метод /v1/question/list). Без подписки API возвращает отказ доступа.';

function isOzonPremiumPlusQuestionsError(err) {
  const m = String(err?.message || err || '');
  return (
    m.includes('403') ||
    m.includes('Premium Plus') ||
    m.includes('PermissionDenied') ||
    m.includes('checkSellerPremiumPlus')
  );
}

function rowNeedsSellerReply(row) {
  if (!row) return false;
  const tm = row.thread_messages;
  if (Array.isArray(tm) && tm.length > 0) {
    return String(tm[tm.length - 1]?.role || '').toLowerCase() === 'buyer';
  }
  const t = row.answer_text;
  return t == null || String(t).trim() === '';
}

async function syncOzon(profileId, _organizationId = null) {
  let imported = 0;
  const externalIds = [];
  const seenIds = new Set();
  const ozonCfg = await getQuestionsMarketplaceConfig('ozon', profileId);
  const ozonOverride =
    ozonCfg?.client_id && ozonCfg?.api_key
      ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
      : null;
  const limit = 100;
  try {
    for (const status of OZON_SYNC_STATUSES) {
      let offset = 0;
      for (let page = 0; page < 40; page++) {
        let data;
        try {
          data = await integrationsService._ozonApiPost(
            '/v1/question/list',
            { filter: { status }, limit, offset },
            { profileId, ozonOverride }
          );
        } catch (e) {
          if (page === 0) {
            logger.warn('[MarketplaceQuestions] Ozon sync status skipped', {
              profileId,
              status,
              error: e?.message || String(e),
            });
            break;
          }
          throw e;
        }
        const items = extractOzonQuestions(data);
        if (!items.length) break;
        for (const q of items) {
          const ext = String(q.id ?? q.question_id ?? q.questionId ?? '').trim();
          if (!ext || seenIds.has(ext)) continue;
          const row = await finalizeOzonQuestionRow(q, profileId);
          if (!row || !rowNeedsSellerReply(row)) continue;
          seenIds.add(ext);
          externalIds.push(row.external_id);
          await marketplaceQuestionsRepo.upsertRow(row);
          imported += 1;
        }
        if (items.length < limit) break;
        offset += limit;
      }
    }
  } catch (e) {
    if (isOzonPremiumPlusQuestionsError(e)) {
      const err = new Error(OZON_PREMIUM_PLUS_HINT);
      err.code = 'OZON_PREMIUM_PLUS_REQUIRED';
      throw err;
    }
    throw e;
  }
  await reEnrichOzonQuestionsMissingProduct(profileId);
  return { imported, externalIds };
}

async function reEnrichOzonQuestionsMissingProduct(profileId) {
  const pid = Number(profileId);
  if (!Number.isFinite(pid) || pid < 1) return 0;
  const result = await query(
    `SELECT * FROM marketplace_questions
     WHERE profile_id = $1 AND marketplace = 'ozon'
       AND (subject IS NULL OR TRIM(COALESCE(subject, '')) = ''
            OR sku_or_offer IS NULL OR TRIM(COALESCE(sku_or_offer, '')) = '')`,
    [pid]
  );
  let updated = 0;
  for (const row of result.rows || []) {
    const enriched = await enrichOzonQuestionFromCatalog({ ...row }, pid);
    if (enriched?.subject && enriched.subject !== row.subject) {
      await marketplaceQuestionsRepo.upsertRow(enriched);
      updated += 1;
    }
  }
  if (updated > 0) {
    logger.info(`[MarketplaceQuestions] Ozon re-enriched product info: ${updated} questions`);
  }
  return updated;
}

/**
 * WB GET /api/v1/questions: параметр isAnswered обязателен (true / false).
 * Делаем два прохода — неотвеченные и отвеченные.
 */
async function syncWildberries(profileId, _organizationId = null) {
  const config = await getQuestionsMarketplaceConfig('wildberries', profileId);
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    const err = new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
    err.statusCode = 400;
    throw err;
  }
  let imported = 0;
  const externalIds = [];
  let skip = 0;
  const take = 100;
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams();
    qs.set('take', String(take));
    qs.set('skip', String(skip));
    qs.set('isAnswered', 'false');
    const url = `https://feedbacks-api.wildberries.ru/api/v1/questions?${qs.toString()}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Wildberries API ${response.status}: ${text.substring(0, 400)}`);
      err.statusCode = response.status === 401 ? 403 : response.status;
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Wildberries: неверный JSON в ответе');
    }
    const dataRoot = json.data ?? json;
    const questions = dataRoot.questions ?? dataRoot.data?.questions ?? [];
    if (!Array.isArray(questions) || questions.length === 0) break;
    const vendorByNm = await wbFetchVendorCodesForQuestions(questions, profileId);
    for (const q of questions) {
      const row = mapWbQuestion(q, profileId);
      if (!row) continue;
      if (!rowNeedsSellerReply(row)) continue;
      applyWbVendorCodeToRow(row, vendorByNm);
      externalIds.push(row.external_id);
      await marketplaceQuestionsRepo.upsertRow(row);
      imported += 1;
    }
    if (questions.length < take) break;
    skip += take;
  }
  return { imported, externalIds };
}

async function syncYandex(profileId, _organizationId = null) {
  const config = await getQuestionsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error(
      'Яндекс.Маркет: не настроен Api-Key (нужен доступ «Общение с покупателями» / communication).'
    );
    err.statusCode = 400;
    logger.warn('[MarketplaceQuestions] Yandex api_key missing for sync', { profileId });
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

  // Важно: API Яндекса ограничивает dateFrom/dateTo интервалом максимум 30 дней.
  // Календарный «месяц» через setUTCMonth часто даёт 31 день → 400 BAD_REQUEST,
  // из‑за чего синк YM полностью падает и вопросы не попадают в ERP.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 29;
  const WINDOWS = 6;
  const now = new Date();
  const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const toDateOnly = (d) => d.toISOString().slice(0, 10);

  for (let w = 0; w < WINDOWS; w++) {
    const end = startOfDay(new Date(now.getTime() - w * WINDOW_DAYS * DAY_MS));
    const start = startOfDay(new Date(end.getTime() - WINDOW_DAYS * DAY_MS));

    const dateTo = toDateOnly(end);
    const dateFrom = toDateOnly(start);

    let pageToken = '';
    for (let i = 0; i < 80; i++) {
      const qs = new URLSearchParams();
      qs.set('limit', '50');
      if (pageToken) qs.set('pageToken', pageToken);
      const url = `https://api.partner.market.yandex.ru/v1/businesses/${businessId}/goods-questions?${qs.toString()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          needAnswer: true,
          sort: 'CREATED_AT_DESC',
          dateFrom,
          dateTo,
        }),
        ...(agent && { agent }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Яндекс.Маркет API ${response.status}: ${text.substring(0, 400)}`);
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('Яндекс.Маркет: неверный JSON в ответе');
      }
      const result = json.result ?? json;
      const questions = result.questions ?? [];
      if (!Array.isArray(questions) || questions.length === 0) break;
      for (const q of questions) {
        const ext = getYandexQuestionExternalId(q);
        const qid = ext != null ? Number(String(ext).trim()) : NaN;
        let payload = q;
        if (Number.isFinite(qid) && qid >= 1) {
          try {
            payload = await enrichYandexQuestionWithAnswers(profileId, q, qid);
          } catch (e) {
            logger.warn('[MarketplaceQuestions] Yandex enrich on sync failed:', e?.message || e);
          }
        }
        const row = mapYandexQuestion(payload, profileId);
        if (!row) continue;
        if (!rowNeedsSellerReply(row)) continue;
        externalIds.push(row.external_id);
        await marketplaceQuestionsRepo.upsertRow(row);
        imported += 1;
      }
      pageToken = result.paging?.nextPageToken ?? '';
      if (!pageToken) break;
    }
  }

  await marketplaceQuestionsRepo.dedupeYandexDuplicateQuestionsByProfile(profileId);
  await marketplaceQuestionsRepo.normalizeYandexExternalIdsForProfile(profileId);
  return { imported, externalIds };
}

/**
 * @param {number} profileId
 * @param {{ only?: 'ozon'|'wildberries'|'yandex'|null }} [opts]
 */
export async function syncMarketplaceQuestions(profileId, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Синхронизация вопросов доступна только при PostgreSQL');
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
      let externalIds = [];
      if (mp === 'ozon') {
        ({ imported, externalIds } = await syncOzon(profileId, opts.organizationId ?? null));
      } else if (mp === 'wildberries') {
        ({ imported, externalIds } = await syncWildberries(profileId, opts.organizationId ?? null));
      } else if (mp === 'yandex') {
        ({ imported, externalIds } = await syncYandex(profileId, opts.organizationId ?? null));
      }
      const purgeStats = await purgeAnsweredMissingFromMarketplace(
        profileId,
        mp,
        externalIds,
        opts.organizationId ?? null
      );
      const cleanup = await marketplaceQuestionsRepo.deleteNotNeedingReplyByProfile(profileId);
      results.push({
        marketplace: mp,
        ok: true,
        imported,
        purged: purgeStats.deleted + (cleanup.deleted ?? 0),
        kept: purgeStats.kept,
        error: null,
      });
      logger.info(
        `[MarketplaceQuestions] ${mp} profile=${profileId} imported=${imported} purged=${purgeStats.deleted} kept=${purgeStats.kept} cleanup=${cleanup.deleted ?? 0}`
      );
    } catch (e) {
      const msg = e?.message || String(e);
      logger.warn(`[MarketplaceQuestions] ${mp} profile=${profileId} failed: ${msg}`);
      results.push({ marketplace: mp, ok: false, imported: 0, error: msg });
    }
  }
  return { results };
}

/** Перед архивацией Ozon: уточняем по question/info — просмотрен без ответа не закрываем. */
async function refreshOzonQuestionRowFromInfo(profileId, row, ozonOverride) {
  const questionId = String(row.external_id ?? '').trim();
  if (!questionId || !ozonOverride) return null;
  try {
    const info = await integrationsService._ozonApiPost(
      '/v1/question/info',
      { question_id: questionId },
      { profileId, ozonOverride }
    );
    if (!info || typeof info !== 'object') return null;
    const merged = {
      ...(row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}),
      ...info,
      id: questionId,
    };
    return finalizeOzonQuestionRow(merged, profileId);
  } catch (e) {
    logger.warn('[MarketplaceQuestions] Ozon question/info on archive check failed', {
      profileId,
      questionRowId: String(row.id),
      error: e?.message || String(e),
    });
    return null;
  }
}

/** Закрытые на МП вопросы убираем из БД (архив не храним). */
async function purgeAnsweredMissingFromMarketplace(profileId, marketplace, externalIds, organizationId = null) {
  const missing = await marketplaceQuestionsRepo.findNeedingReplyMissingFromMarketplace(
    profileId,
    marketplace,
    externalIds,
    { allIfEmpty: true }
  );
  let deleted = 0;
  let kept = 0;
  for (const row of missing) {
    try {
      const mp = String(row.marketplace || '').toLowerCase();
      if (mp === 'ozon') {
        const ozonCfg = await getQuestionsMarketplaceConfig('ozon', profileId);
        const ozonOverride =
          ozonCfg?.client_id && ozonCfg?.api_key
            ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
            : null;
        const refreshed = await refreshOzonQuestionRowFromInfo(profileId, row, ozonOverride);
        if (refreshed && rowNeedsSellerReply(refreshed)) {
          await marketplaceQuestionsRepo.upsertRow(refreshed);
          kept += 1;
          continue;
        }
        await marketplaceQuestionsRepo.deleteByIdAndProfile(row.id, profileId);
        deleted += 1;
        continue;
      }
      const refreshed = await refreshQuestionRowFromMarketplace(profileId, row, organizationId);
      if (refreshed && rowNeedsSellerReply(refreshed)) {
        await marketplaceQuestionsRepo.upsertRow(refreshed);
        kept += 1;
        continue;
      }
      await marketplaceQuestionsRepo.deleteByIdAndProfile(row.id, profileId);
      deleted += 1;
    } catch (e) {
      logger.warn('[MarketplaceQuestions] purge missing question failed', {
        profileId,
        marketplace,
        questionId: row.id,
        error: e?.message || String(e),
      });
      await marketplaceQuestionsRepo.deleteByIdAndProfile(row.id, profileId);
      deleted += 1;
    }
  }
  return { deleted, kept };
}

async function persistRowAfterAnswer(profileId, row, trimmed, _organizationId = null) {
  const mp = String(row.marketplace || '').toLowerCase();
  // Не делаем refresh сразу после ответа: маркетплейс может ещё отдавать старый текст
  // (или чужой ответ), и мы перезапишем только что отправленный ответ пользователя.
  let mergedRaw;
  if (mp === 'ozon') mergedRaw = mergeOzonRawAfterAnswer(row, trimmed);
  else if (mp === 'wildberries' || mp === 'wb') mergedRaw = mergeWbRawAfterAnswer(row, trimmed);
  else if (mp === 'yandex') mergedRaw = mergeYandexRawAfterAnswer(row, trimmed);
  else mergedRaw = { ...(row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}) };

  const thread = buildThreadMessagesFromRow({
    marketplace: row.marketplace,
    rawPayload: mergedRaw,
    body: row.body,
    answerText: trimmed,
    sourceCreatedAt: row.source_created_at,
  });
  return await marketplaceQuestionsRepo.updateAnswerFields(
    row.id,
    profileId,
    trimmed,
    mergedRaw,
    thread
  );
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

export async function listMarketplaceQuestions(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return [];
  }
  const marketplace = query.marketplace != null ? String(query.marketplace).trim() : null;
  const limit = query.limit != null ? Number(query.limit) : 200;
  const offset = query.offset != null ? Number(query.offset) : 0;
  return await marketplaceQuestionsRepo.findByProfile(profileId, {
    marketplace: marketplace && marketplace !== 'all' ? marketplace : null,
    limit: Number.isFinite(limit) ? limit : 200,
    offset: Number.isFinite(offset) ? offset : 0,
    answered: parseAnsweredFilter(query),
  });
}

async function fetchWbQuestionPayload(profileId, externalId, _organizationId = null) {
  const config = await getQuestionsMarketplaceConfig('wildberries', profileId);
  const apiKey = integrationsService._normalizeWbToken(config?.api_key ?? config?.apiKey);
  if (!apiKey) return null;
  const ext = String(externalId ?? '').trim();
  if (!ext) return null;
  const verifyUrl = `https://feedbacks-api.wildberries.ru/api/v1/question?id=${encodeURIComponent(ext)}`;
  const response = await fetch(verifyUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) return null;
  try {
    const vj = JSON.parse(text);
    return vj?.data ?? vj ?? null;
  } catch {
    return null;
  }
}

/** Актуальная ветка с маркетплейса перед открытием диалога или после синхронизации. */
async function refreshQuestionRowFromMarketplace(profileId, row, organizationId = null) {
  const mp = String(row.marketplace || '').toLowerCase();
  if (mp === 'wildberries') {
    const payload = await fetchWbQuestionPayload(profileId, row.external_id, organizationId);
    if (!payload || typeof payload !== 'object') return null;
    const mapped = mapWbQuestion({ ...payload, id: payload.id ?? row.external_id }, profileId);
    if (!mapped) return null;
    const vendorByNm = await wbFetchVendorCodesForQuestions([payload], profileId);
    applyWbVendorCodeToRow(mapped, vendorByNm);
    return mapped;
  }
  if (mp === 'yandex') {
    const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
    const qi = raw?.questionIdentifiers ?? raw?.question_identifiers ?? {};
    const qid = qi?.id ?? raw?.id ?? raw?.questionId ?? raw?.question_id ?? row.external_id;
    const questionId = Number(String(qid).trim());
    if (!Number.isFinite(questionId) || questionId < 1) return null;
    const enrichedRaw = await enrichYandexQuestionWithAnswers(profileId, raw, questionId);
    return mapYandexQuestion(enrichedRaw, profileId);
  }
  if (mp === 'ozon') {
    const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
    const qid = parseOzonQuestionId(row);
    const ozonCfg = await getQuestionsMarketplaceConfig('ozon', profileId);
    const ozonOverride =
      ozonCfg?.client_id && ozonCfg?.api_key
        ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
        : null;
    if (qid != null && ozonOverride) {
      try {
        const data = await integrationsService._ozonApiPost(
          '/v1/question/list',
          { filter: { question_id: qid }, limit: 1, offset: 0 },
          { profileId, ozonOverride }
        );
        const items = extractOzonQuestions(data);
        const item = items[0];
        const itemId = String(item?.id ?? item?.question_id ?? item?.questionId ?? '').trim();
        const wantId = String(qid).trim();
        if (item && itemId && itemId === wantId) {
          return finalizeOzonQuestionRow(item, profileId);
        }
      } catch {
        /* fallback to stored raw */
      }
    }
    const mapped = await finalizeOzonQuestionRow(raw, profileId);
    if (mapped && String(mapped.external_id) !== String(row.external_id)) {
      return finalizeOzonQuestionRow({ ...raw, id: row.external_id, question_id: row.external_id }, profileId);
    }
    return mapped;
  }
  return null;
}

/** Одна карточка вопроса с полной веткой (для окна ответа). */
export async function getMarketplaceQuestionById(profileId, questionRowId, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return null;
  }
  const row = await marketplaceQuestionsRepo.findRowByIdAndProfile(questionRowId, profileId);
  if (!row) return null;

  const shouldRefresh = opts.refresh !== false;

  if (shouldRefresh) {
    let refreshed = null;
    try {
      refreshed = await refreshQuestionRowFromMarketplace(profileId, row, opts.organizationId ?? null);
    } catch (e) {
      logger.warn('[MarketplaceQuestions] refresh thread failed:', e?.message || e);
    }

    if (refreshed) {
      await marketplaceQuestionsRepo.upsertRow(refreshed);
    }
  }

  const current = await marketplaceQuestionsRepo.findRowByIdAndProfile(questionRowId, profileId);
  if (
    current?.marketplace === 'ozon' &&
    (!current.subject || !current.sku_or_offer || isOzonNumericMarketSku(current.sku_or_offer))
  ) {
    const enriched = await enrichOzonQuestionFromCatalog({ ...current }, profileId);
    if (enriched?.subject) {
      await marketplaceQuestionsRepo.upsertRow(enriched);
    }
  }

  return await marketplaceQuestionsRepo.findOneApiByIdAndProfile(questionRowId, profileId);
}

/**
 * Количество вопросов без ответа продавца (для бейджа в меню).
 * @param {number} profileId
 */
export async function countUnansweredMarketplaceQuestions(profileId) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return 0;
  }
  return await marketplaceQuestionsRepo.countUnansweredByProfile(profileId, {});
}

/**
 * Статистика для меню и фильтров: newCount — новые по всем МП; counts — разбивка с учётом query.marketplace.
 * @param {number} profileId
 * @param {{ marketplace?: string }} [query]
 */
export async function getMarketplaceQuestionsStats(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return {
      newCount: 0,
      counts: { all: 0, new: 0, answered: 0 },
      countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
    };
  }
  const raw = query.marketplace != null ? String(query.marketplace).trim().toLowerCase() : '';
  const marketplace =
    raw && raw !== 'all' && ['ozon', 'wildberries', 'yandex'].includes(raw) ? raw : null;
  const [newCount, counts, countsByMarketplace] = await Promise.all([
    marketplaceQuestionsRepo.countUnansweredByProfile(profileId, {}),
    marketplaceQuestionsRepo.countBreakdownByProfile(profileId, { marketplace }),
    marketplaceQuestionsRepo.countQuestionsByMarketplace(profileId),
  ]);
  return { newCount, counts, countsByMarketplace };
}

function parseOzonQuestionId(row) {
  const raw = row.raw_payload || {};
  const cand = raw.id ?? raw.question_id ?? row.questionId ?? row.external_id;
  if (cand == null) return null;
  const s = String(cand).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && String(n) === s) return n;
  return s;
}

function parseOzonQuestionSku(row) {
  const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  const n = Number(raw.sku ?? raw.product_sku);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveOzonQuestionSku(profileId, row, ozonOverride) {
  const fromRow = parseOzonQuestionSku(row);
  if (fromRow != null) return fromRow;
  const questionId = parseOzonQuestionId(row);
  if (questionId == null || !ozonOverride) return null;
  try {
    const info = await integrationsService._ozonApiPost(
      '/v1/question/info',
      { question_id: questionId },
      { profileId, ozonOverride }
    );
    const n = Number(info?.sku);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function mergeOzonRawAfterAnswer(row, trimmed) {
  const mergedRaw = { ...(row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}) };
  const answers = Array.isArray(mergedRaw.answers) ? [...mergedRaw.answers] : [];
  answers.push({
    text: trimmed,
    author: { type: 'SELLER' },
    created_at: new Date().toISOString(),
  });
  mergedRaw.answers = answers;
  return mergedRaw;
}

function mergeWbRawAfterAnswer(row, trimmed) {
  const mergedRaw = { ...(row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}) };
  mergedRaw.answer = {
    ...(typeof mergedRaw.answer === 'object' && mergedRaw.answer != null ? mergedRaw.answer : {}),
    text: trimmed,
    createdDate: new Date().toISOString(),
  };
  return mergedRaw;
}

function mergeYandexRawAfterAnswer(row, trimmed) {
  const mergedRaw = { ...(row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}) };
  const answers = Array.isArray(mergedRaw.answers) ? [...mergedRaw.answers] : [];
  let updated = false;
  for (let i = answers.length - 1; i >= 0; i--) {
    if (inferYandexAnswerAuthor(answers[i]) === 'seller') {
      answers[i] = {
        ...answers[i],
        text: trimmed,
        createdAt: answers[i].createdAt ?? answers[i].created_at ?? new Date().toISOString(),
      };
      updated = true;
      break;
    }
  }
  if (!updated) {
    answers.push({
      text: trimmed,
      author: { type: 'BUSINESS' },
      createdAt: new Date().toISOString(),
    });
  }
  mergedRaw.answers = answers;
  return mergedRaw;
}

async function submitAnswerOzon(profileId, row, text, _organizationId = null) {
  const ozonCfg = await getQuestionsMarketplaceConfig('ozon', profileId);
  const ozonOverride =
    ozonCfg?.client_id && ozonCfg?.api_key
      ? { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key }
      : null;
  const questionId = parseOzonQuestionId(row);
  if (questionId == null) {
    const err = new Error('Ozon: не удалось определить ID вопроса (question_id).');
    err.statusCode = 400;
    throw err;
  }
  const sku = await resolveOzonQuestionSku(profileId, row, ozonOverride);
  if (sku == null) {
    const err = new Error('Ozon: не удалось определить SKU товара для ответа.');
    err.statusCode = 400;
    throw err;
  }
  const raw = row.raw_payload || {};
  const answersArr = Array.isArray(raw.answers) ? raw.answers : [];
  let existingAnswerId = null;
  for (let i = answersArr.length - 1; i >= 0; i--) {
    if (answersArr[i]?.id != null) {
      existingAnswerId = answersArr[i].id;
      break;
    }
  }
  if (existingAnswerId == null) existingAnswerId = raw.answer?.id ?? null;
  if (row.answer_text && existingAnswerId != null) {
    try {
      await integrationsService._ozonApiPost(
        '/v1/question/answer/update',
        { question_id: questionId, answer_id: existingAnswerId, sku, text },
        { profileId, ozonOverride }
      );
      return;
    } catch (e) {
      if (!String(e?.message || '').includes('404')) {
        if (isOzonPremiumPlusQuestionsError(e)) {
          const err = new Error(OZON_PREMIUM_PLUS_HINT);
          err.code = 'OZON_PREMIUM_PLUS_REQUIRED';
          throw err;
        }
        throw e;
      }
    }
  }
  try {
    await integrationsService._ozonApiPost(
      '/v1/question/answer/create',
      { question_id: questionId, sku, text },
      { profileId, ozonOverride }
    );
  } catch (e) {
    if (isOzonPremiumPlusQuestionsError(e)) {
      const err = new Error(OZON_PREMIUM_PLUS_HINT);
      err.code = 'OZON_PREMIUM_PLUS_REQUIRED';
      throw err;
    }
    throw e;
  }
}

async function submitAnswerWildberries(profileId, row, text, _organizationId = null) {
  const config = await getQuestionsMarketplaceConfig('wildberries', profileId);
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    const err = new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
    err.statusCode = 400;
    throw err;
  }
  const ext = String(row.external_id ?? '').trim();
  if (!ext) {
    const err = new Error('Wildberries: нет external_id вопроса.');
    err.statusCode = 400;
    throw err;
  }
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    const err = new Error('Wildberries: пустой текст ответа.');
    err.statusCode = 400;
    throw err;
  }

  const url = 'https://feedbacks-api.wildberries.ru/api/v1/questions';
  // Для feedbacks-api WB ожидает API key в заголовке Authorization (HeaderApiKey), без "Bearer".
  const wbAuthHeaderValue = apiKey;
  // На практике разные WB-инструменты используют разные названия заголовка; дублируем для совместимости.
  const wbAuthHeaders = {
    Authorization: wbAuthHeaderValue,
    'x-api-key': wbAuthHeaderValue,
    'X-Api-Key': wbAuthHeaderValue,
  };
  // В документации WB id — string. Число иногда приводит к “тихому успеху” без применения.
  const idToSend = ext;
  // Вопросы в WB приходят с разными state (например suppliersPortalSynch / wbRu).
  // Для PATCH часто требуется передавать тот же state, что и у вопроса, иначе возможен “тихий успех” без применения.
  const stateFromRow =
    row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload.state ?? row.raw_payload.status : null;
  const stateToSend =
    stateFromRow != null && String(stateFromRow).trim() !== '' ? String(stateFromRow).trim() : 'wbRu';

  const parseWbBodyOrNull = (t) => {
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  const assertWbOkBody = (body, prefix) => {
    if (!body || typeof body !== 'object') return;
    if (body.error === true) {
      throw new Error(`Wildberries: ${prefix}: ${String(body.errorText || body.message || 'ошибка').trim()}`);
    }
    const add = body.additionalErrors;
    if (Array.isArray(add) && add.length > 0) {
      const msg = add
        .map((x) => {
          if (x == null) return null;
          if (typeof x === 'string') return x;
          const m = x.message ?? x.msg ?? x.errorText ?? x.text ?? null;
          return m != null ? String(m) : null;
        })
        .filter(Boolean)
        .join('; ');
      if (msg) throw new Error(`Wildberries: ${prefix}: ${msg}`);
    }
  };

  const doPatch = async (payload, label) => {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...wbAuthHeaders,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const t = await resp.text();
    const b = parseWbBodyOrNull(t);
    logger.info(`[WB Questions] PATCH ${label}`, {
      profileId,
      id: ext,
      status: resp.status,
      state: payload?.state ?? stateToSend,
      bodyPreview: t ? String(t).slice(0, 300) : '',
    });
    if (!resp.ok) {
      // ВАЖНО: 401 от WB — это не 401 "сессия ERM протухла".
      // Если отдать наружу 401, фронт удалит JWT и "выкинет" пользователя на логин.
      const mappedStatus = resp.status === 401 ? 403 : resp.status;
      const err = new Error(`Wildberries API ${resp.status} (${label}): ${t.substring(0, 400)}`);
      err.statusCode = mappedStatus;
      err.wbLabel = label;
      err.wbState = payload?.state ?? null;
      err.wbBody = b;
      throw err;
    }
    assertWbOkBody(b, label);
    return { ok: true };
  };

  const verifyOnce = async () => {
    const verifyUrl = `https://feedbacks-api.wildberries.ru/api/v1/question?id=${encodeURIComponent(ext)}`;
    const vr = await fetch(verifyUrl, {
      method: 'GET',
      headers: { ...wbAuthHeaders, Accept: 'application/json' },
    });
    const vt = await vr.text();
    const vj = parseWbBodyOrNull(vt);
    logger.info('[WB Questions] GET verify (single)', {
      profileId,
      id: ext,
      status: vr.status,
      bodyPreview: vt ? String(vt).slice(0, 300) : '',
    });
    if (!vr.ok) return false;
    try {
      assertWbOkBody(vj, 'verify');
    } catch {
      return false;
    }
    const ans = vj?.data?.answer?.text ?? vj?.answer?.text ?? vj?.answerText ?? null;
    const ansStr = ans != null ? String(ans).trim() : '';
    return !!ansStr && ansStr === trimmed;
  };

  // WB schema помечен как oneOf; на практике разные аккаунты “принимают” разные формы.
  // Пробуем несколько корректных вариантов, прежде чем идти в verify/pending.
  const statesToTry = Array.from(
    new Set(
      [stateToSend, 'wbRu']
        .map((s) => (s != null ? String(s).trim() : ''))
        .filter((s) => s !== '')
    )
  );

  const patchAttempts = [];
  for (const st of statesToTry) {
    patchAttempts.push({
      label: `answer+viewed (flat) state=${st}`,
      payload: { id: idToSend, text: trimmed, state: st, wasViewed: true },
    });
    patchAttempts.push({
      label: `answer (flat) state=${st}`,
      payload: { id: idToSend, text: trimmed, state: st },
    });
    patchAttempts.push({
      label: `answer+viewed (nested) state=${st}`,
      payload: { id: idToSend, state: st, answer: { text: trimmed }, wasViewed: true },
    });
    patchAttempts.push({
      label: `answer (nested) state=${st}`,
      payload: { id: idToSend, state: st, answer: { text: trimmed } },
    });
  }

  // Важно: WB может вернуть 200, но реально не применить. Поэтому после каждого 200 делаем быстрый verify.
  for (const a of patchAttempts) {
    try {
      await doPatch(a.payload, a.label);
      // Небольшая пауза — WB иногда применяет не мгновенно.
      await new Promise((r) => setTimeout(r, 400));
      if (await verifyOnce()) {
        return { verified: true };
      }
    } catch (e) {
      // Если WB вернул внятную ошибку 4xx, нет смысла продолжать.
      const sc = Number(e?.statusCode);
      const msg = String(e?.message || '');
      const wbErrText =
        (e?.wbBody && typeof e.wbBody === 'object' ? (e.wbBody.errorText ?? e.wbBody.message) : null) ?? '';
      const errText = String(wbErrText || msg);

      // Частая ситуация: на одной из попыток WB отвечает 400 “Empty/Unknown state”.
      // Это не “фатальная” ошибка — просто этот вариант payload/state не принят, пробуем следующий.
      const isStateMismatch =
        errText.includes('Empty state') ||
        errText.includes('Empty state in request') ||
        errText.includes('Неизвестный state') ||
        errText.toLowerCase().includes('unknown state');
      if (Number.isFinite(sc) && sc === 400 && isStateMismatch) {
        logger.warn('[WB Questions] PATCH rejected by WB (state mismatch), continue', {
          profileId,
          id: ext,
          attempt: a.label,
          state: e?.wbState ?? a?.payload?.state ?? null,
          error: errText,
        });
        continue;
      }

      if ((Number.isFinite(sc) && sc >= 400 && sc < 500 && sc !== 429) || msg.includes('422')) {
        throw e;
      }
      logger.warn('[WB Questions] PATCH attempt failed', {
        profileId,
        id: ext,
        attempt: a.label,
        error: e?.message || String(e),
      });
    }
  }

  // Отдельно проставляем wasViewed — даже если ответ применится позже, вопрос не должен возвращаться “новым”.
  try {
    await doPatch({ id: idToSend, state: stateToSend, wasViewed: true }, 'wasViewed');
  } catch (e) {
    logger.warn('[WB Questions] PATCH wasViewed failed (non-fatal)', {
      profileId,
      id: ext,
      error: e?.message || String(e),
    });
  }

  // Верификация: WB может применить ответ асинхронно.
  const verifyUrl = `https://feedbacks-api.wildberries.ru/api/v1/question?id=${encodeURIComponent(ext)}`;
  const verifyListBaseUrl = 'https://feedbacks-api.wildberries.ru/api/v1/questions';
  const createdIso =
    (row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload.createdDate : null) ||
    row?.source_created_at ||
    null;
  const createdAtMs = createdIso ? new Date(createdIso).getTime() : NaN;
  const nowMs = Date.now();
  const listFromMs = Number.isFinite(createdAtMs) ? createdAtMs - 7 * 86400_000 : nowMs - 30 * 86400_000;
  const listToMs = Number.isFinite(createdAtMs) ? createdAtMs + 7 * 86400_000 : nowMs;
  const listDateFrom = Math.floor(listFromMs / 1000);
  const listDateTo = Math.floor(listToMs / 1000);

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    const vr = await fetch(verifyUrl, {
      method: 'GET',
      headers: { ...wbAuthHeaders, Accept: 'application/json' },
    });
    const vt = await vr.text();
    const vj = parseWbBodyOrNull(vt);
    logger.info('[WB Questions] GET verify', {
      profileId,
      id: ext,
      attempt: attempt + 1,
      status: vr.status,
      bodyPreview: vt ? String(vt).slice(0, 300) : '',
    });
    if (vr.ok) {
      assertWbOkBody(vj, 'verify');
      const ans = vj?.data?.answer?.text ?? vj?.answer?.text ?? vj?.answerText ?? null;
      const ansStr = ans != null ? String(ans).trim() : '';
      if (ansStr && ansStr === trimmed) {
        return { verified: true };
      }
    }

    // Проверка через список отвеченных.
    try {
      const listUrl =
        `${verifyListBaseUrl}?isAnswered=true&take=200&skip=0&order=dateDesc` +
        `&dateFrom=${encodeURIComponent(String(listDateFrom))}&dateTo=${encodeURIComponent(String(listDateTo))}`;
      const lr = await fetch(listUrl, {
        method: 'GET',
        headers: { ...wbAuthHeaders, Accept: 'application/json' },
      });
      const lt = await lr.text();
      const lj = parseWbBodyOrNull(lt);
      logger.info('[WB Questions] GET verify list', {
        profileId,
        id: ext,
        attempt: attempt + 1,
        status: lr.status,
        bodyPreview: lt ? String(lt).slice(0, 300) : '',
      });
      if (lr.ok) {
        assertWbOkBody(lj, 'verify list');
        const arr = lj?.data?.questions;
        if (Array.isArray(arr)) {
          const found = arr.find((q) => String(q?.id ?? '').trim() === ext);
          const listAns =
            found?.answer?.text ?? found?.answerText ?? found?.answer_text ?? found?.answer ?? null;
          const listAnsStr = listAns != null ? String(listAns).trim() : '';
          if (listAnsStr && listAnsStr === trimmed) {
            return { verified: true };
          }
        }
      }
    } catch (_) {
      // ignore list verification errors
    }
  }

  return { verified: false };
}

function parseYandexQuestionId(row) {
  const raw = row.raw_payload || {};
  const nested = raw.questionIdentifiers?.id;
  const cand = nested ?? raw.id ?? raw.questionId ?? row.question_id ?? row.external_id;
  if (cand == null || cand === '') return null;
  const n = Number(String(cand).trim());
  return Number.isFinite(n) && n >= 1 ? n : null;
}

async function submitAnswerYandex(profileId, row, text, _organizationId = null) {
  const config = await getQuestionsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error(
      'Яндекс.Маркет: не настроен Api-Key (нужен доступ «Общение с покупателями» / communication).'
    );
    err.statusCode = 400;
    logger.warn('[MarketplaceQuestions] Yandex api_key missing for answer', { profileId });
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
  const questionId = parseYandexQuestionId(row);
  if (questionId == null) {
    const err = new Error(
      'Яндекс.Маркет: не удалось определить числовой ID вопроса. Выполните синхронизацию заново.'
    );
    err.statusCode = 400;
    throw err;
  }
  const agent = getYandexHttpsAgent();
  const needsNewReply = rowNeedsSellerReply(row);
  let body;
  if (needsNewReply) {
    body = {
      operationType: 'CREATE',
      parentEntityId: { id: questionId, type: 'QUESTION' },
      text,
    };
  } else {
    const answerId = getYandexLastSellerAnswerId(row.raw_payload);
    if (answerId != null && Number.isFinite(answerId) && answerId >= 1) {
      body = {
        operationType: 'UPDATE',
        entityId: { id: answerId, type: 'ANSWER' },
        text,
      };
    } else {
      body = {
        operationType: 'CREATE',
        parentEntityId: { id: questionId, type: 'QUESTION' },
        text,
      };
    }
  }
  logger.info('[MarketplaceQuestions] Yandex answer request', {
    profileId,
    questionRowId: String(row.id),
    questionId,
    businessId,
    operationType: body.operationType,
    textLen: String(text ?? '').length,
  });
  const url = `https://api.partner.market.yandex.ru/v1/businesses/${businessId}/goods-questions/update`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(agent && { agent }),
  });
  const respText = await response.text();
  if (!response.ok) {
    const err = new Error(`Яндекс.Маркет API ${response.status}: ${respText.substring(0, 400)}`);
    err.statusCode =
      response.status === 401 || response.status === 403
        ? 403
        : response.status >= 400 && response.status < 500
          ? response.status
          : 502;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(respText);
  } catch {
    json = {};
  }
  return json;
}

/**
 * Отправить ответ на вопрос в API маркетплейса и сохранить текст в БД.
 * @param {number} profileId
 * @param {string|number} questionRowId — id строки в marketplace_questions
 * @param {string} text
 */
export async function submitMarketplaceQuestionAnswer(profileId, questionRowId, text, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Ответы на вопросы доступны только при PostgreSQL');
    err.statusCode = 501;
    throw err;
  }
  const trimmed = String(text ?? '').trim();
  if (trimmed.length < 1 || trimmed.length > 5000) {
    const err = new Error('Текст ответа: от 1 до 5000 символов');
    err.statusCode = 400;
    throw err;
  }
  const row = await marketplaceQuestionsRepo.findRowByIdAndProfile(questionRowId, profileId);
  if (!row) {
    const err = new Error('Вопрос не найден');
    err.statusCode = 404;
    throw err;
  }
  logger.info('[Questions Answer] dispatch', {
    profileId,
    questionRowId: String(questionRowId),
    marketplace: row.marketplace,
    externalId: row.external_id,
    textLen: trimmed.length,
  });
  const mp = row.marketplace;
  const organizationId = opts.organizationId ?? null;
  if (mp === 'ozon') {
    await submitAnswerOzon(profileId, row, trimmed, organizationId);
    await marketplaceQuestionsRepo.deleteByIdAndProfile(questionRowId, profileId);
    return {
      id: String(questionRowId),
      deleted: true,
      marketplace: mp,
    };
  }
  if (mp === 'wildberries') {
    const out = await submitAnswerWildberries(profileId, row, trimmed, organizationId);
    if (!out?.verified) {
      logger.warn('[MarketplaceQuestions] WB answer sent but not verified', {
        profileId,
        questionRowId: String(questionRowId),
      });
    }
    await marketplaceQuestionsRepo.deleteByIdAndProfile(questionRowId, profileId);
    return {
      id: String(questionRowId),
      deleted: true,
      marketplace: mp,
      pending: !out?.verified,
    };
  }
  if (mp === 'yandex') {
    await submitAnswerYandex(profileId, row, trimmed, organizationId);
    await marketplaceQuestionsRepo.deleteByIdAndProfile(questionRowId, profileId);
    return {
      id: String(questionRowId),
      deleted: true,
      marketplace: mp,
    };
  }
  const err = new Error('Неизвестный маркетплейс');
  err.statusCode = 400;
  throw err;
}
