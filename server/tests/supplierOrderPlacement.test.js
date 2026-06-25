/**
 * Unit-тесты подготовки позиций к отправке поставщику.
 */

import { mergeProcurementItemsByProductId } from '../src/services/supplierOrderPlacement.service.js';

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
