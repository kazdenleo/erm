/**
 * Moskvorechie REST API v1 (api.moskvorechie.ru).
 * Документация: POST /orders, GET /profile, POST /cart/add.
 */

import logger from '../../utils/logger.js';
import { fetchWithTimeout } from './shared.js';

export const MOSKVORECHIE_V1_API_BASE = 'https://api.moskvorechie.ru/v1';

function configValue(config, ...keys) {
  for (const key of keys) {
    const v = config?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function moskvorechieV1Configured(config, integrationConfig = {}) {
  const merged = { ...config, ...integrationConfig };
  const apiKey = configValue(merged, 'apiKey', 'v1ApiKey', 'v1_api_key');
  const agreementId = configValue(merged, 'agreementId', 'agreement_id', 'xAgreementId');
  const filialId = configValue(merged, 'filialId', 'filial_id', 'xFilialId');
  return Boolean(apiKey && agreementId && filialId);
}

function pickId(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const v = obj[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function pickFirstFromList(list, ...keys) {
  if (!Array.isArray(list) || !list.length) return '';
  const first = list[0];
  if (typeof first === 'string') return first.trim();
  return pickId(first, ...keys);
}

function pickDefaultOrFirst(list, predicate = () => true) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find((item) => predicate(item)) || list[0];
}

/** Из ответа GET /profile — Agreement ID, Filial ID, delivery_term. */
export function extractMoskvorechieV1Context(profile) {
  if (!profile || typeof profile !== 'object') {
    return { agreementId: '', filialId: '', deliveryTerm: '' };
  }
  const root =
    profile.data && typeof profile.data === 'object'
      ? profile.data
      : profile.profile && typeof profile.profile === 'object'
        ? profile.profile
        : profile;

  let agreementId =
    pickId(root, 'agreement_id', 'agreementId', 'x_agreement_id', 'xAgreementId')
    || pickId(root.agreement, 'id', 'uuid', 'agreement_id', 'agreementId')
    || pickFirstFromList(root.agreements, 'id', 'uuid', 'agreement_id', 'agreementId')
    || pickFirstFromList(root.agreement_list, 'id', 'uuid', 'agreement_id', 'agreementId');

  let filialId =
    pickId(root, 'filial_id', 'filialId', 'x_filial_id', 'xFilialId')
    || pickId(root.filial, 'id', 'uuid', 'filial_id', 'filialId')
    || pickFirstFromList(root.filials, 'id', 'uuid', 'filial_id', 'filialId');

  let deliveryTerm =
    pickId(root, 'delivery_term', 'deliveryTerm')
    || pickFirstFromList(root.delivery_terms, 'id', 'uuid', 'delivery_term', 'deliveryTerm')
    || pickFirstFromList(root.deliveryTerms, 'id', 'uuid', 'delivery_term', 'deliveryTerm');

  const kontragents = root?.order_settings?.kontragents;
  if (Array.isArray(kontragents)) {
    for (const kontragent of kontragents) {
      if (!agreementId) {
        for (const agreement of kontragent?.agreements || []) {
          const termRow = pickDefaultOrFirst(
            agreement?.agreement_terms,
            (row) => row?.is_default === true
          );
          const termId = termRow?.term?.id ?? termRow?.term_id ?? termRow?.id;
          if (termId) {
            agreementId = String(termId);
            break;
          }
          const agreementIdCandidate = pickId(agreement, 'id', 'uuid', 'agreement_id', 'agreementId');
          if (agreementIdCandidate) {
            agreementId = agreementIdCandidate;
            break;
          }
        }
      }
      if (!filialId) {
        const address = pickDefaultOrFirst(
          kontragent?.delivery_addresses,
          (row) => row?.is_default === true
        );
        const addressId = address?.id ?? address?.filial_id ?? address?.filialId;
        if (addressId) filialId = String(addressId);
      }
      if (agreementId && filialId) break;
    }
  }

  if (!filialId && Array.isArray(root.agreements) && root.agreements[0]?.filials) {
    filialId = pickFirstFromList(root.agreements[0].filials, 'id', 'uuid', 'filial_id', 'filialId');
  }

  if (!deliveryTerm) {
    const termRow = pickDefaultOrFirst(root?.delivery_terms, (row) => row?.is_default === true);
    if (termRow?.id) deliveryTerm = String(termRow.id);
  }

  return { agreementId, filialId, deliveryTerm };
}

export async function fetchMoskvorechieV1ProfileApiKeyOnly(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, message: 'Не указан API Key Moskvorechie' };
  }
  const url = `${MOSKVORECHIE_V1_API_BASE}/profile`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-API-Key': key,
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      message: v1ErrorMessage(data, response.status, `profile: HTTP ${response.status}`),
      raw: text.slice(0, 300),
    };
  }
  return { ok: true, profile: data };
}

