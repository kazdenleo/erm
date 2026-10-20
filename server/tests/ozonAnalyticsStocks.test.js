import {
  appendOzonAnalyticsStockLines,
  mapOzonAnalyticsStockCounts,
} from '../src/utils/ozonAnalyticsStocks.js';

describe('ozonAnalyticsStocks', () => {
  test('maps realtime status counts into ERM buckets', () => {
    const buckets = mapOzonAnalyticsStockCounts({
      available_stock_count: 10,
      transit_stock_count: 2,
      requested_stock_count: 3,
      valid_stock_count: 1,
      return_from_customer_stock_count: 4,
      return_to_seller_stock_count: 1,
      waiting_docs_stock_count: 1,
      other_stock_count: 2,
      stock_defect_stock_count: 1,
      transit_defect_stock_count: 1,
      excess_stock_count: 2,
      expiring_stock_count: 3,
    });
    expect(buckets.mp_warehouse).toBe(10);
    expect(buckets.inbound).toBe(6);
    expect(buckets.returning).toBe(5);
    expect(buckets.blocked).toBe(10);
  });

  test('appendOzonAnalyticsStockLines skips empty buckets', () => {
    const lines = [];
    const n = appendOzonAnalyticsStockLines(
      {
        offer_id: 'SKU-1',
        available_stock_count: 5,
        transit_stock_count: 0,
        return_from_customer_stock_count: 2,
        excess_stock_count: 1,
      },
      lines,
      { warehouseName: 'WH' }
    );
    expect(n).toBe(3);
    expect(lines).toEqual([
      { state: 'mp_warehouse', externalSku: 'SKU-1', warehouseName: 'WH', quantity: 5 },
      { state: 'returning', externalSku: 'SKU-1', warehouseName: 'WH', quantity: 2 },
      { state: 'blocked', externalSku: 'SKU-1', warehouseName: 'WH', quantity: 1 },
    ]);
  });
});
