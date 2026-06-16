import { describe, test, expect } from '@jest/globals';
import { allocateWarehouseScopedIncoming } from '../src/constants/netReservedStockSql.js';

describe('allocateWarehouseScopedIncoming', () => {
  test('без журнала incoming — доля globalIncoming по наличию на складе', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 0,
        nullRaw: 0,
        whOnHand: 10,
        totalOnHand: 10,
        globalIncoming: 4,
        hasIncomingJournal: false
      })
    ).toBe(4);
  });

  test('журнал incoming есть, глобальное нетто 0 — не подставляем globalIncoming', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 0,
        nullRaw: 0,
        whOnHand: 10,
        totalOnHand: 10,
        globalIncoming: 4,
        hasIncomingJournal: true
      })
    ).toBe(0);
  });

  test('журнал incoming на складе — strictRaw без fallback', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 3,
        nullRaw: 0,
        whOnHand: 10,
        totalOnHand: 10,
        globalIncoming: 4,
        hasIncomingJournal: true
      })
    ).toBe(3);
  });

  test('закупка +2 без склада, списание −2 на складе — нетто 0 (не показываем 2 в пути)', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: -2,
        nullRaw: 2,
        whOnHand: 0,
        totalOnHand: 0,
        globalIncoming: 2,
        hasIncomingJournal: true
      })
    ).toBe(0);
  });

  test('ожидание только в legacy-корзине — доля по наличию на складе', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 0,
        nullRaw: 4,
        whOnHand: 5,
        totalOnHand: 10,
        globalIncoming: 0,
        hasIncomingJournal: true
      })
    ).toBe(2);
  });
});