/** Подставляет Agreement/Filial из GET /profile, если в конфиге только API Key. */
export async function resolveMoskvorechieV1Credentials(config, integrationConfig = {}) {
  const merged = { ...config, ...integrationConfig };
  const apiKey = configValue(merged, 'apiKey', 'v1ApiKey', 'v1_api_key');
  if (!apiKey) {
    return { ok: false, message: 'Не указан API Key Moskvorechie', config: merged };
  }

  let agreementId = configValue(merged, 'agreementId', 'agreement_id', 'xAgreementId');
  let filialId = configValue(merged, 'filialId', 'filial_id', 'xFilialId');
  let deliveryTerm = configValue(merged, 'deliveryTerm', 'delivery_term');

  const resolved = {
    ...merged,
    apiKey,
    password: apiKey,
  };

  if (agreementId && filialId) {
    resolved.agreementId = agreementId;
    resolved.agreement_id = agreementId;
    resolved.filialId = filialId;
    resolved.filial_id = filialId;
    if (deliveryTerm) {
      resolved.deliveryTerm = deliveryTerm;
      resolved.delivery_term = deliveryTerm;
    }
    return { ok: true, config: resolved };
  }

  const profileResult = await fetchMoskvorechieV1ProfileApiKeyOnly(apiKey);
  if (!profileResult.ok) {
    return { ok: false, message: profileResult.message, config: resolved };
  }

  const extracted = extractMoskvorechieV1Context(profileResult.profile);
  agreementId = agreementId || extracted.agreementId;
  filialId = filialId || extracted.filialId;
  deliveryTerm = deliveryTerm || extracted.deliveryTerm;

  if (agreementId) {
    resolved.agreementId = agreementId;
    resolved.agreement_id = agreementId;
  }
  if (filialId) {
    resolved.filialId = filialId;
    resolved.filial_id = filialId;
  }
  if (deliveryTerm) {
    resolved.deliveryTerm = deliveryTerm;
    resolved.delivery_term = deliveryTerm;
  }

  if (!agreementId || !filialId) {
    return {
      ok: false,
      message:
        'API-ключ принят, но Agreement ID и Filial ID не найдены в ответе /profile. ' +
        'Укажите их вручную в дополнительных полях или обратитесь в поддержку Moskvorechie.',
      config: resolved,
      profile: profileResult.profile,
    };
  }

  return { ok: true, config: resolved, profile: profileResult.profile };
}

function v1Headers(config, integrationConfig = {}) {
  const apiKey = configValue(config, 'apiKey', 'v1ApiKey', 'v1_api_key');
  const agreementId = configValue(
    integrationConfig,
    'agreementId',
    'agreement_id'
  ) || configValue(config, 'agreementId', 'agreement_id');
  const filialId = configValue(integrationConfig, 'filialId', 'filial_id')
    || configValue(config, 'filialId', 'filial_id');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
    'X-Agreement-ID': agreementId,
    'X-Filial-ID': filialId,
  };
}

async function v1Request(config, integrationConfig, method, path, body = null) {
  const url = `${MOSKVORECHIE_V1_API_BASE}${path}`;
  const opts = {
    method,
    headers: v1Headers(config, integrationConfig),
  };
  if (body != null) opts.body = JSON.stringify(body);
  const response = await fetchWithTimeout(url, opts);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { response, text, data };
}

