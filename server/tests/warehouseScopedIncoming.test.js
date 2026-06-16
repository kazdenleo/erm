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

  test('закупка +2 без склада, списание −2 на другом складе — нетто 0', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 0,
        nullRaw: 2,
        whOnHand: 7,
        totalOnHand: 9,
        globalIncoming: 0,
        globalJournalNet: 0,
        hasIncomingJournal: true
      })
    ).toBe(0);
  });

  test('закупка +2 без склада, списание −2 на складе — нетто 0 (не показываем 2 в пути)', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: -2,
        nullRaw: 2,
        whOnHand: 0,
        totalOnHand: 0,
        globalIncoming: 2,
        globalJournalNet: 0,
        hasIncomingJournal: true
      })
    ).toBe(0);
  });

  test('журнал движений есть, incoming нет — устаревший globalIncoming игнорируем', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 0,
        nullRaw: 0,
        whOnHand: 7,
        totalOnHand: 7,
        globalIncoming: 7,
        hasIncomingJournal: false,
        hasStockJournal: true
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
        globalJournalNet: 4,
        hasIncomingJournal: true
      })
    ).toBe(2);
  });

  test('на складе есть incoming в журнале — не добавляем legacy null (как история)', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 1,
        nullRaw: 2,
        whOnHand: 1,
        totalOnHand: 1,
        globalIncoming: 3,
        globalJournalNet: 1,
        hasIncomingJournal: true,
        hasWarehouseIncomingJournal: true
      })
    ).toBe(1);
  });

  test('закупка +1 на складе при отрицательном legacy null — не обнуляем в пути', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 1,
        nullRaw: -2,
        globalJournalNet: -1,
        whOnHand: 1,
        totalOnHand: 1,
        hasIncomingJournal: true,
        hasWarehouseIncomingJournal: true
      })
    ).toBe(1);
  });
});
