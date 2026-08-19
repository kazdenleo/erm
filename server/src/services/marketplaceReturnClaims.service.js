/**
 * Заявки покупателей на возврат (Ozon rFBS / WB claims / YM returns awaiting decision).
 * Паттерн как у вопросов/отзывов: sync → БД → ответ через API маркетплейса.
 */

import integrationsService from './integrations.service.js';
import marketplaceReturnClaimsRepo from '../repositories/marketplace_return_claims.repository.pg.js';
import repositoryFactory from '../config/repository-factory.js';
import { query } from '../config/database.js';
import { getYandexBusinessAndCampaigns, normalizeYandexApiKey } from './orders.sync.service.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';
import logger from '../utils/logger.js';

/** FBS/FBO заявки, по которым продавец должен ответить в кабинете Ozon. */
const OZON_WAITING_SELLER_SYS = new Set([
  'OnSellerApproval',
  'OnSellerClarification',
  'OnSellerClarificationAfterPartialCompensation',
  'OfferedPartialCompensation',
  'CompensationOffered',
  'DisputeOpened',
  'DisputeYouOpened',
  'WaitingCompensation',
]);

const OZON_RFBS_OPEN_GROUP_STATES = ['New', 'Checkout', 'Arbitration'];

const WB_CLAIMS_URL = 'https://returns-api.wildberries.ru/api/v1/claims';
const WB_CLAIM_URL = 'https://returns-api.wildberries.ru/api/v1/claim';

const YM_DECISION_WAITING = ['PREMODERATION_DECISION_WAITING', 'WAITING_FOR_DECISION'];

const WB_ACTION_LABELS = {
  approve1: 'Одобрить возврат',
  approve2: 'Одобрить возврат',
  approve3: 'Одобрить возврат',
  approvecc1: 'Одобрить с комментарием',
  autorefund1: 'Автовозврат средств',
  reject1: 'Отклонить',
  reject2: 'Отклонить',
  reject3: 'Отклонить',
  rejectcustom: 'Отклонить со своим комментарием',
};

const YM_DECISION_LABELS = {
  FAST_REFUND_MONEY: 'Быстрый возврат денег (без возврата товара)',
  REFUND_MONEY: 'Вернуть деньги за товар',
  REFUND_MONEY_INCLUDING_SHIPMENT: 'Вернуть деньги за товар и доставку возврата',
  PARTIAL_MONEY_REFUND: 'Частичная компенсация',
  REPAIR: 'Ремонт',
  REPLACE: 'Замена',
  SEND_TO_EXAMINATION: 'Отправить на экспертизу',
  DECLINE_REFUND: 'Отказать в возврате',
  OTHER_DECISION: 'Другое решение',
};

const YM_REASON_LABELS = {
  ISSUE_WITH_THE_PRODUCT_WAS_NOT_CONFIRMED: 'Проблема с товаром не подтверждена',
  MECHANICAL_DAMAGE: 'Механические повреждения',
  WARRANTY_PERIOD_HAS_EXPIRED: 'Истёк гарантийный срок',
  CONFIGURATION_OR_PACKAGING_COMPROMISED: 'Нарушена комплектация или упаковка',
  PRODUCT_APPEARANCE_COMPROMISED: 'Нарушен товарный вид',
  WARRANTY_TERMS_VIOLATED: 'Нарушены условия гарантии',
  DEVICE_ACTIVATED: 'Устройство активировано',
};

async function getClaimsMarketplaceConfig(type, profileId) {
  return integrationsService.getMarketplaceConfig(type, { profileId, organizationId: null });
}

function normalizeMarketplaceFilter(mp) {
  const s = String(mp || 'all').trim().toLowerCase();
  if (s === 'wb') return 'wildberries';
  if (s === 'ym') return 'yandex';
  if (['ozon', 'wildberries', 'yandex', 'all'].includes(s)) return s;
  return 'all';
}

function parseDecisionFilter(query) {
  const raw = query?.decision ?? query?.status ?? query?.answered ?? null;
  if (raw == null || String(raw).trim() === '') return 'pending';
  const a = String(raw).trim().toLowerCase();
  if (['pending', 'new', 'open', 'unanswered'].includes(a)) return 'pending';
  if (['done', 'closed', 'answered'].includes(a)) return 'done';
  if (a === 'all') return 'all';
  return 'pending';
}

function absUrl(u) {
  if (u == null || String(u).trim() === '') return null;
  const s = String(u).trim();
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return s;
}

function wbActionLabel(code) {
  const c = String(code || '').trim();
  if (!c) return 'Действие';
  if (WB_ACTION_LABELS[c]) return WB_ACTION_LABELS[c];
  if (/^approve/i.test(c)) return `Одобрить (${c})`;
  if (/^reject/i.test(c)) return `Отклонить (${c})`;
  if (/^auto/i.test(c)) return `Автодействие (${c})`;
  return c;
}

function ymDecisionLabel(type) {
  const t = String(type || '').trim().toUpperCase();
  return YM_DECISION_LABELS[t] || t || 'Решение';
}

function ymReasonLabel(type) {
  const t = String(type || '').trim().toUpperCase();
  return YM_REASON_LABELS[t] || t || 'Причина';
}

function mapWbActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list
    .map((a) => {
      const code = typeof a === 'string' ? a : a?.code ?? a?.action ?? a?.id;
      if (code == null || String(code).trim() === '') return null;
      const c = String(code).trim();
      return {
        id: c,
        code: c,
        label: wbActionLabel(c),
        requiresComment: c === 'rejectcustom' || c === 'approvecc1',
        commentRequired: c === 'rejectcustom',
      };
    })
    .filter(Boolean);
}

function mapOzonActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list
    .map((a) => {
      if (a == null) return null;
      const id = a.id ?? a.action_id ?? a.actionId;
      if (id == null) return null;
      const name = a.name ?? a.display_name ?? a.title ?? String(id);
      return {
        id: String(id),
        code: String(id),
        label: String(name),
        requiresComment: Boolean(a.is_comment_required ?? a.isCommentRequired),
        commentRequired: Boolean(a.is_comment_required ?? a.isCommentRequired),
        requiresCompensation: Number(id) === 1020 || Boolean(a.requires_compensation),
        requiresRejectionReason: Number(id) === -1 || Number(id) === -10 || Boolean(a.requires_rejection_reason),
      };
    })
    .filter(Boolean);
}

function mapOzonRejectionReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  return list
    .map((r) => {
      if (r == null) return null;
      const id = r.id ?? r.rejection_reason_id;
      if (id == null) return null;
      return {
        id: String(id),
        label: String(r.name ?? r.display_name ?? r.title ?? id),
        commentRequired: Boolean(r.is_comment_required ?? r.isCommentRequired),
      };
    })
    .filter(Boolean);
}

function mapYmDecisions(availableDecisions) {
  const list = Array.isArray(availableDecisions) ? availableDecisions : [];
  return list
    .map((d) => {
      if (!d || typeof d !== 'object') return null;
      const type = String(d.decisionType || d.type || '').trim().toUpperCase();
      if (!type) return null;
      const reasons = Array.isArray(d.decisionReasonTypes) ? d.decisionReasonTypes.filter(Boolean) : [];
      return {
        id: type,
        code: type,
        label: ymDecisionLabel(type),
        requiresComment:
          type === 'DECLINE_REFUND' ||
          type === 'OTHER_DECISION' ||
          type === 'REFUND_MONEY_INCLUDING_SHIPMENT' ||
          type === 'PARTIAL_MONEY_REFUND',
        commentRequired: type === 'OTHER_DECISION' || type === 'DECLINE_REFUND',
        requiresCompensation: type === 'PARTIAL_MONEY_REFUND',
        decisionReasonTypes: reasons.map((r) => ({
          id: String(r),
          label: ymReasonLabel(r),
        })),
      };
    })
    .filter(Boolean);
}

/* ───────────────────────── Wildberries ───────────────────────── */

function mapWbClaim(claim, profileId) {
  if (!claim || typeof claim !== 'object') return null;
  const id = claim.id ?? claim.claim_id;
  if (id == null || String(id).trim() === '') return null;
  const actions = mapWbActions(claim.actions);
  const photos = Array.isArray(claim.photos)
    ? claim.photos.map(absUrl).filter(Boolean)
    : [];
  const videos = Array.isArray(claim.video_paths)
    ? claim.video_paths.map(absUrl).filter(Boolean)
    : [];
  return {
    profile_id: profileId,
    marketplace: 'wildberries',
    external_id: String(id),
    status: claim.status_ex != null ? String(claim.status_ex) : claim.status != null ? String(claim.status) : null,
    needs_decision: actions.length > 0,
    buyer_comment: claim.user_comment ?? claim.userComment ?? null,
    seller_comment: claim.wb_comment ?? claim.wbComment ?? null,
    reason: claim.origin_id_info ?? null,
    product_name: claim.imt_name ?? claim.imtName ?? null,
    sku_or_offer: claim.nm_id != null ? String(claim.nm_id) : null,
    order_id: claim.srid != null ? String(claim.srid) : null,
    price: claim.price != null ? Number(claim.price) : null,
    currency: claim.currency_code != null ? String(claim.currency_code) : null,
    photos,
    available_actions: actions,
    rejection_reasons: [],
    items: [],
    campaign_id: null,
    meta: {
      claimType: claim.claim_type ?? null,
      statusEx: claim.status_ex ?? null,
      status: claim.status ?? null,
      videos,
      orderDt: claim.order_dt ?? claim.orderDt ?? null,
      deliveryDt: claim.delivery_dt ?? null,
      srid: claim.srid ?? null,
    },
    raw_payload: claim,
    source_created_at: claim.dt ? new Date(claim.dt) : null,
    source_updated_at: claim.dt_update ? new Date(claim.dt_update) : null,
  };
}

