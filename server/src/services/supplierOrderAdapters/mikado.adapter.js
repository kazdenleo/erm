/**
 * Отправка закупки в корзину Mikado (basket.asmx / Basket_Add).
 */

import logger from '../../utils/logger.js';
import {
  MIKADO_BASKET_BASE,
  MIKADO_STOCK_BASE,
  buildQueryUrl,
  encodeQueryValueWindows1251,
  fetchWithTimeout,
  formatSupplierPurchaseComment,
  pickWarehouseLine,
  sourceOrderIdsFromPurchaseLine,
  xmlTag,
} from './shared.js';

function parseMikadoStockLines(xmlText) {
  const lines = [];
  for (const match of String(xmlText || '').matchAll(/<CodeBrandLine>([\s\S]*?)<\/CodeBrandLine>/gi)) {
    const item = match[1];
    const stockRaw =
      xmlTag(item, 'StockQTY') ||
      xmlTag(item, 'Stock') ||
      xmlTag(item, 'Quantity') ||
      xmlTag(item, 'StockQuantity');
    lines.push({
      zakazCode: xmlTag(item, 'ZakazCode') || xmlTag(item, 'OrderCode'),
      orderCode: xmlTag(item, 'OrderCode'),
      stockId: parseInt(xmlTag(item, 'StokID'), 10) || 0,
      warehouseName: xmlTag(item, 'StokName'),
      stock: parseInt(stockRaw, 10) || 0,
      minQty: Math.max(1, parseInt(xmlTag(item, 'MinZakazQTY'), 10) || 1),
    });
  }
  return lines.filter((l) => l.zakazCode);
}

async function lookupMikadoOffer({ sku, brand, config }) {
  const url = buildQueryUrl(`${MIKADO_STOCK_BASE}/CodeBrandStockInfo`, {
    Code: sku,
    Brand: brand || '',
    ClientID: config.user_id,
    Password: config.password,
  });
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml, */*' },
  });
  if (!response.ok) {
    throw new Error(`Mikado CodeBrandStockInfo: HTTP ${response.status}`);
  }
  const xml = await response.text();
  const message = xmlTag(xml, 'Message');
  const lines = parseMikadoStockLines(xml);
  if (!lines.length) {
    return { ok: false, message: message || 'Товар не найден у Mikado', lines: [] };
  }
  return { ok: true, lines, message: message || null };
}

function isMikadoBasketAddOk({ basketId, message, orderedQty }) {
  if (basketId > 0) return true;
  const msg = String(message || '').trim();
  // Mikado иногда отвечает Message=OK без ID в XML — позиция уже в корзине.
  if (/^ok$/i.test(msg)) return true;
  if (orderedQty > 0 && /ok|добавл|added|success/i.test(msg)) return true;
  return false;
}

function isAmbiguousMikadoNetworkError(message) {
  return /таймаут|timeout|aborterror|econnreset|econnrefused|fetch failed|network|socket/i.test(
    String(message || '')
  );
}

async function addToMikadoBasket({
  config,
  zakazCode,
  stockId,
  quantity,
  notes,
  deliveryType,
  expressId,
}) {
  const url = buildQueryUrl(
    `${MIKADO_BASKET_BASE}/Basket_Add`,
    {
      ZakazCode: zakazCode,
      QTY: Math.max(1, parseInt(quantity, 10) || 1),
      DeliveryType: deliveryType ?? 0,
      ExpressID: expressId ?? 0,
      StockID: stockId ?? 0,
      Notes: notes || '',
      ClientID: config.user_id,
      Password: config.password,
    },
    {
      // Notes с кириллицей: Mikado читает query как windows-1251.
      encodeValue: (key, value) =>
        key === 'Notes' ? encodeQueryValueWindows1251(value) : encodeURIComponent(value),
    }
  );
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml, */*' },
  });
  if (!response.ok) {
    throw new Error(`Mikado Basket_Add: HTTP ${response.status}`);
  }
  const xml = await response.text();
  const basketId = parseInt(xmlTag(xml, 'ID'), 10) || 0;
  const message = xmlTag(xml, 'Message');
  const orderedQty = parseInt(xmlTag(xml, 'OrderedQTY'), 10) || 0;
  const ok = isMikadoBasketAddOk({ basketId, message, orderedQty });
  return {
    ok,
    basketItemId: basketId || null,
    orderedQty,
    message:
      message ||
      (ok ? 'Добавлено в корзину Mikado' : 'Mikado не принял позицию'),
    raw: xml.slice(0, 500),
  };
}

