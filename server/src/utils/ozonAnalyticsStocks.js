/**
 * Поля статусов остатков POST /v1/analytics/stocks (realtime).
 * @see https://docs.ozon.ru/api/seller/#operation/AnalyticsAPI_AnalyticsStocks
 */

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function pickCount(row, ...keys) {
  if (!row || typeof row !== 'object') return 0;
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return toInt(row[k]);
  }
  return 0;
}

/**
 * Разбор строки analytics/stocks в корзины ERM.
 * mp_warehouse — только доступный к продаже (для FBO availability / оборачиваемости).
 */
export function mapOzonAnalyticsStockCounts(row) {
  const available = pickCount(row, 'available_stock_count', 'availableStockCount');
  const transit = pickCount(row, 'transit_stock_count', 'transitStockCount');
  const requested = pickCount(row, 'requested_stock_count', 'requestedStockCount');
  const valid = pickCount(row, 'valid_stock_count', 'validStockCount');
  const waitingDocs = pickCount(row, 'waiting_docs_stock_count', 'waitingDocsStockCount');
  const other = pickCount(row, 'other_stock_count', 'otherStockCount');
  const fromCustomer = pickCount(
    row,
    'return_from_customer_stock_count',
    'returnFromCustomerStockCount'
  );
  const toSeller = pickCount(row, 'return_to_seller_stock_count', 'returnToSellerStockCount');
  const stockDefect = pickCount(row, 'stock_defect_stock_count', 'stockDefectStockCount');
  const transitDefect = pickCount(row, 'transit_defect_stock_count', 'transitDefectStockCount');
  const excess = pickCount(row, 'excess_stock_count', 'excessStockCount');
  const expiring = pickCount(row, 'expiring_stock_count', 'expiringStockCount');

  return {
    mp_warehouse: available,
    inbound: transit + requested + valid,
    returning: fromCustomer + toSeller,
    blocked: waitingDocs + other + stockDefect + transitDefect + excess + expiring,
    detail: {
      available,
      transit,
      requested,
      valid,
      waitingDocs,
      other,
      fromCustomer,
      toSeller,
      stockDefect,
      transitDefect,
      excess,
      expiring,
    },
  };
}

/**
 * Добавить lines снапшота по строке analytics/stocks.
 * @returns {number} сколько lines добавлено
 */
export function appendOzonAnalyticsStockLines(row, lines, { externalSku, warehouseName } = {}) {
  const sku = String(externalSku ?? row?.offer_id ?? row?.offerId ?? '').trim();
  if (!sku || !Array.isArray(lines)) return 0;
  const wh =
    warehouseName != null && String(warehouseName).trim() !== ''
      ? String(warehouseName).trim()
      : null;
  const buckets = mapOzonAnalyticsStockCounts(row);
  let n = 0;
  for (const state of ['mp_warehouse', 'inbound', 'returning', 'blocked']) {
    const qty = buckets[state];
    if (qty > 0) {
      lines.push({ state, externalSku: sku, warehouseName: wh, quantity: qty });
      n += 1;
    }
  }
  return n;
}
