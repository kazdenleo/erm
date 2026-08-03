/**
 * Unit-тесты подготовки позиций к отправке поставщику.
 */

import {
  mergeProcurementItemsByProductId,
  shouldSkipSupplierSubmit,
  shouldMarkPurchaseSupplierSubmitted,
  filterPendingSupplierSubmitLines,
} from '../src/services/supplierOrderPlacement.service.js';

describe('shouldSkipSupplierSubmit', () => {
  test('пропускает повтор без force', () => {
    expect(shouldSkipSupplierSubmit({ supplier_submitted_at: '2026-01-01' })).toBe(true);
    expect(shouldSkipSupplierSubmit({ supplierSubmittedAt: '2026-01-01' })).toBe(true);
    expect(shouldSkipSupplierSubmit({ supplier_submitted_at: null })).toBe(false);
    expect(shouldSkipSupplierSubmit({})).toBe(false);
  });

  test('force разрешает повтор', () => {
    expect(shouldSkipSupplierSubmit({ supplier_submitted_at: '2026-01-01' }, { force: true })).toBe(
      false
    );
  });
});

describe('shouldMarkPurchaseSupplierSubmitted', () => {
  test('полный и частичный успех помечают закупку отправленной', () => {
    expect(shouldMarkPurchaseSupplierSubmitted({ submitted: true })).toBe(true);
    expect(shouldMarkPurchaseSupplierSubmitted({ submitted: false, lines: [{ sku: 'x' }] })).toBe(
      true
    );
    expect(
      shouldMarkPurchaseSupplierSubmitted({ submitted: false, supplierOrderIds: [101] })
    ).toBe(true);
    expect(shouldMarkPurchaseSupplierSubmitted({ submitted: false })).toBe(false);
    expect(shouldMarkPurchaseSupplierSubmitted(null)).toBe(false);
  });
});

describe('filterPendingSupplierSubmitLines', () => {
  test('без отправки — все строки', () => {
    const lines = [{ product_id: 1, created_at: '2026-06-30T10:00:00Z' }];
    expect(filterPendingSupplierSubmitLines({}, lines)).toHaveLength(1);
  });

  test('после отправки — только строки, добавленные позже', () => {
    const purchase = { supplier_submitted_at: '2026-06-30T15:25:44.789Z' };
    const lines = [
      { product_id: 1, created_at: '2026-06-30T15:25:43.643Z' },
      { product_id: 2, created_at: '2026-06-30T15:57:54.100Z' },
    ];
    const pending = filterPendingSupplierSubmitLines(purchase, lines);
    expect(pending).toHaveLength(1);
    expect(pending[0].product_id).toBe(2);
  });

  test('после отправки — доотправка новых source_orders в старой строке', () => {
    const purchase = { supplier_submitted_at: '2026-07-22T18:42:09.194Z' };
    const lines = [
      {
        product_id: 57,
        created_at: '2026-07-22T18:42:06.913Z',
        expected_quantity: 2,
        source_orders: [
          {
            orderId: '59436699330',
            marketplace: 'ym',
            supplierSubmittedAt: '2026-07-22T18:42:09.463Z',
          },
          { orderId: '47539748-0323-2', marketplace: 'ozon' },
        ],
      },
    ];
    const pending = filterPendingSupplierSubmitLines(purchase, lines);
    expect(pending).toHaveLength(1);
    expect(pending[0].product_id).toBe(57);
    expect(pending[0].expected_quantity).toBe(1);
  });

  test('доотправка: заказ на 2 шт. одной записью source_orders — шлём остаток 2, не 1', () => {
    const purchase = { supplier_submitted_at: '2026-08-01T10:00:00.000Z' };
    const lines = [
      {
        product_id: 10,
        created_at: '2026-08-01T09:00:00.000Z',
        expected_quantity: 3,
        source_orders: [
          {
            orderId: 'order-qty1',
            marketplace: 'ozon',
            quantity: 1,
            supplierSubmittedAt: '2026-08-01T10:00:00.000Z',
          },
          { orderId: 'order-qty2', marketplace: 'ozon', quantity: 2 },
        ],
      },
    ];
    const pending = filterPendingSupplierSubmitLines(purchase, lines);
    expect(pending).toHaveLength(1);
    expect(pending[0].expected_quantity).toBe(2);
  });

  test('доотправка legacy без quantity: остаток expected − отправленные записи', () => {
    const purchase = { supplier_submitted_at: '2026-08-01T10:00:00.000Z' };
    const lines = [
      {
        product_id: 11,
        created_at: '2026-08-01T09:00:00.000Z',
        expected_quantity: 3,
        source_orders: [
          {
            orderId: 'a',
            marketplace: 'ozon',
            supplierSubmittedAt: '2026-08-01T10:00:00.000Z',
          },
          { orderId: 'b', marketplace: 'ozon' },
        ],
      },
    ];
    const pending = filterPendingSupplierSubmitLines(purchase, lines);
    expect(pending[0].expected_quantity).toBe(2);
  });
});

describe('mergeProcurementItemsByProductId', () => {
  test('схлопывает одинаковые productId в одну строку', () => {
    const merged = mergeProcurementItemsByProductId([
      { productId: 10, quantity: 2 },
      { productId: 10, quantity: 1 },
      { productId: 20, quantity: 1 },
    ]);
    expect(merged).toHaveLength(2);
    const p10 = merged.find((x) => x.productId === 10);
    expect(p10.quantity).toBe(3);
  });

  test('игнорирует строки без productId', () => {
    const merged = mergeProcurementItemsByProductId([
      { productId: null, quantity: 5 },
      { productId: 3, quantity: 1 },
    ]);
    expect(merged).toEqual([{ productId: 3, quantity: 1 }]);
  });
});
