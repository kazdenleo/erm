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
  return {
    ok: basketId > 0,
    basketItemId: basketId || null,
    orderedQty,
    message: message || (basketId > 0 ? 'Добавлено в корзину Mikado' : 'Mikado не принял позицию'),
    raw: xml.slice(0, 500),
  };
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
      failedLines.push({
        productId: line.product_id,
        sku,
        reason: 'basket_error',
        message: e?.message || String(e),
      });
    }
  }

  const submitted = submittedLines.length > 0 && failedLines.length === 0;
  const partial = submittedLines.length > 0 && failedLines.length > 0;

  logger.info('[MikadoOrder] submit result', {
    purchaseId: purchase?.id,
    submitted: submittedLines.length,
    failed: failedLines.length,
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

  return {
    submitted: false,
    reason: failedLines[0]?.reason || 'all_failed',
    message:
      failedLines[0]?.message ||
      'Не удалось отправить позиции в корзину Mikado',
    failedLines,
  };
}