/** Снять позицию из корзины Mikado (Basket_Delete). */
export async function deleteMikadoBasketItem(config, itemId) {
  const id = parseInt(itemId, 10);
  if (!config?.user_id || !config?.password || !Number.isFinite(id) || id < 1) {
    return { ok: false, reason: 'invalid_args' };
  }
  const url = buildQueryUrl(`${MIKADO_BASKET_BASE}/Basket_Delete`, {
    ItemID: id,
    ClientID: config.user_id,
    Password: config.password,
  });
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml, */*' },
  });
  if (!response.ok) {
    throw new Error(`Mikado Basket_Delete: HTTP ${response.status}`);
  }
  const xml = await response.text();
  const message = xmlTag(xml, 'Message');
  return {
    ok: !message || /^ok$/i.test(message) || /удал|delete|success/i.test(message),
    message: message || 'OK',
    basketItemId: id,
  };
}

/**
 * Массовое снятие позиций корзины Mikado (при откате локальной закупки).
 * Ошибки отдельных ID не прерывают остальные.
 */
export async function deleteMikadoBasketItems(config, itemIds = []) {
  const ids = [...new Set((itemIds || []).map((x) => parseInt(x, 10)).filter((n) => n > 0))];
  const deleted = [];
  const failed = [];
  for (const id of ids) {
    try {
      const out = await deleteMikadoBasketItem(config, id);
      if (out.ok) deleted.push(id);
      else failed.push({ id, message: out.message });
    } catch (e) {
      failed.push({ id, message: e?.message || String(e) });
    }
  }
  return { deleted, failed };
}

/**
 * @param {{ purchase: object, lines: object[], config: object, integrationConfig: object }} ctx
 */
export async function submitMikadoPurchase(ctx) {
  const { purchase, lines, config, integrationConfig = {} } = ctx;
  if (!config?.user_id || !config?.password) {
    return {
      submitted: false,
      reason: 'no_credentials',
      message: 'Не настроены ClientID/пароль Mikado в интеграциях',
    };
  }

  const deliveryType = integrationConfig.deliveryType ?? integrationConfig.delivery_type ?? 0;
  const expressId = integrationConfig.expressId ?? integrationConfig.express_id ?? 0;
  const warehouseName = purchase?.supplier_warehouse_name || null;

  const submittedLines = [];
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
      lookup = await lookupMikadoOffer({ sku, brand, config });
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
      lookup.lines.map((l) => ({
        zakazCode: l.zakazCode,
        stockId: l.stockId,
        warehouseName: l.warehouseName,
        stock: l.stock,
        minQty: l.minQty,
      })),
      { warehouseName, quantity: qty }
    );

    if (!offer?.zakazCode) {
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: 'no_offer',
        message: 'Нет подходящего предложения Mikado',
      });
      continue;
    }

    if (offer.stock > 0 && offer.stock < qty) {
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: 'insufficient_stock',
        message: `На складе ${offer.warehouseName || 'Mikado'} только ${offer.stock} шт.`,
      });
      continue;
    }

    const orderQty = Math.max(qty, offer.minQty || 1);
    const notes = formatSupplierPurchaseComment({
      purchaseId: purchase?.id,
      orderIds: sourceOrderIdsFromPurchaseLine(line),
      sku,
      brand,
      // ASCII: номер заказа МП читается даже если сайт снова сломает кодировку.
      ascii: true,
    });

    try {
      const add = await addToMikadoBasket({
        config,
        zakazCode: offer.zakazCode,
        stockId: offer.stockId,
        quantity: orderQty,
        notes,
        deliveryType,
        expressId,
      });
      if (add.ok) {
        submittedLines.push({
          productId: line.product_id,
          sku,
          basketItemId: add.basketItemId,
          orderedQty: add.orderedQty,
          warehouseName: offer.warehouseName,
        });
      } else {
        failedLines.push({
          productId: line.product_id,
          sku,
          reason: 'basket_rejected',
          message: add.message,
        });
      }
    } catch (e) {
      const message = e?.message || String(e);
      const ambiguous = isAmbiguousMikadoNetworkError(message);
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: ambiguous ? 'basket_timeout' : 'basket_error',
        ambiguous,
        message,
      });
    }
  }

  const submitted = submittedLines.length > 0 && failedLines.length === 0;
  const partial = submittedLines.length > 0 && failedLines.length > 0;
  const allAmbiguous =
    submittedLines.length === 0 &&
    failedLines.length > 0 &&
    failedLines.every((f) => f.ambiguous);

  logger.info('[MikadoOrder] submit result', {
    purchaseId: purchase?.id,
    submitted: submittedLines.length,
    failed: failedLines.length,
    ambiguous: allAmbiguous,
  });

  if (submitted) {
    return {
      submitted: true,
      mode: 'basket',
      message: `Заказ размещён в корзине Mikado (${submittedLines.length} поз.)`,
      supplierOrderIds: submittedLines.map((l) => l.basketItemId).filter(Boolean),
      lines: submittedLines,
    };
  }

  if (partial) {
    return {
      submitted: true,
      partial: true,
      mode: 'basket',
      reason: 'partial',
      message: `Частично в корзине Mikado: ${submittedLines.length} из ${lines.length}`,
      supplierOrderIds: submittedLines.map((l) => l.basketItemId).filter(Boolean),
      lines: submittedLines,
      failedLines,
    };
  }

  if (allAmbiguous) {
    return {
      submitted: false,
      reason: 'ambiguous_submit',
      ambiguousSuccess: true,
      mode: 'basket',
      message:
        'Таймаут Mikado после возможного Basket_Add — локальную позицию оставляем, чтобы не задублировать корзину',
      failedLines,
    };
  }

  return {
    submitted: false,
    reason: failedLines[0]?.reason || 'all_failed',
    message:
      failedLines[0]?.message ||
      'Не удалось отправить позиции в корзину Mikado',
    failedLines,
  };
}
