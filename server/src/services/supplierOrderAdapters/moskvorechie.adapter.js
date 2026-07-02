/**
 * Отправка закупки поставщику Moskvorechie (portal.api — проценка, REST v1 — заказы).
 */

import logger from '../../utils/logger.js';
import {
  MOSKVORECHIE_API_BASE,
  fetchWithTimeout,
  pickWarehouseLine,
  warehouseNameMatches,
  xmlTag,
} from './shared.js';
import {
  moskvorechieV1Configured,
  submitMoskvorechieV1Order,
} from './moskvorechie.v1.js';

const MOSKV_ORDER_ID_KEYS = [
  'order_id',
  'orderId',
  'orderid',
  'id',
  'zid',
  'oid',
  'zakaz_id',
  'zakazId',
  'order_num',
  'orderNum',
  'num',
  'zak_num',
];

function pickOrderIdFromObject(obj) {
  if (obj == null) return null;
  if (typeof obj === 'string' || typeof obj === 'number') {
    const s = String(obj).trim();
    if (!s || s === 'true' || s === 'false') return null;
    return s;
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const key of MOSKV_ORDER_ID_KEYS) {
    const v = obj[key];
    if (v != null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return null;
}

function moskvApiMessage(obj) {
  return String(obj?.message || obj?.msg || obj?.info || '').trim();
}

/** У portal.api status "1" — код ошибки, "0" — успех (если нет явного success). */
function looksLikeMoskvSuccess(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === true || obj.ok === true) return true;
  const status = obj.status;
  if (status === 1 || status === '1') return false;
  if (status === 0 || status === '0' || status === 'ok' || status === 'success') return true;
  const msg = moskvApiMessage(obj).toLowerCase();
  return (
    msg.includes('успеш') ||
    msg.includes('принят') ||
    msg.includes('оформлен') ||
    (msg.includes('добавлен') && !msg.includes('не добавлен'))
  );
}

function looksLikeMoskvFailure(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === false || obj.ok === false) return true;
  const status = obj.status;
  if (status === 1 || status === '1') return true;
  if (status === 'error' || status === 'fail') return true;
  if (status === 0 || status === '0') return false;
  const msg = moskvApiMessage(obj).toLowerCase();
  if (!msg) return Boolean(obj.error || obj.err);
  return (
    msg.includes('ошиб') ||
    msg.includes('не верная') ||
    msg.includes('неверн') ||
    msg.includes('пуст') ||
    msg.includes('отказ') ||
    msg.includes('нет ') ||
    msg.includes('невозмож') ||
    Boolean(obj.error || obj.err)
  );
}

function failureMessageFromMoskvObj(obj, fallback = 'Moskvorechie отклонил запрос') {
  const msg = moskvApiMessage(obj);
  if (msg) return msg;
  if (obj?.error) return String(obj.error);
  if (obj?.err) return String(obj.err);
  return fallback;
}

function apiKeyFromConfig(config) {
  return config?.apiKey || config?.v1ApiKey || config?.v1_api_key || '';
}

/** Ключ portal.api (проценка, price_by_nr_firm) — отличается от v1 «Клиентский API». */
export function portalCredentialsFromConfig(config, integrationConfig = {}) {
  const merged = { ...config, ...integrationConfig };
  const userId = String(merged.user_id || merged.userId || '').trim();
  const v1Key = apiKeyFromConfig(merged);
  const portalKey = String(
    merged.portalApiKey || merged.portal_api_key || merged.portalPassword || merged.portal_password || ''
  ).trim();
  const legacyPassword = String(merged.password || '').trim();
  const legacyFilePortalKey = String(merged.legacyPortalApiKey || merged.filePortalApiKey || '').trim();
  let apiKey =
    portalKey ||
    (legacyPassword && legacyPassword !== v1Key ? legacyPassword : '') ||
    (legacyFilePortalKey && legacyFilePortalKey !== v1Key ? legacyFilePortalKey : '');
  // Один ключ в интеграциях (apiKey = password) — типичная настройка: и v1 заказы, и portal остатки.
  if (!apiKey && v1Key) {
    apiKey = v1Key;
  }
  return {
    userId,
    apiKey,
    hasPortalKey: Boolean(apiKey),
  };
}

