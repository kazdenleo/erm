/**
 * Синхронизация вопросов покупателей с Ozon, Wildberries, Яндекс.Маркет.
 */

import integrationsService from './integrations.service.js';
import repositoryFactory from '../config/repository-factory.js';
import marketplaceQuestionsRepo from '../repositories/marketplace_questions.repository.pg.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import { extractYandexGoodsQuestionOfferId } from '../utils/yandex-goods-question-offer.js';
import logger from '../utils/logger.js';

const OZON_QUESTION_BODY = {
  filter: {},
  limit: 100,
  offset: 0,
};

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
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapOzonQuestion(q, profileId) {
  const ext = String(q.id ?? q.question_id ?? q.questionId ?? '').trim();
  if (!ext) return null;
  let answerText = null;
  if (Array.isArray(q.answers) && q.answers.length > 0) {
    const a = q.answers[0];
    answerText = a.text ?? a.message ?? a.answer_text ?? null;
  }
  if (answerText == null && q.answer) {
    answerText = q.answer.text ?? q.answer.message ?? null;
  }
  const body = String(q.text ?? q.question_text ?? '').trim() || '—';
  const offerOrSku =
    q.offer_id != null ? String(q.offer_id).trim() : q.sku != null ? String(q.sku).trim() : null;
  const baseName = q.product_name ?? q.product_title ?? q.name ?? null;
  let subject = baseName != null && String(baseName).trim() !== '' ? String(baseName).trim() : null;
  if (subject && offerOrSku) {
    subject = `${subject} · ${offerOrSku}`;
  } else if (!subject && offerOrSku) {
    subject = String(offerOrSku);
  } else if (!subject && q.sku != null) {
    subject = String(q.sku).trim();
  }
  const sku = q.sku != null ? String(q.sku) : q.offer_id != null ? String(q.offer_id) : null;
  const status = q.status ?? q.question_status ?? null;
  const sourceCreatedAt =
    parseIsoDate(q.created_at) ??
    parseIsoDate(q.createdAt) ??
    parseIsoDate(q.date) ??
    null;
  return {
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
  return {
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
  if (Array.isArray(q.answers) && q.answers.length > 0) {
    answerText = q.answers[0].text ?? q.answers[0].body ?? null;
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
  return {
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

async function syncOzon(profileId) {
  let imported = 0;
  let offset = 0;
  const limit = 100;
  try {
    for (let page = 0; page < 40; page++) {
      const body = { ...OZON_QUESTION_BODY, limit, offset };
      const data = await integrationsService._ozonApiPost('/v1/question/list', body, { profileId });
      const items = extractOzonQuestions(data);
      if (!items.length) break;
      for (const q of items) {
        const row = mapOzonQuestion(q, profileId);
        if (row) {
          await marketplaceQuestionsRepo.upsertRow(row);
          imported += 1;
        }
      }
      if (items.length < limit) break;
      offset += limit;
    }
  } catch (e) {
    if (isOzonPremiumPlusQuestionsError(e)) {
      const err = new Error(OZON_PREMIUM_PLUS_HINT);
      err.code = 'OZON_PREMIUM_PLUS_REQUIRED';
      throw err;
    }
    throw e;
  }
  return imported;
}

/**
 * WB GET /api/v1/questions: параметр isAnswered обязателен (true / false).
 * Делаем два прохода — неотвеченные и отвеченные.
 */
async function syncWildberries(profileId) {
  const config = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    throw new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
  }
  let imported = 0;
  for (const isAnswered of [false, true]) {
    let skip = 0;
    const take = 100;
    const flagLabel = isAnswered ? 'true' : 'false';
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams();
      qs.set('take', String(take));
      qs.set('skip', String(skip));
      qs.set('isAnswered', flagLabel);
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
        throw new Error(`Wildberries API ${response.status}: ${text.substring(0, 400)}`);
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
        if (row) {
          applyWbVendorCodeToRow(row, vendorByNm);
          await marketplaceQuestionsRepo.upsertRow(row);
          imported += 1;
        }
      }
      if (questions.length < take) break;
      skip += take;
    }
  }
  return imported;
}

async function syncYandex(profileId) {
  const config = await integrationsService.getMarketplaceConfig('yandex', { profileId });
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    throw new Error('Яндекс.Маркет: не настроен Api-Key (нужен доступ «Общение с покупателями» / communication).');
  }
  const { businessId } = await getYandexBusinessAndCampaigns(config);
  if (businessId == null || Number.isNaN(Number(businessId)) || Number(businessId) < 1) {
    throw new Error(
      'Яндекс.Маркет: не удалось определить businessId. Укажите Business ID в интеграции или проверьте api_key.'
    );
  }
  const agent = getYandexHttpsAgent();
  let imported = 0;
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
        needAnswer: false,
        sort: 'CREATED_AT_DESC',
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
      const row = mapYandexQuestion(q, profileId);
      if (row) {
        await marketplaceQuestionsRepo.upsertRow(row);
        imported += 1;
      }
    }
    pageToken = result.paging?.nextPageToken ?? '';
    if (!pageToken) break;
  }
  await marketplaceQuestionsRepo.dedupeYandexDuplicateQuestionsByProfile(profileId);
  await marketplaceQuestionsRepo.normalizeYandexExternalIdsForProfile(profileId);
  return imported;
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
      if (mp === 'ozon') {
        imported = await syncOzon(profileId);
      } else if (mp === 'wildberries') {
        imported = await syncWildberries(profileId);
      } else if (mp === 'yandex') {
        imported = await syncYandex(profileId);
      }
      results.push({ marketplace: mp, ok: true, imported, error: null });
      logger.info(`[MarketplaceQuestions] ${mp} profile=${profileId} imported=${imported}`);
    } catch (e) {
      const msg = e?.message || String(e);
      logger.warn(`[MarketplaceQuestions] ${mp} profile=${profileId} failed: ${msg}`);
      results.push({ marketplace: mp, ok: false, imported: 0, error: msg });
    }
  }
  return { results };
}