function v1ErrorMessage(data, httpStatus, fallback) {
  const err = data?.error;
  if (err && typeof err === 'object') {
    const code = err.code ? `${err.code}: ` : '';
    const msg = `${code}${err.message || fallback}`;
    if (err.code === 'bad_token') {
      return (
        `${msg}. Для заказов нужен ключ «Клиентский API» (api.moskvorechie.ru/v1), ` +
        'не ключ «Доступ к API Портала» (portal.api). Укажите оба ключа в Интеграции → Москворечье.'
      );
    }
    return msg;
  }
  if (data?.message) return String(data.message);
  if (httpStatus === 401) {
    return 'Неверный API-ключ v1 (нужен ключ из раздела «Клиентский API» portal.moskvorechie.ru, не старый portal.api)';
  }
  return fallback;
}

function pickDeliveryTermFromProfile(profile, preferredId) {
  if (preferredId) return preferredId;
  const extracted = extractMoskvorechieV1Context(profile);
  if (extracted.deliveryTerm) return extracted.deliveryTerm;
  const root =
    profile?.data && typeof profile.data === 'object'
      ? profile.data
      : profile?.profile && typeof profile.profile === 'object'
        ? profile.profile
        : profile;
  const terms = root?.delivery_terms || root?.deliveryTerms || root?.terms;
  if (Array.isArray(terms) && terms.length) {
    const first = pickDefaultOrFirst(terms, (row) => row?.is_default === true) || terms[0];
    if (typeof first === 'string') return first;
    return first?.id || first?.uuid || first?.delivery_term || first?.term_id || null;
  }
  if (root?.delivery_term) return String(root.delivery_term);
  return null;
}

function isV1StatusOk(status) {
  return status === 1 || status === '1';
}

function isV1StatusError(status) {
  return status === 0 || status === '0';
}

export function parseMoskvorechieV1CartAddResponse(data, raw = '') {
  if (!data || typeof data !== 'object') {
    return { ok: false, message: 'Пустой ответ Moskvorechie cart/add' };
  }
  if (data.error) {
    return {
      ok: false,
      message: v1ErrorMessage(data, null, 'Moskvorechie v1: ошибка корзины'),
    };
  }

  const cart = Array.isArray(data.cart) ? data.cart : [];
  const failed = cart.filter((item) => isV1StatusError(item?.status));
  const succeeded = cart.filter((item) => isV1StatusOk(item?.status));

  if (isV1StatusError(data.status) || failed.length) {
    const details = failed
      .map((item) => {
        const gid = item?.gid || item?.number || '?';
        return `${gid}: ${item?.error_message || 'ошибка'}`;
      })
      .filter(Boolean)
      .join('; ');
    return {
      ok: false,
      message: String(data.message || details || 'Ошибка добавления в корзину Moskvorechie'),
      failedItems: failed,
      cart,
    };
  }

  const cartPositionIds = succeeded
    .map((item) => item?.cart_position_id ?? item?.cartPositionId)
    .filter((id) => id != null)
    .map((id) => String(id));

  if (!cartPositionIds.length) {
    return {
      ok: false,
      message: 'Moskvorechie v1: нет cart_position_id в ответе cart/add',
      raw: String(raw).slice(0, 500),
      cart,
    };
  }

  return { ok: true, cartPositionIds, cart: succeeded };
}

export function parseMoskvorechieV1OrderResponse(data, raw = '') {
  if (!data || typeof data !== 'object') {
    return { ok: false, message: 'Пустой ответ Moskvorechie v1' };
  }
  if (data.error) {
    return { ok: false, message: v1ErrorMessage(data, null, 'Moskvorechie v1 отклонил заказ') };
  }
  // v1: status 1 — успех, status 0 — ошибки
  const status = data.status;
  if (isV1StatusError(status)) {
    return {
      ok: false,
      message: String(data.message || 'Moskvorechie v1: ошибки при создании заказа'),
    };
  }
  const order = data.order;
  const orderNumber = order?.order_number ?? order?.orderNumber ?? null;
  if (isV1StatusOk(status) || orderNumber) {
    return {
      ok: true,
      orderId: orderNumber ? String(orderNumber) : null,
      message: orderNumber
        ? `Заказ Moskvorechie №${orderNumber}`
        : 'Заказ отправлен Moskvorechie',
      order,
      confirmedWithoutOrderId: !orderNumber,
    };
  }
  return {
    ok: false,
    message: 'Moskvorechie v1 не подтвердил заказ',
    raw: String(raw).slice(0, 500),
  };
}