function portalLookupErrorMessage(text, { userId, apiKey } = {}) {
  let errMsg = 'Товар не найден у Moskvorechie';
  try {
    const data = JSON.parse(text);
    const msg = String(data?.result?.msg || data?.error || data?.message || '').trim();
    if (msg) errMsg = msg;
    if (/логин|авториза/i.test(msg)) {
      if (!userId || !apiKey) {
        return (
          'Для поиска товара (gid) укажите в интеграциях Moskvorechie → Дополнительно: ' +
          'User ID (логин portal) и Portal API Key из раздела «Доступ к API Портала». ' +
          'Ключ «Клиентский API» (v1) для этого не подходит.'
        );
      }
      return `Ошибка portal.api Moskvorechie: ${msg}. Проверьте User ID и Portal API Key в интеграциях.`;
    }
  } catch {
    /* ignore */
  }
  return errMsg;
}

/** REST v1 — если есть API Key или уже заданы Agreement/Filial. */
export function shouldUseMoskvorechieV1OrderApi(config, integrationConfig = {}) {
  const merged = { ...config, ...integrationConfig };
  return (
    integrationConfig.orderApiVersion === 'v1' ||
    integrationConfig.order_api_version === 'v1' ||
    Boolean(apiKeyFromConfig(merged)) ||
    moskvorechieV1Configured(config, integrationConfig)
  );
}

function parseMoskvorechieOffers(responseText, sku) {
  try {
    const data = JSON.parse(responseText);
    if (!data?.result || !Array.isArray(data.result)) return [];
    return data.result.map((item) => ({
      gid: item.gid != null ? String(item.gid) : '',
      sku: item.nr || item.code || sku,
      brand: item.brand || item.firm || '',
      warehouseName: item.sname || '',
      stock: parseInt(item.stock, 10) || 0,
      price: parseFloat(item.price) || 0,
      deliveryDays: parseInt(item.ddays, 10) || 0,
      nId: item.n_id != null ? String(item.n_id) : '',
      bId: item.b_id != null ? String(item.b_id) : '',
    }));
  } catch {
    return [];
  }
}

