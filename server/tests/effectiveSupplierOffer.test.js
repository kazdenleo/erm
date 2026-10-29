import { pickEffectiveSupplierOffer, pricesNearlyEqual } from '../src/utils/effectiveSupplierOffer.js';
import { marketplaceSupplierQtyFromBreakdown } from '../src/services/effectiveSupplierCost.service.js';

describe('pickEffectiveSupplierOffer', () => {
  test('берёт цену дешёвого со свободным остатком', () => {
    const offer = pickEffectiveSupplierOffer([
      { supplier_id: 1, price: 100, stock: 1 },
      { supplier_id: 2, price: 200, stock: 50 },
    ]);
    expect(offer.price).toBe(100);
    expect(offer.freeStockAtPrice).toBe(1);
    expect(offer.supplierIds).toEqual([1]);
  });

  test('когда дешёвый кончился — цена следующего', () => {
    const offer = pickEffectiveSupplierOffer([
      { supplier_id: 1, price: 100, stock: 0 },
      { supplier_id: 2, price: 200, stock: 50 },
    ]);
    expect(offer.price).toBe(200);
    expect(offer.freeStockAtPrice).toBe(50);
  });

  test('складывает свободный остаток при той же цене', () => {
    const offer = pickEffectiveSupplierOffer([
      { supplier_id: 1, price: 150, stock: 2 },
      { supplier_id: 2, price: 150.01, stock: 3 },
      { supplier_id: 3, price: 300, stock: 10 },
    ]);
    expect(offer.price).toBe(150);
    expect(offer.freeStockAtPrice).toBe(5);
  });

  test('без свободного — null', () => {
    expect(pickEffectiveSupplierOffer([{ price: 10, stock: 0 }])).toBeNull();
    expect(pickEffectiveSupplierOffer([])).toBeNull();
  });
});

describe('marketplaceSupplierQtyFromBreakdown', () => {
  test('на витрину не суммирует дорогой остаток к дешёвой цене', () => {
    expect(
      marketplaceSupplierQtyFromBreakdown([
        { supplier_id: 1, price: 100, stock: 1 },
        { supplier_id: 2, price: 250, stock: 99 },
      ])
    ).toBe(1);
  });
});

describe('pricesNearlyEqual', () => {
  test('допуск 2 коп', () => {
    expect(pricesNearlyEqual(100, 100.01)).toBe(true);
    expect(pricesNearlyEqual(100, 100.5)).toBe(false);
  });
});
