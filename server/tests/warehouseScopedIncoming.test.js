import { describe, test, expect } from '@jest/globals';
import {
  allocateWarehouseScopedIncoming,
  clampStockMetric,
  reconcileWarehouseIncomingWithPurchasePending,
} from '../src/constants/netReservedStockSql.js';

describe('clampStockMetric', () => {
  test('отрицательные и дробные — 0', () => {
    expect(clampStockMetric(-5)).toBe(0);
    expect(clampStockMetric(-0.2)).toBe(0);
    expect(clampStockMetric(3.9)).toBe(3);
  });
});

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

  test('отрицательный SUM incoming на складе — берём снимок incoming_after', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: -2,
        nullRaw: 3,
        globalJournalNet: 1,
        whOnHand: 1,
        totalOnHand: 1,
        globalIncoming: 1,
        hasIncomingJournal: true,
        hasWarehouseIncomingJournal: true,
        warehouseIncomingSnapshot: 1
      })
    ).toBe(1);
  });

  test('устаревший snapshot выше глобального журнала — не раздуваем «в пути» на складе', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: -4,
        nullRaw: 2,
        globalJournalNet: 0,
        whOnHand: 0,
        totalOnHand: 35,
        globalIncoming: 0,
        hasIncomingJournal: true,
        hasWarehouseIncomingJournal: true,
        warehouseIncomingSnapshot: 14
      })
    ).toBe(0);
  });

  test('нулевой SUM incoming на складе при актуальном incoming_after — берём снимок', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: 0,
        nullRaw: 1,
        globalJournalNet: 1,
        whOnHand: 0,
        totalOnHand: 0,
        globalIncoming: 1,
        hasIncomingJournal: true,
        hasWarehouseIncomingJournal: true,
        warehouseIncomingSnapshot: 1
      })
    ).toBe(1);
  });

  test('результат никогда не отрицательный', () => {
    expect(
      allocateWarehouseScopedIncoming({
        strictRaw: -99,
        nullRaw: -50,
        globalJournalNet: -149,
        whOnHand: 0,
        totalOnHand: 0,
        globalIncoming: 0,
        hasIncomingJournal: true,
        hasWarehouseIncomingJournal: true
      })
    ).toBe(0);
  });
});

describe('reconcileWarehouseIncomingWithPurchasePending', () => {
  test('журнал 1, закупка ожидает 10 — показываем 10', () => {
    expect(
      reconcileWarehouseIncomingWithPurchasePending({
        journalIncoming: 1,
        purchaseDocNet: 1,
        purchasePending: 10,
      })
    ).toBe(10);
  });

  test('журнал и закупка согласованы — без изменений', () => {
    expect(
      reconcileWarehouseIncomingWithPurchasePending({
        journalIncoming: 10,
        purchaseDocNet: 10,
        purchasePending: 10,
      })
    ).toBe(10);
  });

  test('прочий incoming без закупок сохраняется', () => {
    expect(
      reconcileWarehouseIncomingWithPurchasePending({
        journalIncoming: 5,
        purchaseDocNet: 0,
        purchasePending: 0,
      })
    ).toBe(5);
  });

  test('нет журнала, есть ожидание закупки', () => {
    expect(
      reconcileWarehouseIncomingWithPurchasePending({
        journalIncoming: 0,
        purchaseDocNet: 0,
        purchasePending: 10,
      })
    ).toBe(10);
  });

  test('docNet только открытой закупки = journal — без двойного счёта pending', () => {
    // Баг CN1139K-2: docNet по всей истории был 0 (закрытые +1/−1), pending=1, journal=1 → 2.
    // С корректным docNet открытой закупки: other=0 + pending=1 → 1.
    expect(
      reconcileWarehouseIncomingWithPurchasePending({
        journalIncoming: 1,
        purchaseDocNet: 1,
        purchasePending: 1,
      })
    ).toBe(1);
  });

  test('ошибочный docNet=0 при journal=pending раздувает incoming (контракт вызова SQL)', () => {
    expect(
      reconcileWarehouseIncomingWithPurchasePending({
        journalIncoming: 1,
        purchaseDocNet: 0,
        purchasePending: 1,
      })
    ).toBe(2);
  });
});
