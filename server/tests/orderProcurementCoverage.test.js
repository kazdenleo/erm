/**
 * Unit-тесты расчёта покрытия заказа для автозакупки.
 */

import {
  computeProcurementDeficit,
  fulfillmentLineStatusFromQuantities,
} from '../src/utils/orderProcurementCoverage.js';

describe('computeProcurementDeficit', () => {
  test('10 need, 3 on hand + 2 in transit reserved → purchase 5', () => {
    const r = computeProcurementDeficit({
      quantityNeeded: 10,
      quantityReserved: 5,
      quantityPurchased: 0,
    });
    expect(r.need).toBe(10);
    expect(r.reserved).toBe(5);
    expect(r.deficit).toBe(5);
    expect(r.covered).toBe(5);
  });

  test('fully covered by reserve — no purchase', () => {
    const r = computeProcurementDeficit({
      quantityNeeded: 10,
      quantityReserved: 10,
      quantityPurchased: 0,
    });
    expect(r.deficit).toBe(0);
  });

  test('partial reserve + prior purchase — idempotent re-click', () => {
    const r = computeProcurementDeficit({
      quantityNeeded: 10,
      quantityReserved: 5,
      quantityPurchased: 5,
    });
    expect(r.deficit).toBe(0);
    expect(r.covered).toBe(10);
  });

  test('only prior purchase covers need', () => {
    const r = computeProcurementDeficit({
      quantityNeeded: 10,
      quantityReserved: 0,
      quantityPurchased: 10,
    });
    expect(r.deficit).toBe(0);
    expect(r.purchased).toBe(10);
  });

  test('negative and float inputs are sanitized', () => {
    const r = computeProcurementDeficit({
      quantityNeeded: 10.9,
      quantityReserved: -1,
      quantityPurchased: 2.4,
    });
    expect(r.need).toBe(10);
    expect(r.reserved).toBe(0);
    expect(r.purchased).toBe(2);
    expect(r.deficit).toBe(8);
  });
});

describe('fulfillmentLineStatusFromQuantities', () => {
  test('manual flag wins', () => {
    expect(
      fulfillmentLineStatusFromQuantities({
        need: 10,
        reserved: 0,
        purchased: 0,
        deficit: 10,
        manual: true,
      })
    ).toBe('manual_required');
  });

  test('reserved only', () => {
    expect(
      fulfillmentLineStatusFromQuantities({
        need: 10,
        reserved: 10,
        purchased: 0,
        deficit: 0,
        manual: false,
      })
    ).toBe('reserved');
  });

  test('mixed reserve and purchase', () => {
    expect(
      fulfillmentLineStatusFromQuantities({
        need: 10,
        reserved: 5,
        purchased: 5,
        deficit: 0,
        manual: false,
      })
    ).toBe('partial');
  });
});
