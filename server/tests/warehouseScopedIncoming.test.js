import { describe, test, expect } from '@jest/globals';
import { allocateWarehouseScopedIncoming } from '../src/constants/netReservedStockSql.js';

describe('allocateWarehouseScopedIncoming', () => {
  test('без журнала incoming — доля globalIncoming по наличию на складе', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strict: 0,
        nullIncoming: 0,
        whOnHand: 10,
        totalOnHand: 10,
        globalIncoming: 4,
        hasIncomingJournal: false
      })
    ).toBe(4);
  });

  test('журнал incoming есть, на складе нетто 0 — не подставляем globalIncoming', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strict: 0,
        nullIncoming: 0,
        whOnHand: 10,
        totalOnHand: 10,
        globalIncoming: 4,
        hasIncomingJournal: true
      })
    ).toBe(0);
  });

  test('журнал incoming на складе — strict без fallback', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strict: 3,
        nullIncoming: 0,
        whOnHand: 10,
        totalOnHand: 10,
        globalIncoming: 4,
        hasIncomingJournal: true
      })
    ).toBe(3);
  });
});