async function fetchWbClaimsPage(apiKey, params) {
  const qs = new URLSearchParams();
  qs.set('is_archive', params.isArchive ? 'true' : 'false');
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  if (params.id) qs.set('id', String(params.id));
  const url = `${WB_CLAIMS_URL}?${qs.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: apiKey,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`WB claims ${response.status}: ${text.substring(0, 400)}`);
    err.statusCode = response.status === 401 ? 403 : response.status;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error('WB claims: неверный JSON');
    err.statusCode = 502;
    throw err;
  }
  const claims = Array.isArray(data?.claims) ? data.claims : Array.isArray(data?.data?.claims) ? data.data.claims : [];
  const total = Number(data?.total ?? data?.data?.total) || claims.length;
  return { claims, total };
}

async function syncWildberries(profileId) {
  const config = await getClaimsMarketplaceConfig('wildberries', profileId);
  const apiKey = integrationsService._normalizeWbToken(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error('Wildberries: не настроен API-ключ (категория «Возвраты покупателей»).');
    err.statusCode = 400;
    throw err;
  }

  let imported = 0;
  const externalIds = [];
  let offset = 0;
  const limit = 200;
  for (let page = 0; page < 50; page++) {
    const { claims, total } = await fetchWbClaimsPage(apiKey, { isArchive: false, limit, offset });
    for (const claim of claims) {
      const mapped = mapWbClaim(claim, profileId);
      if (!mapped) continue;
      await marketplaceReturnClaimsRepo.upsertRow(mapped);
      imported += 1;
      externalIds.push(mapped.external_id);
    }
    offset += claims.length;
    if (claims.length === 0 || offset >= total) break;
  }
  return { imported, externalIds };
}

async function submitAnswerWildberries(profileId, row, body) {
  const config = await getClaimsMarketplaceConfig('wildberries', profileId);
  const apiKey = integrationsService._normalizeWbToken(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error('Wildberries: не настроен API-ключ.');
    err.statusCode = 400;
    throw err;
  }
  const action = String(body?.action ?? body?.actionId ?? body?.code ?? '').trim();
  if (!action) {
    const err = new Error('Укажите действие (action) из списка доступных.');
    err.statusCode = 400;
    throw err;
  }
  const comment = body?.comment != null ? String(body.comment).trim() : '';
  if (action === 'rejectcustom' && comment.length < 10) {
    const err = new Error('Для rejectcustom нужен комментарий не короче 10 символов.');
    err.statusCode = 400;
    throw err;
  }
  const payload = { id: String(row.external_id), action };
  if (comment) payload.comment = comment;

  const response = await fetch(WB_CLAIM_URL, {
    method: 'PATCH',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`WB claim ${response.status}: ${text.substring(0, 400)}`);
    err.statusCode = response.status === 401 ? 403 : response.status >= 400 && response.status < 500 ? 400 : 502;
    throw err;
  }
  return { ok: true, sellerComment: comment || null, status: `answered:${action}` };
}

/* ───────────────────────── Ozon ───────────────────────── */

function extractOzonReturns(data) {
  if (!data || typeof data !== 'object') return [];
  const raw = data.returns ?? data.result?.returns ?? data.items ?? data.result;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && (raw.return_id != null || raw.id != null)) return [raw];
  return [];
}

function ozonReturnId(raw) {
  const id = raw?.return_id ?? raw?.returnId ?? raw?.id;
  if (id == null || String(id).trim() === '') return null;
  return String(id);
}

function ozonVisualSys(raw) {
  return String(raw?.visual?.status?.sys_name || '').trim();
}

function ozonGroupState(raw) {
  return String(raw?.state?.group_state || raw?.group_state || '').trim();
}

function ozonIsOpenRfbs(raw) {
  const g = ozonGroupState(raw);
  return OZON_RFBS_OPEN_GROUP_STATES.some((s) => s.toLowerCase() === g.toLowerCase());
}

function ozonFbsWaitingActions(sys) {
  const s = String(sys || '');
  if (s === 'CompensationOffered' || s === 'OfferedPartialCompensation' || s === 'WaitingCompensation') {
    return [
      {
        id: 'fbs_approve',
        code: 'fbs_approve',
        label: 'Согласовать компенсацию',
      },
      {
        id: 'fbs_reject',
        code: 'fbs_reject',
        label: 'Отклонить',
        requiresComment: true,
        commentRequired: true,
      },
    ];
  }
  return [
    { id: 'fbs_approve', code: 'fbs_approve', label: 'Согласовать возврат' },
    {
      id: 'fbs_reject',
      code: 'fbs_reject',
      label: 'Отклонить заявку',
      requiresComment: true,
      commentRequired: true,
    },
  ];
}

function mapOzonClaim(raw, profileId, detail = null, extraMeta = {}) {
  const detailObj = Array.isArray(detail) ? detail[0] : detail;
  const src =
    detailObj && typeof detailObj === 'object' && !Array.isArray(detailObj) ? { ...raw, ...detailObj } : raw;
  if (!src || typeof src !== 'object') return null;
  const extId = ozonReturnId(src);
  if (!extId) return null;

  const product = src.product && typeof src.product === 'object' ? src.product : {};
  const products = Array.isArray(src.products) ? src.products : product.name || product.offer_id ? [product] : [];
  const first = products[0] && typeof products[0] === 'object' ? products[0] : product;
  const priceObj = first?.price && typeof first.price === 'object' ? first.price : null;
  const priceVal =
    priceObj?.price != null
      ? Number(priceObj.price)
      : first?.price != null && typeof first.price !== 'object'
        ? Number(first.price)
        : null;

  const actionsRaw =
    src.available_actions ??
    src.availableActions ??
    detailObj?.available_actions ??
    detailObj?.availableActions ??
    [];
  let actions = mapOzonActions(actionsRaw);
  const rejectionReasons = mapOzonRejectionReasons(
    src.rejection_reason ?? src.rejection_reasons ?? detailObj?.rejection_reason ?? detailObj?.rejection_reasons ?? []
  );

  const sys = ozonVisualSys(src);
  const groupState = ozonGroupState(src);
  const waitingSeller = OZON_WAITING_SELLER_SYS.has(sys) || ozonIsOpenRfbs(src);
  if (actions.length === 0 && waitingSeller) {
    actions = ozonFbsWaitingActions(sys);
  }

  const status =
    src.visual?.status?.display_name ??
    src.state?.state_name ??
    src.status?.display_name ??
    src.status?.name ??
    (typeof src.status === 'string' ? src.status : null) ??
    groupState ??
    sys ??
    null;

  const photos = [];
  const exemplars = Array.isArray(src.exemplars) ? src.exemplars : [];
  for (const ex of exemplars) {
    const imgs = Array.isArray(ex?.images) ? ex.images : Array.isArray(ex?.photos) ? ex.photos : [];
    for (const img of imgs) {
      const u = absUrl(typeof img === 'string' ? img : img?.url ?? img?.src);
      if (u) photos.push(u);
    }
  }

  const createdAt =
    src.created_at ||
    src.visual?.change_moment ||
    src.logistic?.return_date ||
    src.logistic?.technical_return_moment ||
    null;

  return {
    profile_id: profileId,
    marketplace: 'ozon',
    external_id: extId,
    status: status != null ? String(status) : null,
    needs_decision: waitingSeller || actions.length > 0,
    buyer_comment: src.client_name ?? src.comment ?? src.customer_comment ?? null,
    seller_comment: null,
    reason: src.return_reason_name ?? src.return_reason ?? first?.return_reason ?? null,
    product_name: first?.name ?? first?.offer_id ?? null,
    sku_or_offer:
      first?.offer_id != null
        ? String(first.offer_id)
        : first?.sku != null
          ? String(first.sku)
          : null,
    order_id:
      src.posting_number != null
        ? String(src.posting_number)
        : src.order_number != null
          ? String(src.order_number)
          : null,
    price: Number.isFinite(priceVal) ? priceVal : null,
    currency: priceObj?.currency_code ?? null,
    photos,
    available_actions: actions,
    rejection_reasons: rejectionReasons,
    items: products.map((p) => ({
      id: p?.sku ?? p?.offer_id ?? null,
      name: p?.name ?? null,
      sku: p?.offer_id ?? p?.sku ?? null,
      quantity: p?.quantity ?? 1,
    })),
    campaign_id: null,
    meta: {
      schema: src.schema ?? null,
      type: src.type ?? null,
      postingNumber: src.posting_number ?? src.order_number ?? null,
      sysName: sys || null,
      groupState: groupState || null,
      ozonKind: extraMeta.ozonKind || (sys ? 'returns_list' : 'rfbs'),
      ozonClientId: extraMeta.ozonClientId ?? null,
      companyId: src.company_id ?? extraMeta.companyId ?? null,
    },
    raw_payload: src,
    source_created_at: createdAt ? new Date(createdAt) : null,
    source_updated_at: src.changed_at
      ? new Date(src.changed_at)
      : src.visual?.change_moment
        ? new Date(src.visual.change_moment)
        : null,
  };
}

async function listOzonClaimScopes(profileId) {
  const result = await query(
    `SELECT o.id AS organization_id, mc.config
     FROM marketplace_cabinets mc
     INNER JOIN organizations o ON o.id = mc.organization_id
     WHERE o.profile_id = $1
       AND mc.marketplace_type = 'ozon'
       AND COALESCE(mc.is_active, true) = true
     ORDER BY o.id, mc.id`,
    [profileId]
  );
  const out = [];
  const seen = new Set();
  for (const row of result.rows || []) {
    let parsed = row.config;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = null;
      }
    }
    const client_id = parsed?.client_id ?? parsed?.clientId;
    const api_key = parsed?.api_key ?? parsed?.apiKey;
    if (!client_id || !api_key) continue;
    const key = String(client_id).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      client_id: key,
      api_key: String(api_key).trim(),
      organizationId: row.organization_id,
    });
  }
  if (out.length === 0) {
    const cfg = await getClaimsMarketplaceConfig('ozon', profileId);
    const client_id = cfg?.client_id ?? cfg?.clientId;
    const api_key = cfg?.api_key ?? cfg?.apiKey;
    if (client_id && api_key) {
      out.push({
        client_id: String(client_id).trim(),
        api_key: String(api_key).trim(),
        organizationId: null,
      });
    }
  }
  return out;
}

async function fetchOzonRfbsDetail(profileId, returnId, ozonOverride) {
  const data = await integrationsService._ozonApiPost(
    '/v2/returns/rfbs/get',
    { return_id: Number(returnId) || returnId },
    { profileId, ozonOverride }
  );
  const raw = data?.returns ?? data?.result?.returns ?? data?.result ?? data ?? null;
  return Array.isArray(raw) ? raw[0] : raw;
}

async function fetchOzonReturnsListByStatus(profileId, ozonOverride, visualStatusName) {
  const acc = [];
  let lastId = 0;
  for (let page = 0; page < 50; page++) {
    const body = {
      filter: { visual_status_name: visualStatusName },
      limit: 100,
    };
    if (lastId) body.last_id = lastId;
    const data = await integrationsService._ozonApiPost('/v1/returns/list', body, {
      profileId,
      ozonOverride,
    });
    const rows = extractOzonReturns(data);
    acc.push(...rows);
    const hasNext = Boolean(data?.has_next);
    const tail = rows[rows.length - 1];
    const nextLast = tail?.id ?? lastId;
    if (!hasNext || rows.length === 0 || nextLast === lastId) break;
    lastId = nextLast;
  }
  return acc;
}

async function fetchOzonRfbsOpen(profileId, ozonOverride) {
  const acc = [];
  let lastId = null;
  for (let page = 0; page < 50; page++) {
    const body = {
      filter: { group_state: OZON_RFBS_OPEN_GROUP_STATES },
      limit: 100,
    };
    if (lastId != null) body.last_id = lastId;
    let data;
    try {
      data = await integrationsService._ozonApiPost('/v2/returns/rfbs/list', body, {
        profileId,
        ozonOverride,
      });
    } catch (e) {
      data = await integrationsService._ozonApiPost(
        '/v2/returns/rfbs/list',
        lastId != null ? { limit: 100, last_id: lastId } : { limit: 100 },
        { profileId, ozonOverride }
      );
      void e;
    }
    const rows = extractOzonReturns(data);
    acc.push(...rows);
    if (rows.length === 0) break;
    const nextLast = rows[rows.length - 1]?.return_id ?? rows[rows.length - 1]?.id;
    if (nextLast == null || nextLast === lastId) break;
    lastId = nextLast;
  }
  return acc;
}

async function syncOzon(profileId) {
  const scopes = await listOzonClaimScopes(profileId);
  if (scopes.length === 0) {
    const err = new Error('Ozon: не настроены Client-Id и Api-Key.');
    err.statusCode = 400;
    throw err;
  }

  let imported = 0;
  const externalIds = [];

  for (const scope of scopes) {
    const ozonOverride = { client_id: scope.client_id, api_key: scope.api_key };
    const extraMeta = { ozonClientId: scope.client_id };

    for (const st of OZON_WAITING_SELLER_SYS) {
      let rows = [];
      try {
        rows = await fetchOzonReturnsListByStatus(profileId, ozonOverride, st);
      } catch (e) {
        logger.warn('[ReturnClaims] Ozon returns/list failed', {
          status: st,
          clientId: scope.client_id,
          error: e?.message,
        });
        continue;
      }
      for (const raw of rows) {
        const mapped = mapOzonClaim(raw, profileId, null, { ...extraMeta, ozonKind: 'returns_list' });
        if (!mapped) continue;
        await marketplaceReturnClaimsRepo.upsertRow(mapped);
        imported += 1;
        externalIds.push(mapped.external_id);
      }
    }

    let rfbsRows = [];
    try {
      rfbsRows = await fetchOzonRfbsOpen(profileId, ozonOverride);
    } catch (e) {
      logger.warn('[ReturnClaims] Ozon rfbs/list failed', {
        clientId: scope.client_id,
        error: e?.message,
      });
    }
    for (const raw of rfbsRows) {
      const extId = ozonReturnId(raw);
      if (!extId) continue;
      let detail = null;
      try {
        detail = await fetchOzonRfbsDetail(profileId, extId, ozonOverride);
      } catch (e) {
        logger.warn('[ReturnClaims] Ozon rfbs/get failed', { returnId: extId, error: e?.message });
      }
      const mapped = mapOzonClaim(raw, profileId, detail, { ...extraMeta, ozonKind: 'rfbs' });
      if (!mapped) continue;
      await marketplaceReturnClaimsRepo.upsertRow(mapped);
      imported += 1;
      externalIds.push(mapped.external_id);
    }
  }

  return { imported, externalIds };
}

async function resolveOzonOverrideForRow(profileId, row) {
  const meta = typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta || {};
  const want = meta.ozonClientId != null ? String(meta.ozonClientId) : null;
  const scopes = await listOzonClaimScopes(profileId);
  if (want) {
    const hit = scopes.find((s) => s.client_id === want);
    if (hit) return { client_id: hit.client_id, api_key: hit.api_key };
  }
  if (scopes[0]) return { client_id: scopes[0].client_id, api_key: scopes[0].api_key };
  const ozonCfg = await getClaimsMarketplaceConfig('ozon', profileId);
  if (ozonCfg?.client_id && ozonCfg?.api_key) {
    return { client_id: ozonCfg.client_id, api_key: ozonCfg.api_key };
  }
  return null;
}

async function submitAnswerOzon(profileId, row, body) {
  const ozonOverride = await resolveOzonOverrideForRow(profileId, row);
  if (!ozonOverride) {
    const err = new Error('Ozon: не настроены Client-Id и Api-Key.');
    err.statusCode = 400;
    throw err;
  }

  const actionIdRaw = body?.action ?? body?.actionId ?? body?.id;
  if (actionIdRaw == null || String(actionIdRaw).trim() === '') {
    const err = new Error('Укажите id действия из available_actions.');
    err.statusCode = 400;
    throw err;
  }
  const actionCode = String(actionIdRaw).trim();
  const comment = body?.comment != null ? String(body.comment).trim() : '';
  const returnId = Number(row.external_id) || row.external_id;

  if (actionCode === 'fbs_approve' || actionCode === 'fbs_reject') {
    const path = actionCode === 'fbs_approve' ? '/v2/returns/rfbs/verify' : '/v2/returns/rfbs/reject';
    const payload = { return_id: returnId };
    if (comment) payload.comment = comment;
    if (actionCode === 'fbs_reject' && body?.rejectionReasonId) {
      payload.rejection_reason_id = Number(body.rejectionReasonId) || body.rejectionReasonId;
    }
    try {
      await integrationsService._ozonApiPost(path, payload, { profileId, ozonOverride });
    } catch (e) {
      const err = new Error(
        `Ozon не принял решение по FBS-заявке через API (${e?.message || e}). Согласуйте её в кабинете Ozon.`
      );
      err.statusCode = 400;
      throw err;
    }
    return {
      ok: true,
      sellerComment: comment || null,
      status: actionCode === 'fbs_approve' ? 'Согласована' : 'Отклонена',
    };
  }

  const actionId = Number(actionIdRaw);
  const payload = {
    return_id: returnId,
    id: Number.isFinite(actionId) ? actionId : actionIdRaw,
  };
  if (comment) payload.comment = comment;
  if (body?.rejectionReasonId != null && String(body.rejectionReasonId).trim() !== '') {
    payload.rejection_reason_id = Number(body.rejectionReasonId) || body.rejectionReasonId;
  }
  if (body?.compensationAmount != null && String(body.compensationAmount).trim() !== '') {
    payload.compensation_amount = Number(body.compensationAmount);
  }
  if (body?.returnForBackWay != null && String(body.returnForBackWay).trim() !== '') {
    payload.return_for_back_way = Number(body.returnForBackWay);
  }

  await integrationsService._ozonApiPost('/v1/returns/rfbs/action/set', payload, {
    profileId,
    ozonOverride,
  });

  return {
    ok: true,
    sellerComment: comment || null,
    status: `action:${payload.id}`,
  };
}

/* ───────────────────────── Yandex Market ───────────────────────── */

function mapYmClaim(raw, profileId, campaignId, availableDecisions = []) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id ?? raw.returnId;
  if (id == null) return null;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const first = items[0] && typeof items[0] === 'object' ? items[0] : {};
  const actions = mapYmDecisions(availableDecisions);
  const status = raw.returnStatus ?? raw.status ?? raw.shipmentStatus ?? null;
  const statusUpper = String(status || '').toUpperCase();
  const needsByStatus = YM_DECISION_WAITING.includes(statusUpper);
  const photos = [];
  for (const it of items) {
    const decisions = Array.isArray(it?.decisions) ? it.decisions : [];
    for (const d of decisions) {
      const imgs = Array.isArray(d?.images) ? d.images : [];
      for (const img of imgs) {
        const hash = img?.imageHash ?? img?.hash ?? null;
        if (hash) photos.push(String(hash));
      }
    }
  }

  return {
    profile_id: profileId,
    marketplace: 'yandex',
    external_id: String(id),
    status: status != null ? String(status) : null,
    needs_decision: actions.length > 0 || needsByStatus,
    buyer_comment: first?.comments ?? raw.comment ?? null,
    seller_comment: null,
    reason: first?.returnReasonType ?? first?.returnReason ?? null,
    product_name:
      items.length > 1
        ? `${first.offerName || first.shopSku || 'Товар'} (+${items.length - 1})`
        : first.offerName ?? first.shopSku ?? null,
    sku_or_offer: first.shopSku != null ? String(first.shopSku) : first.marketSku != null ? String(first.marketSku) : null,
    order_id: raw.orderId != null ? String(raw.orderId) : null,
    price: raw.amount != null ? Number(raw.amount) : null,
    currency: null,
    photos,
    available_actions: actions,
    rejection_reasons: [],
    items: items.map((it) => ({
      id: it?.id ?? it?.returnItemId ?? null,
      returnItemId: it?.id ?? it?.returnItemId ?? null,
      name: it?.offerName ?? null,
      sku: it?.shopSku ?? it?.marketSku ?? null,
      count: it?.count ?? 1,
      decisions: it?.decisions ?? [],
    })),
    campaign_id: campaignId != null ? String(campaignId) : null,
    meta: {
      orderId: raw.orderId ?? null,
      returnType: raw.returnType ?? null,
      shipmentStatus: raw.shipmentStatus ?? null,
      fastReturn: raw.fastReturn ?? null,
    },
    raw_payload: { ...raw, _campaignId: campaignId },
    source_created_at: raw.creationDate ? new Date(raw.creationDate) : null,
    source_updated_at: raw.updateDate ? new Date(raw.updateDate) : null,
  };
}

async function fetchYmReturnsForCampaign(apiKey, campaignId, statuses) {
  const agent = getYandexHttpsAgent();
  const acc = [];
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams();
    for (const st of statuses) qs.append('statuses', st);
    if (pageToken) qs.set('pageToken', pageToken);
    const url = `https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(String(campaignId))}/returns?${qs.toString()}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Key': apiKey, Accept: 'application/json' },
      ...(agent && { agent }),
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`Яндекс returns ${r.status}: ${text.substring(0, 400)}`);
      err.statusCode = r.status === 401 ? 403 : r.status;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error('Яндекс returns: неверный JSON');
      err.statusCode = 502;
      throw err;
    }
    const result = data?.result ?? data;
    const rows = Array.isArray(result?.returns) ? result.returns : [];
    acc.push(...rows);
    const next = result?.paging?.nextPageToken;
    if (!next || rows.length === 0) break;
    pageToken = next;
  }
  return acc;
}

