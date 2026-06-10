/**
 * Отправка остатков («Доступно») в API маркетплейсов.
 */

import fetch from 'node-fetch';
import { query } from '../config/database.js';
import integrationsService from './integrations.service.js';
import logger from '../utils/logger.js';
import { getYandexHttpsAgent } from '../utils/yandex-https-agent.js';

function mpConfig(cfg, type) {
  return integrationsService.getMarketplaceConfig(type, cfg);
}

function ozonHeaders(cfg) {
  const clientId = cfg?.client_id ?? cfg?.clientId;
  const apiKey = cfg?.api_key ?? cfg?.apiKey;
  return {
    'Client-Id': String(clientId),
    'Api-Key': String(apiKey),
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

function wbAuth(cfg) {
  return integrationsService._normalizeWbToken(cfg?.api_key ?? cfg?.apiKey);
}

function yandexKey(cfg) {
  return integrationsService._normalizeYandexApiKey(cfg?.api_key ?? cfg?.apiKey);
}

/**
 * Числовой ID склада МП из сопоставления: "1020001624191000" или "1326703 — Теплый стан".
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseMarketplaceWarehouseId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/^(\d{1,20})/);
  return m ? m[1] : null;
}

/**
 * Штрихкод для WB stocks API (поле sku).
 */
async function resolveWildberriesStockSku({ nmId, productId, profileId, organizationId, mpExtra }) {
  const extra = mpExtra && typeof mpExtra === 'object' ? mpExtra : {};
  if (extra.barcode && String(extra.barcode).trim()) return String(extra.barcode).trim();
  if (extra.wb_barcode && String(extra.wb_barcode).trim()) return String(extra.wb_barcode).trim();

  if (productId) {
    const bc = await query('SELECT barcode FROM barcodes WHERE product_id = $1 ORDER BY id LIMIT 1', [
      productId
    ]);
    if (bc.rows[0]?.barcode) return String(bc.rows[0].barcode).trim();
  }

  try {
    const card = await integrationsService.getWildberriesProductInfo({
      nm_id: nmId,
      profileId,
      organizationId
    });
    const sizes = card?.sizes ?? card?.raw?.sizes ?? [];
    for (const size of sizes) {
      const skus = size?.skus ?? size?.barcodes ?? [];
      if (Array.isArray(skus) && skus.length > 0) {
        const first = skus[0];
        const code = typeof first === 'string' ? first : first?.barcode ?? first?.sku;
        if (code && String(code).trim()) return String(code).trim();
      }
    }
    const vc = card?.vendorCode ?? card?.raw?.vendorCode;
    if (vc && String(vc).trim()) return String(vc).trim();
  } catch (e) {
    logger.warn('[MP Stock Push] WB barcode resolve failed:', e?.message || e);
  }

  return null;
}

/**
 * @param {{ marketplace: string, product: object, productSkus: object[], mapping: object, quantity: number, organizationId: number|string, profileId?: number|string|null }} ctx
 */
export async function pushStockToMarketplace(ctx) {
  const mp = String(ctx.marketplace || '').toLowerCase();
  const qty = Math.max(0, Math.floor(Number(ctx.quantity) || 0));
  const orgId = ctx.organizationId;
  const profileId = ctx.profileId ?? ctx.product?.profile_id ?? ctx.product?.profileId ?? null;

  if (mp === 'ozon') {
    return pushOzon(ctx, qty, orgId, profileId);
  }
  if (mp === 'wb') {
    return pushWildberries(ctx, qty, orgId, profileId);
  }
  if (mp === 'ym') {
    return pushYandex(ctx, qty, orgId, profileId);
  }
  return { marketplace: mp, ok: false, skipped: true, reason: 'unsupported_marketplace' };
}

async function pushOzon(ctx, quantity, organizationId, profileId) {
  const cfg = await mpConfig({ organizationId, profileId }, 'ozon');
  if (!integrationsService._hasOzonCredentials(cfg)) {
    return { marketplace: 'ozon', ok: false, skipped: true, reason: 'no_credentials' };
  }

  const ozonSku = ctx.productSkus?.find((s) => s.marketplace === 'ozon');
  const offerId = (ozonSku?.sku || ctx.product?.sku_ozon || ctx.product?.sku || '').trim();
  const productId =
    ozonSku?.marketplace_product_id != null
      ? Number(ozonSku.marketplace_product_id)
      : ctx.product?.ozon_product_id != null
        ? Number(ctx.product.ozon_product_id)
        : null;
  const mpWarehouseId = parseMarketplaceWarehouseId(ctx.mapping?.marketplace_warehouse_id);

  if (!offerId && !productId) {
    return { marketplace: 'ozon', ok: false, skipped: true, reason: 'no_product_sku' };
  }
  if (!mpWarehouseId) {
    return {
      marketplace: 'ozon',
      ok: false,
      skipped: true,
      reason: String(ctx.mapping?.marketplace_warehouse_id ?? '').trim()
        ? 'invalid_warehouse_mapping'
        : 'no_warehouse_mapping'
    };
  }
  const warehouseIdNum = Number(mpWarehouseId);
  if (!Number.isFinite(warehouseIdNum) || warehouseIdNum <= 0) {
    return { marketplace: 'ozon', ok: false, skipped: true, reason: 'invalid_warehouse_mapping' };
  }

  const stockRow = { stock: quantity, warehouse_id: warehouseIdNum };
  if (offerId) stockRow.offer_id = offerId;
  if (productId && Number.isFinite(productId)) stockRow.product_id = productId;

  const response = await fetch('https://api-seller.ozon.ru/v2/products/stocks', {
    method: 'POST',
    headers: ozonHeaders(cfg),
    body: JSON.stringify({ stocks: [stockRow] })
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const err = new Error(`Ozon stocks: ${response.status} ${text.substring(0, 300)}`);
    err.statusCode = response.status;
    throw err;
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  const rowErrors = (data?.result || [])
    .flatMap((row) => (Array.isArray(row?.errors) ? row.errors : []))
    .filter(Boolean);
  if (rowErrors.length > 0) {
    const err = new Error(`Ozon stocks: ${JSON.stringify(rowErrors).substring(0, 300)}`);
    throw err;
  }
  logger.info(`[MP Stock Push] Ozon OK product=${ctx.product?.id} offer=${offerId} qty=${quantity} wh=${mpWarehouseId}`);
  return { marketplace: 'ozon', ok: true, quantity, warehouseId: mpWarehouseId, response: data };
}

async function pushWildberries(ctx, quantity, organizationId, profileId) {
  const cfg = await mpConfig({ organizationId, profileId }, 'wildberries');
  const apiKey = wbAuth(cfg);
  if (!apiKey) {
    return { marketplace: 'wb', ok: false, skipped: true, reason: 'no_credentials' };
  }

  const wbSku = ctx.productSkus?.find((s) => s.marketplace === 'wb');
  const nmId = wbSku?.sku || ctx.product?.sku_wb;
  const mpWarehouseId = parseMarketplaceWarehouseId(ctx.mapping?.marketplace_warehouse_id);
  if (!nmId) {
    return { marketplace: 'wb', ok: false, skipped: true, reason: 'no_product_sku' };
  }
  if (!mpWarehouseId) {
    return {
      marketplace: 'wb',
      ok: false,
      skipped: true,
      reason: String(ctx.mapping?.marketplace_warehouse_id ?? '').trim()
        ? 'invalid_warehouse_mapping'
        : 'no_warehouse_mapping'
    };
  }

  let mpExtra = wbSku?.mp_extra;
  if (typeof mpExtra === 'string') {
    try {
      mpExtra = JSON.parse(mpExtra);
    } catch {
      mpExtra = {};
    }
  }

  const barcode = await resolveWildberriesStockSku({
    nmId,
    productId: ctx.product?.id,
    profileId,
    organizationId,
    mpExtra
  });
  if (!barcode) {
    return { marketplace: 'wb', ok: false, skipped: true, reason: 'no_wb_barcode' };
  }

  const response = await fetch(
    `https://marketplace-api.wildberries.ru/api/v3/stocks/${encodeURIComponent(mpWarehouseId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: String(apiKey),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ stocks: [{ sku: barcode, amount: quantity }] })
    }
  );
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const err = new Error(`WB stocks: ${response.status} ${text.substring(0, 300)}`);
    err.statusCode = response.status;
    throw err;
  }
  logger.info(`[MP Stock Push] WB OK product=${ctx.product?.id} barcode=${barcode} qty=${quantity} wh=${mpWarehouseId}`);
  return { marketplace: 'wb', ok: true, quantity, warehouseId: mpWarehouseId, barcode };
}

async function pushYandex(ctx, quantity, organizationId, profileId) {
  const cfg = await mpConfig({ organizationId, profileId }, 'yandex');
  const apiKey = yandexKey(cfg);
  const campaignId = String(cfg?.campaign_id ?? cfg?.campaignId ?? '').trim();
  if (!apiKey || !campaignId) {
    return { marketplace: 'ym', ok: false, skipped: true, reason: 'no_credentials' };
  }

  const ymSku = ctx.productSkus?.find((s) => s.marketplace === 'ym');
  const offerId = (ymSku?.sku || ctx.product?.sku_ym || ctx.product?.sku || '').trim();
  if (!offerId) {
    return { marketplace: 'ym', ok: false, skipped: true, reason: 'no_product_sku' };
  }

  const mpWarehouseId = String(ctx.mapping?.marketplace_warehouse_id ?? '').trim();
  const updatedAt = new Date().toISOString();
  const skuPayload = {
    sku: offerId,
    items: [{ type: 'FIT', count: quantity, updatedAt }]
  };
  if (mpWarehouseId) {
    const wid = Number(mpWarehouseId);
    if (Number.isFinite(wid) && wid > 0) skuPayload.warehouseId = wid;
  }

  const agent = getYandexHttpsAgent();
  const response = await fetch(
    `https://api.partner.market.yandex.ru/v2/campaigns/${encodeURIComponent(campaignId)}/offers/stocks`,
    {
      method: 'PUT',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ skus: [skuPayload] }),
      agent
    }
  );
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const err = new Error(`YM stocks: ${response.status} ${text.substring(0, 300)}`);
    err.statusCode = response.status;
    throw err;
  }
  logger.info(`[MP Stock Push] YM OK product=${ctx.product?.id} offer=${offerId} qty=${quantity}`);
  return { marketplace: 'ym', ok: true, quantity, offerId };
}

export default { pushStockToMarketplace };