function parseAnsweredFilter(query) {
  const raw = query.answered ?? query.status ?? null;
  if (raw == null || String(raw).trim() === '') return 'all';
  const a = String(raw).trim().toLowerCase();
  if (a === 'new' || a === 'unanswered' || a === 'pending') return 'new';
  if (a === 'answered' || a === 'done') return 'answered';
  if (a === 'all') return 'all';
  return 'all';
}

export async function listMarketplaceQuestions(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return [];
  }
  const marketplace = query.marketplace != null ? String(query.marketplace).trim() : null;
  const limit = query.limit != null ? Number(query.limit) : 200;
  const offset = query.offset != null ? Number(query.offset) : 0;
  const answered = parseAnsweredFilter(query);
  return await marketplaceQuestionsRepo.findByProfile(profileId, {
    marketplace: marketplace && marketplace !== 'all' ? marketplace : null,
    limit: Number.isFinite(limit) ? limit : 200,
    offset: Number.isFinite(offset) ? offset : 0,
    answered,
  });
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

async function submitAnswerOzon(profileId, row, text) {
  const questionId = parseOzonQuestionId(row);
  if (questionId == null) {
    throw new Error('Ozon: не удалось определить ID вопроса (question_id).');
  }
  const raw = row.raw_payload || {};
  const existingAnswerId =
    (Array.isArray(raw.answers) && raw.answers[0]?.id != null ? raw.answers[0].id : null) ??
    raw.answer?.id ??
    null;
  if (row.answer_text && existingAnswerId != null) {
    try {
      await integrationsService._ozonApiPost(
        '/v1/question/answer/update',
        { question_id: questionId, answer_id: existingAnswerId, text },
        { profileId }
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
      { question_id: questionId, text },
      { profileId }
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

async function submitAnswerWildberries(profileId, row, text) {
  const config = await integrationsService.getMarketplaceConfig('wildberries', { profileId });
  const raw = config?.api_key ?? config?.apiKey;
  const apiKey = raw ? integrationsService._normalizeWbToken(raw) : null;
  if (!apiKey) {
    throw new Error('Wildberries: не настроен API-ключ (нужна категория «Вопросы и отзывы» в токене).');
  }
  const ext = String(row.external_id ?? '').trim();
  if (!ext) {
    throw new Error('Wildberries: нет external_id вопроса.');
  }
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new Error('Wildberries: пустой текст ответа.');
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
      const err = new Error(`Wildberries API ${resp.status} (${label}): ${t.substring(0, 400)}`);
      err.statusCode = resp.status;
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

function getYandexAnswerIdFromRow(row) {
  const raw = row.raw_payload || {};
  if (Array.isArray(raw.answers) && raw.answers[0]?.id != null) return Number(raw.answers[0].id);
  return null;
}

async function submitAnswerYandex(profileId, row, text) {
  const config = await integrationsService.getMarketplaceConfig('yandex', { profileId });
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    throw new Error('Яндекс.Маркет: не настроен Api-Key (нужен доступ «Общение с покупателями» / communication).');
  }
  const { businessId } = await getYandexBusinessAndCampaigns(config);
  if (businessId == null || Number.isNaN(Number(businessId)) || Number(businessId) < 1) {
    throw new Error(
      'Яндекс.Маркет: не удалось определить businessId. Укажите Business ID в интеграции или проверьте api_key.'
    );
  }
  const questionId = parseYandexQuestionId(row);
  if (questionId == null) {
    throw new Error('Яндекс.Маркет: не удалось определить числовой ID вопроса. Выполните синхронизацию заново.');
  }
  const agent = getYandexHttpsAgent();
  const answerId = getYandexAnswerIdFromRow(row);
  let body;
  if (row.answer_text && answerId != null && Number.isFinite(answerId) && answerId >= 1) {
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
    throw new Error(`Яндекс.Маркет API ${response.status}: ${respText.substring(0, 400)}`);
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
export async function submitMarketplaceQuestionAnswer(profileId, questionRowId, text) {
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
  });
  const mp = row.marketplace;
  if (mp === 'ozon') {
    await submitAnswerOzon(profileId, row, trimmed);
  } else if (mp === 'wildberries') {
    const out = await submitAnswerWildberries(profileId, row, trimmed);
    if (!out?.verified) {
      return await marketplaceQuestionsRepo.setPendingAnswer(questionRowId, profileId, trimmed);
    }
  } else if (mp === 'yandex') {
    const json = await submitAnswerYandex(profileId, row, trimmed);
    const apiResult = json?.result;
    let newRawPayload;
    if (row.raw_payload && apiResult && typeof apiResult === 'object') {
      const prev = Array.isArray(row.raw_payload.answers) ? row.raw_payload.answers[0] : {};
      newRawPayload = {
        ...row.raw_payload,
        answers: [
          {
            ...prev,
            id: apiResult.id ?? getYandexAnswerIdFromRow(row),
            text: trimmed,
            questionId: parseYandexQuestionId(row),
          },
        ],
      };
    }
    return await marketplaceQuestionsRepo.updateAnswerFields(
      questionRowId,
      profileId,
      trimmed,
      newRawPayload
    );
  } else {
    const err = new Error('Неизвестный маркетплейс');
    err.statusCode = 400;
    throw err;
  }

  return await marketplaceQuestionsRepo.updateAnswerFields(questionRowId, profileId, trimmed);
}
