/**
 * Unit-тесты подготовки позиций к отправке поставщику.
 */

import {
  mergeProcurementItemsByProductId,
  shouldSkipSupplierSubmit,
  shouldMarkPurchaseSupplierSubmitted,
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