export async function fetchMoskvorechieV1Profile(config, integrationConfig = {}) {
  const { response, data, text } = await v1Request(config, integrationConfig, 'GET', '/profile');
  if (!response.ok) {
    return {
      ok: false,
      message: v1ErrorMessage(data, response.status, `profile: HTTP ${response.status}`),
      raw: text.slice(0, 300),
    };
  }
  return { ok: true, profile: data };
}

export async function addMoskvorechieV1CartPositions(config, integrationConfig, orderLines) {
  const body = (orderLines || []).map((line) => ({
    gid: String(line.gid),
    quantity: Math.max(1, parseInt(line.quantity, 10) || 1),
    comment: String(line.comment ?? line.lineComment ?? ''),
  }));

  if (!body.length) {
    return { ok: false, message: 'Нет позиций для добавления в корзину Moskvorechie' };
  }

  const { response, data, text } = await v1Request(
    config,
    integrationConfig,
    'POST',
    '/cart/add',
    body
  );

  if (!response.ok) {
    return {
      ok: false,
      message: v1ErrorMessage(data, response.status, `cart/add: HTTP ${response.status}`),
      raw: text.slice(0, 300),
    };
  }

  return parseMoskvorechieV1CartAddResponse(data, text);
}

export async function submitMoskvorechieV1Order({
  config,
  integrationConfig = {},
  orderLines,
  comment,
}) {
  const resolvedCreds = await resolveMoskvorechieV1Credentials(config, integrationConfig);
  if (!resolvedCreds.ok || !moskvorechieV1Configured(resolvedCreds.config, {})) {
    return {
      ok: false,
      message:
        resolvedCreds.message ||
        'Для REST API v1 Moskvorechie укажите API Key в интеграциях (Agreement/Filial подтянутся из /profile)',
    };
  }
  config = resolvedCreds.config;
  integrationConfig = { ...integrationConfig, ...resolvedCreds.config };

  const profileResult = resolvedCreds.profile
    ? { ok: true, profile: resolvedCreds.profile }
    : await fetchMoskvorechieV1Profile(config, integrationConfig);
  if (!profileResult.ok) {
    return profileResult;
  }

  const deliveryTerm =
    configValue(integrationConfig, 'deliveryTerm', 'delivery_term')
    || configValue(config, 'deliveryTerm', 'delivery_term')
    || pickDeliveryTermFromProfile(profileResult.profile);

  if (!deliveryTerm) {
    return {
      ok: false,
      message:
        'Не задан delivery_term для Moskvorechie v1 (укажите в интеграциях или проверьте GET /profile)',
    };
  }

  const cartResult = await addMoskvorechieV1CartPositions(config, integrationConfig, orderLines);
  logger.info('[MoskvorechieOrder] v1 cart/add', {
    lines: orderLines.length,
    ok: cartResult.ok,
    cartPositionIds: cartResult.cartPositionIds ?? [],
  });
  if (!cartResult.ok) {
    return cartResult;
  }

  const cartPositionIds = cartResult.cartPositionIds.map((id) => {
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : id;
  });

  const orderBody = {
    delivery_term: deliveryTerm,
    comment: comment || '',
    positions: cartPositionIds,
  };

  const { response, data, text } = await v1Request(
    config,
    integrationConfig,
    'POST',
    '/orders',
    orderBody
  );

  logger.info('[MoskvorechieOrder] v1 orders response', {
    httpStatus: response.status,
    positions: cartPositionIds.length,
    preview: text.slice(0, 500),
  });

  if (!response.ok) {
    return {
      ok: false,
      message: v1ErrorMessage(data, response.status, `orders: HTTP ${response.status}`),
      raw: text.slice(0, 300),
    };
  }

  return parseMoskvorechieV1OrderResponse(data, text);
}
