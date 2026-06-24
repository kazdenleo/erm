/**
 * Отправка закупки поставщику Moskvorechie (portal.api).
 */

import logger from '../../utils/logger.js';
import {
  MOSKVORECHIE_API_BASE,
  fetchWithTimeout,
  pickWarehouseLine,
  warehouseNameMatches,
} from './shared.js';

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

export function parseMoskvorechieOrderResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { ok: false, message: 'Пустой ответ Moskvorechie' };
  }

  try {
    const data = JSON.parse(raw);
    if (data?.error) {
      return { ok: false, message: String(data.error) };
    }
    if (data?.success === false || data?.ok === false) {
      return {
        ok: false,
        message: String(data.message || data.error || 'Moskvorechie отклонил заказ'),
      };
    }

    if (data?.result != null) {
      const result = data.result;
      if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
        if (result.error || result.err) {
          return { ok: false, message: String(result.error || result.err) };
        }
        const orderId =
          result.order_id ?? result.orderId ?? result.id ?? result.zid ?? null;
        if (orderId) {
          return { ok: true, orderId: String(orderId), message: 'Заказ отправлен Moskvorechie' };
        }
        if (result.success === false || result.ok === false) {
          return {
            ok: false,
            message: String(result.message || result.error || 'Moskvorechie отклонил заказ'),
          };
        }
      }
      if (Array.isArray(result) && result.length > 0) {
        const errors = result
          .map((item) => item?.error || item?.err || item?.message)
          .filter(Boolean);
        const orderIds = result
          .map((item) => item?.order_id ?? item?.orderId ?? item?.id ?? item?.zid ?? null)
          .filter(Boolean);
        if (orderIds.length) {
          return {
            ok: true,
            orderId: String(orderIds[0]),
            message: 'Заказ отправлен Moskvorechie',
          };
        }
        if (errors.length) {
          return { ok: false, message: String(errors[0]) };
        }
      }
    }

    if (data?.success === true || data?.ok === true) {
      const orderId = data.order_id ?? data.orderId ?? data.id ?? data.zid ?? null;
      return {
        ok: true,
        orderId: orderId != null ? String(orderId) : null,
        message: 'Заказ отправлен Moskvorechie',
      };
    }

    return {
      ok: false,
      message: 'Moskvorechie не подтвердил заказ (нет order_id в ответе)',
      raw: raw.slice(0, 500),
    };
  } catch {
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
  logger.info('[MoskvorechieOrder] make_orders response', {
    act,
    lines: orderLines.length,
    preview: text.slice(0, 500),
  });
  return parseMoskvorechieOrderResponse(text);
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