async function fetchYmAvailableDecisions(apiKey, businessId, campaignId, returnId) {
  const agent = getYandexHttpsAgent();
  const url = `https://api.partner.market.yandex.ru/v1/businesses/${encodeURIComponent(String(businessId))}/returns/decisions`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      campaignId: Number(campaignId) || campaignId,
      returnId: Number(returnId) || returnId,
    }),
    ...(agent && { agent }),
  });
  const text = await r.text();
  if (!r.ok) {
    logger.warn('[ReturnClaims] YM decisions failed', {
      status: r.status,
      body: text.substring(0, 300),
    });
    return [];
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const result = data?.result ?? data;
  return Array.isArray(result?.availableDecisions) ? result.availableDecisions : [];
}

async function syncYandex(profileId) {
  const config = await getClaimsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error('Яндекс Маркет: не настроен Api-Key.');
    err.statusCode = 400;
    throw err;
  }
  const { businessId, campaignIds } = await getYandexBusinessAndCampaigns(config);
  const ids = Array.isArray(campaignIds) ? [...new Set(campaignIds.filter(Boolean))] : [];
  if (ids.length === 0) {
    const err = new Error('Яндекс Маркет: не найден campaign_id.');
    err.statusCode = 400;
    throw err;
  }

  let imported = 0;
  const externalIds = [];
  for (const campaignId of ids) {
    const rows = await fetchYmReturnsForCampaign(apiKey, campaignId, YM_DECISION_WAITING);
    for (const raw of rows) {
      let decisions = [];
      if (businessId != null) {
        try {
          decisions = await fetchYmAvailableDecisions(apiKey, businessId, campaignId, raw.id);
        } catch (e) {
          logger.warn('[ReturnClaims] YM decisions error', { error: e?.message });
        }
      }
      const mapped = mapYmClaim(raw, profileId, campaignId, decisions);
      if (!mapped) continue;
      mapped.meta = { ...mapped.meta, businessId };
      await marketplaceReturnClaimsRepo.upsertRow(mapped);
      imported += 1;
      externalIds.push(mapped.external_id);
    }
  }
  return { imported, externalIds };
}

