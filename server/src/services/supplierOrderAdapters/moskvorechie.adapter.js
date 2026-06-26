/**
 * Отправка закупки поставщику Moskvorechie (portal.api).
 */

import logger from '../../utils/logger.js';
import {
  MOSKVORECHIE_API_BASE,
  fetchWithTimeout,
  pickWarehouseLine,
  warehouseNameMatches,
  xmlTag,
} from './shared.js';

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

function looksLikeMoskvSuccess(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === true || obj.ok === true) return true;
  const status = obj.status;
  if (status === 1 || status === '1' || status === 'ok' || status === 'success') return true;
  const msg = String(obj.message || obj.msg || obj.info || '').toLowerCase();
  return (
    msg.includes('успеш') ||
    msg.includes('принят') ||
    msg.includes('оформлен') ||
    msg.includes('добавлен')
  );
}

function looksLikeMoskvFailure(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === false || obj.ok === false) return true;
  const status = obj.status;
  if (status === 0 || status === '0' || status === 'error' || status === 'fail') return true;
  return Boolean(obj.error || obj.err);
}

function apiKeyFromConfig(config) {
  return config?.apiKey || config?.password || '';
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

async function fetchMoskvorechieOffers({ sku, brand, config }) {
  const apiKey = apiKeyFromConfig(config);
  const params = new URLSearchParams({
    l: config.user_id,
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

async function lookupMoskvorechieOffer({ sku, brand, config }) {
  const trimmedBrand = String(brand || '').trim();
  let { text, offers } = await fetchMoskvorechieOffers({ sku, brand: trimmedBrand, config });

  if (!offers.length && trimmedBrand) {
    logger.info('[MoskvorechieOrder] retry lookup without brand', { sku, brand: trimmedBrand });
    ({ text, offers } = await fetchMoskvorechieOffers({ sku, brand: '', config }));
  }

  if (!offers.length) {
    let errMsg = 'Товар не найден у Moskvorechie';
    try {
      const data = JSON.parse(text);
      if (data?.error || data?.message) errMsg = String(data.error || data.message);
    } catch {
      /* ignore */
    }
    return { ok: false, message: errMsg, offers: [] };
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
          message: String(result.message || result.error || result.err || 'Moskvorechie отклонил заказ'),
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
  const apiKey = apiKeyFromConfig(config);
  const act =
    integrationConfig.orderAct ||
    integrationConfig.order_act ||
    'make_orders';

  const params = new URLSearchParams({
    l: config.user_id,
    p: apiKey,
    act,
    v: '1',
    cs: 'utf8',
  });
  if (comment) params.set('comment', comment);

  for (const line of orderLines) {
    params.append('gid', line.gid);
    params.append('col', String(line.quantity));
  }

  const url = `${MOSKVORECHIE_API_BASE}?${params.toString()}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/json, */*' },
  });
  if (!response.ok) {
    throw new Error(`Moskvorechie ${act}: HTTP ${response.status}`);
  }
  const text = await response.text();
  const parsed = parseMoskvorechieOrderResponse(text);
  logger.info('[MoskvorechieOrder] make_orders response', {
    act,
    lines: orderLines.length,
    ok: parsed.ok,
    orderId: parsed.orderId ?? null,
    confirmedWithoutOrderId: parsed.confirmedWithoutOrderId === true,
    preview: text.slice(0, 500),
  });
  return parsed;
}

/**
 * @param {{ purchase: object, lines: object[], config: object, integrationConfig: object }} ctx
 */
export async function submitMoskvorechiePurchase(ctx) {
  const { purchase, lines, config, integrationConfig = {} } = ctx;
  const apiKey = apiKeyFromConfig(config);
  if (!config?.user_id || !apiKey) {
    return {
      submitted: false,
      reason: 'no_credentials',
      message: 'Не настроены логин/API-ключ Moskvorechie в интеграциях',
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
      lookup = await lookupMoskvorechieOffer({ sku, brand, config });
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
      mode: integrationConfig.orderMode || 'order',
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