async function fetchMoskvorechieOffers({ sku, brand, config, integrationConfig = {} }) {
  const { userId, apiKey } = portalCredentialsFromConfig(config, integrationConfig);
  if (!userId || !apiKey) {
    throw new Error(
      'Не настроен portal.api Moskvorechie (User ID + Portal API Key в интеграциях → Дополнительно)'
    );
  }
  const params = new URLSearchParams({
    l: userId,
    p: apiKey,
    act: 'price_by_nr_firm',
    v: '1',
    nr: sku,
    f: brand || '',
    cs: 'utf8',
    avail: '',
    extstor: '',
  });
  const url = `${MOSKVORECHIE_API_BASE}?${params.toString()}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json, application/xml, text/xml, */*' },
  });
  if (!response.ok) {
    throw new Error(`Moskvorechie price_by_nr_firm: HTTP ${response.status}`);
  }
  const text = await response.text();
  return { text, offers: parseMoskvorechieOffers(text, sku) };
}

async function lookupMoskvorechieOffer({ sku, brand, config, integrationConfig = {} }) {
  const portalCreds = portalCredentialsFromConfig(config, integrationConfig);
  if (!portalCreds.userId || !portalCreds.apiKey) {
    return {
      ok: false,
      message:
        'Для заказа нужен Portal API Key: интеграции → Moskvorechie → Дополнительно → User ID и ключ из «Доступ к API Портала» (не путать с «Клиентский API»).',
      offers: [],
    };
  }

  const trimmedBrand = String(brand || '').trim();
  let { text, offers } = await fetchMoskvorechieOffers({
    sku,
    brand: trimmedBrand,
    config,
    integrationConfig,
  });

  if (!offers.length && trimmedBrand) {
    logger.info('[MoskvorechieOrder] retry lookup without brand', { sku, brand: trimmedBrand });
    ({ text, offers } = await fetchMoskvorechieOffers({
      sku,
      brand: '',
      config,
      integrationConfig,
    }));
  }

  if (!offers.length) {
    return {
      ok: false,
      message: portalLookupErrorMessage(text, portalCreds),
      offers: [],
    };
  }
  return { ok: true, offers };
}

function parseMoskvorechieOrderResponseFromJson(data, raw) {
  if (data?.error) {
    return { ok: false, message: String(data.error) };
  }
  if (looksLikeMoskvFailure(data)) {
    return {
      ok: false,
      message: String(data.message || data.error || data.err || 'Moskvorechie отклонил заказ'),
    };
  }

  const topOrderId = pickOrderIdFromObject(data);
  if (topOrderId) {
    return { ok: true, orderId: topOrderId, message: 'Заказ отправлен Moskvorechie' };
  }

  if (data?.result != null) {
    const result = data.result;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      if (looksLikeMoskvFailure(result)) {
        return {
          ok: false,
          message: failureMessageFromMoskvObj(result, 'Moskvorechie отклонил заказ'),
        };
      }
      const orderId = pickOrderIdFromObject(result);
      if (orderId) {
        return { ok: true, orderId, message: 'Заказ отправлен Moskvorechie' };
      }
      if (looksLikeMoskvSuccess(result)) {
        return {
          ok: true,
          orderId: null,
          message: 'Заказ отправлен Moskvorechie',
          confirmedWithoutOrderId: true,
        };
      }
    }
    if (Array.isArray(result) && result.length > 0) {
      const errors = result
        .filter((item) => looksLikeMoskvFailure(item))
        .map((item) => item?.error || item?.err || item?.message)
        .filter(Boolean);
      const orderIds = result.map((item) => pickOrderIdFromObject(item)).filter(Boolean);
      if (orderIds.length) {
        return {
          ok: true,
          orderId: orderIds[0],
          message: 'Заказ отправлен Moskvorechie',
        };
      }
      if (errors.length) {
        return { ok: false, message: String(errors[0]) };
      }
      if (result.some((item) => looksLikeMoskvSuccess(item))) {
        return {
          ok: true,
          orderId: null,
          message: 'Заказ отправлен Moskvorechie',
          confirmedWithoutOrderId: true,
        };
      }
    }
    const scalarOrderId = pickOrderIdFromObject(result);
    if (scalarOrderId) {
      return { ok: true, orderId: scalarOrderId, message: 'Заказ отправлен Moskvorechie' };
    }
  }

  if (looksLikeMoskvSuccess(data)) {
    return {
      ok: true,
      orderId: null,
      message: 'Заказ отправлен Moskvorechie',
      confirmedWithoutOrderId: true,
    };
  }

  return {
    ok: false,
    message: 'Moskvorechie не подтвердил заказ (нет подтверждения в ответе)',
    raw: raw.slice(0, 500),
  };
}

function parseMoskvorechieOrderResponseFromXml(raw) {
  const lower = raw.toLowerCase();
  if (lower.includes('<error') || lower.includes('ошиб')) {
    return {
      ok: false,
      message: xmlTag(raw, 'error') || xmlTag(raw, 'message') || raw.slice(0, 300),
    };
  }
  for (const tag of MOSKV_ORDER_ID_KEYS) {
    const value = xmlTag(raw, tag);
    if (value) {
      return { ok: true, orderId: value, message: 'Заказ отправлен Moskvorechie' };
    }
  }
  const message = xmlTag(raw, 'message') || xmlTag(raw, 'info') || '';
  if (looksLikeMoskvSuccess({ message })) {
    return {
      ok: true,
      orderId: null,
      message: message || 'Заказ отправлен Moskvorechie',
      confirmedWithoutOrderId: true,
    };
  }
  return null;
}

export function parseMoskvorechieOrderResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { ok: false, message: 'Пустой ответ Moskvorechie' };
  }

  try {
    return parseMoskvorechieOrderResponseFromJson(JSON.parse(raw), raw);
  } catch {
    const xmlResult = parseMoskvorechieOrderResponseFromXml(raw);
    if (xmlResult) return xmlResult;

    const lower = raw.toLowerCase();
    if (lower.includes('error') || lower.includes('ошиб')) {
      return { ok: false, message: raw.slice(0, 300) };
    }
    return { ok: false, message: 'Не удалось разобрать ответ Moskvorechie', raw: raw.slice(0, 500) };
  }
}

async function submitMoskvorechieOrder({ config, integrationConfig, orderLines, comment }) {
  const mergedConfig = { ...config, ...integrationConfig };
  const useV1 = shouldUseMoskvorechieV1OrderApi(config, integrationConfig);

  if (useV1) {
    return submitMoskvorechieV1Order({
      config: mergedConfig,
      integrationConfig,
      orderLines,
      comment,
    });
  }

  return {
    ok: false,
    message:
      'Для отправки заказов Moskvorechie укажите API Key из «Клиентский API» в интеграциях. ' +
      'Agreement ID и Filial ID подтягиваются автоматически из GET /profile.',
  };
}

/**
 * @param {{ purchase: object, lines: object[], config: object, integrationConfig: object }} ctx
 */
export async function submitMoskvorechiePurchase(ctx) {
  const { purchase, lines, config, integrationConfig = {} } = ctx;
  const apiKey = apiKeyFromConfig(config);
  if (!apiKey) {
    return {
      submitted: false,
      reason: 'no_credentials',
      message: 'Не настроен API Key Moskvorechie в интеграциях',
    };
  }

  const warehouseName = purchase?.supplier_warehouse_name || null;
  const orderLines = [];
  const failedLines = [];

  for (const line of lines) {
    const sku = String(line.sku || '').trim();
    const brand = String(line.brand || '').trim();
    const qty = Math.max(1, parseInt(line.expected_quantity, 10) || 1);
    if (!sku) {
      failedLines.push({ productId: line.product_id, reason: 'no_sku' });
      continue;
    }

    let lookup;
    try {
      lookup = await lookupMoskvorechieOffer({ sku, brand, config, integrationConfig });
    } catch (e) {
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: 'lookup_error',
        message: e?.message || String(e),
      });
      continue;
    }

    if (!lookup.ok) {
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: 'not_found',
        message: lookup.message,
      });
      continue;
    }

    const offer = pickWarehouseLine(
      lookup.offers.map((o) => ({
        gid: o.gid,
        warehouseName: o.warehouseName,
        stock: o.stock,
        brand: o.brand,
      })),
      { warehouseName, quantity: qty }
    );

    if (!offer?.gid) {
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: 'no_gid',
        message: 'Не найден gid для заказа Moskvorechie',
      });
      continue;
    }

    if (warehouseName && offer.warehouseName && !warehouseNameMatches(offer.warehouseName, warehouseName)) {
      logger.warn('[MoskvorechieOrder] warehouse mismatch', {
        preferred: warehouseName,
        actual: offer.warehouseName,
        sku,
      });
    }

    orderLines.push({
      productId: line.product_id,
      sku,
      gid: offer.gid,
      quantity: qty,
      warehouseName: offer.warehouseName,
    });
  }

  if (!orderLines.length) {
    return {
      submitted: false,
      reason: failedLines[0]?.reason || 'all_failed',
      message:
        failedLines[0]?.message ||
        'Не удалось подобрать позиции для заказа Moskvorechie',
      failedLines,
    };
  }

  const comment = purchase?.id ? `ERM закупка №${purchase.id}` : 'ERM';

  try {
    const result = await submitMoskvorechieOrder({
      config,
      integrationConfig,
      orderLines,
      comment,
    });
    if (!result.ok) {
      return {
        submitted: false,
        reason: 'order_rejected',
        message: result.message,
        failedLines,
        preparedLines: orderLines,
      };
    }
    return {
      submitted: true,
      mode: 'v1',
      message: result.message,
      supplierOrderId: result.orderId || null,
      lines: orderLines,
      failedLines: failedLines.length ? failedLines : undefined,
      partial: failedLines.length > 0,
    };
  } catch (e) {
    return {
      submitted: false,
      reason: 'order_error',
      message: e?.message || String(e),
      failedLines,
      preparedLines: orderLines,
    };
  }
}