async function submitAnswerYandex(profileId, row, body) {
  const config = await getClaimsMarketplaceConfig('yandex', profileId);
  const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
  if (!apiKey) {
    const err = new Error('Яндекс Маркет: не настроен Api-Key.');
    err.statusCode = 400;
    throw err;
  }

  const campaignId = row.campaign_id ?? row.meta?.campaignId ?? body?.campaignId;
  const orderId = row.order_id ?? row.meta?.orderId ?? body?.orderId;
  const returnId = row.external_id;
  if (!campaignId || !orderId || !returnId) {
    const err = new Error('Яндекс: не хватает campaignId / orderId / returnId для решения.');
    err.statusCode = 400;
    throw err;
  }

  let returnItemDecisions = Array.isArray(body?.returnItemDecisions) ? body.returnItemDecisions : null;
  if (!returnItemDecisions || returnItemDecisions.length === 0) {
    const decisionType = String(body?.action ?? body?.decisionType ?? '').trim().toUpperCase();
    if (!decisionType) {
      const err = new Error('Укажите decisionType (action) или returnItemDecisions.');
      err.statusCode = 400;
      throw err;
    }
    const items = Array.isArray(row.items) ? row.items : [];
    const comment = body?.comment != null ? String(body.comment).trim() : '';
    const decisionReasonType =
      body?.decisionReasonType != null ? String(body.decisionReasonType).trim().toUpperCase() : undefined;
    const compensation =
      body?.compensationAmount != null && String(body.compensationAmount).trim() !== ''
        ? Number(body.compensationAmount)
        : undefined;

    if (items.length === 0) {
      const err = new Error('В заявке нет позиций для решения.');
      err.statusCode = 400;
      throw err;
    }
    returnItemDecisions = items.map((it) => {
      const itemId = it.returnItemId ?? it.id;
      const decision = {
        returnItemId: Number(itemId) || itemId,
        decisionType,
      };
      if (comment) decision.comment = comment;
      if (decisionReasonType) decision.decisionReasonType = decisionReasonType;
      if (compensation != null && Number.isFinite(compensation)) decision.compensation = compensation;
      return decision;
    });
  }

  const agent = getYandexHttpsAgent();
  const url = `https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(String(campaignId))}/orders/${encodeURIComponent(String(orderId))}/returns/${encodeURIComponent(String(returnId))}/decision/submit`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ returnItemDecisions }),
    ...(agent && { agent }),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Яндекс decision/submit ${r.status}: ${text.substring(0, 400)}`);
    err.statusCode = r.status === 401 ? 403 : r.status >= 400 && r.status < 500 ? 400 : 502;
    throw err;
  }

  const comment = body?.comment != null ? String(body.comment).trim() : '';
  return {
    ok: true,
    sellerComment: comment || null,
    status: `decision:${returnItemDecisions[0]?.decisionType || 'submitted'}`,
  };
}

/* ───────────────────────── Public API ───────────────────────── */

export async function syncMarketplaceReturnClaims(profileId, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Нужен PostgreSQL');
    err.statusCode = 501;
    throw err;
  }
  const only = opts.only != null ? normalizeMarketplaceFilter(opts.only) : 'all';
  const marketplaces = only === 'all' ? ['ozon', 'wildberries', 'yandex'] : [only];
  const results = [];

  for (const mp of marketplaces) {
    try {
      let data;
      if (mp === 'ozon') data = await syncOzon(profileId);
      else if (mp === 'wildberries') data = await syncWildberries(profileId);
      else if (mp === 'yandex') data = await syncYandex(profileId);
      else continue;
      results.push({ marketplace: mp, ok: true, imported: data.imported });
    } catch (e) {
      logger.warn('[ReturnClaims] sync failed', { marketplace: mp, error: e?.message });
      results.push({
        marketplace: mp,
        ok: false,
        imported: 0,
        error: e?.message || String(e),
      });
    }
  }
  return { results };
}

export async function listMarketplaceReturnClaims(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) return [];
  const marketplace = query.marketplace != null ? String(query.marketplace).trim() : null;
  const limit = query.limit != null ? Number(query.limit) : 200;
  const offset = query.offset != null ? Number(query.offset) : 0;
  return marketplaceReturnClaimsRepo.findByProfile(profileId, {
    marketplace: marketplace && marketplace !== 'all' ? marketplace : null,
    decision: parseDecisionFilter(query),
    limit: Number.isFinite(limit) ? limit : 200,
    offset: Number.isFinite(offset) ? offset : 0,
  });
}

export async function getMarketplaceReturnClaimsStats(profileId, query = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return {
      pendingCount: 0,
      counts: { all: 0, pending: 0, done: 0 },
      countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
    };
  }
  const mp = query.marketplace != null ? String(query.marketplace).trim() : null;
  const pendingCount = await marketplaceReturnClaimsRepo.countPendingByProfile(profileId, {});
  const counts = await marketplaceReturnClaimsRepo.countBreakdownByProfile(profileId, {
    marketplace: mp && mp !== 'all' ? mp : null,
  });
  const countsByMarketplace = await marketplaceReturnClaimsRepo.countPendingByMarketplace(profileId);
  return { pendingCount, counts, countsByMarketplace };
}

async function refreshClaimFromMarketplace(profileId, row) {
  const mp = String(row.marketplace || '').toLowerCase();
  if (mp === 'wildberries') {
    const config = await getClaimsMarketplaceConfig('wildberries', profileId);
    const apiKey = integrationsService._normalizeWbToken(config?.api_key ?? config?.apiKey);
    if (!apiKey) return null;
    const { claims } = await fetchWbClaimsPage(apiKey, {
      isArchive: false,
      id: row.external_id,
      limit: 1,
      offset: 0,
    });
    const claim = claims[0];
    if (!claim) {
      // возможно уже в архиве
      const arch = await fetchWbClaimsPage(apiKey, {
        isArchive: true,
        id: row.external_id,
        limit: 1,
        offset: 0,
      });
      if (!arch.claims[0]) return null;
      return mapWbClaim(arch.claims[0], profileId);
    }
    return mapWbClaim(claim, profileId);
  }
  if (mp === 'ozon') {
    const ozonOverride = await resolveOzonOverrideForRow(profileId, row);
    if (!ozonOverride) return null;
    const extraMeta = { ozonClientId: ozonOverride.client_id };
    try {
      const detail = await fetchOzonRfbsDetail(profileId, row.external_id, ozonOverride);
      if (detail && ozonReturnId(detail)) {
        return mapOzonClaim(detail, profileId, detail, { ...extraMeta, ozonKind: 'rfbs' });
      }
    } catch {
      /* FBS/FBO заявки живут в /v1/returns/list */
    }
    const posting =
      row.order_id ||
      (typeof row.meta === 'object' ? row.meta?.postingNumber : null);
    if (posting) {
      try {
        const data = await integrationsService._ozonApiPost(
          '/v1/returns/list',
          { filter: { posting_numbers: [String(posting)] }, limit: 20 },
          { profileId, ozonOverride }
        );
        const rows = extractOzonReturns(data);
        const hit =
          rows.find((r) => String(r?.id) === String(row.external_id)) || rows[0] || null;
        if (hit) return mapOzonClaim(hit, profileId, null, { ...extraMeta, ozonKind: 'returns_list' });
      } catch {
        /* ignore */
      }
    }
    for (const st of OZON_WAITING_SELLER_SYS) {
      try {
        const rows = await fetchOzonReturnsListByStatus(profileId, ozonOverride, st);
        const hit = rows.find((r) => String(r?.id) === String(row.external_id));
        if (hit) return mapOzonClaim(hit, profileId, null, { ...extraMeta, ozonKind: 'returns_list' });
      } catch {
        /* next status */
      }
    }
    return null;
  }
  if (mp === 'yandex') {
    const config = await getClaimsMarketplaceConfig('yandex', profileId);
    const apiKey = normalizeYandexApiKey(config?.api_key ?? config?.apiKey);
    if (!apiKey) return null;
    const { businessId } = await getYandexBusinessAndCampaigns(config);
    const campaignId = row.campaign_id;
    const orderId = row.order_id;
    if (!campaignId || !orderId) return null;
    const agent = getYandexHttpsAgent();
    const url = `https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(String(campaignId))}/orders/${encodeURIComponent(String(orderId))}/returns/${encodeURIComponent(String(row.external_id))}`;
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Key': apiKey, Accept: 'application/json' },
      ...(agent && { agent }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const raw = data?.result ?? data?.return ?? data;
    let decisions = [];
    if (businessId != null) {
      decisions = await fetchYmAvailableDecisions(apiKey, businessId, campaignId, row.external_id);
    }
    const mapped = mapYmClaim(raw, profileId, campaignId, decisions);
    if (mapped) mapped.meta = { ...mapped.meta, businessId };
    return mapped;
  }
  return null;
}

export async function getMarketplaceReturnClaimById(profileId, claimRowId, opts = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) return null;
  const row = await marketplaceReturnClaimsRepo.findRowByIdAndProfile(claimRowId, profileId);
  if (!row) return null;

  if (opts.refresh !== false) {
    try {
      const refreshed = await refreshClaimFromMarketplace(profileId, row);
      if (refreshed) await marketplaceReturnClaimsRepo.upsertRow(refreshed);
    } catch (e) {
      logger.warn('[ReturnClaims] refresh failed', { id: claimRowId, error: e?.message });
    }
  }
  return marketplaceReturnClaimsRepo.findOneApiByIdAndProfile(claimRowId, profileId);
}

export async function submitMarketplaceReturnClaimDecision(profileId, claimRowId, body = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    const err = new Error('Нужен PostgreSQL');
    err.statusCode = 501;
    throw err;
  }
  const row = await marketplaceReturnClaimsRepo.findRowByIdAndProfile(claimRowId, profileId);
  if (!row) {
    const err = new Error('Заявка не найдена');
    err.statusCode = 404;
    throw err;
  }

  // подтягиваем актуальные actions перед ответом
  try {
    const refreshed = await refreshClaimFromMarketplace(profileId, row);
    if (refreshed) {
      await marketplaceReturnClaimsRepo.upsertRow(refreshed);
      Object.assign(row, {
        available_actions: refreshed.available_actions,
        rejection_reasons: refreshed.rejection_reasons,
        items: refreshed.items,
        campaign_id: refreshed.campaign_id ?? row.campaign_id,
        meta: refreshed.meta,
        order_id: refreshed.order_id ?? row.order_id,
      });
    }
  } catch (e) {
    logger.warn('[ReturnClaims] pre-answer refresh failed', { error: e?.message });
  }

  const apiRow = {
    ...row,
    items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
    meta: typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta,
    available_actions:
      typeof row.available_actions === 'string' ? JSON.parse(row.available_actions) : row.available_actions,
  };

  const mp = String(row.marketplace || '').toLowerCase();
  let result;
  if (mp === 'wildberries') result = await submitAnswerWildberries(profileId, apiRow, body);
  else if (mp === 'ozon') result = await submitAnswerOzon(profileId, apiRow, body);
  else if (mp === 'yandex') result = await submitAnswerYandex(profileId, apiRow, body);
  else {
    const err = new Error(`Неизвестный маркетплейс: ${mp}`);
    err.statusCode = 400;
    throw err;
  }

  return marketplaceReturnClaimsRepo.markDecided(claimRowId, profileId, {
    status: result.status,
    sellerComment: result.sellerComment,
    availableActions: [],
  });
}
