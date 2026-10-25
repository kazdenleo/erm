import { freeSupplierUnits, sourceOrdersFittingFreeStock } from '../src/utils/supplierStockReservation.js';

describe('freeSupplierUnits', () => {
  test('вычитает открытый резерв и не уходит ниже нуля', () => {
    expect(freeSupplierUnits(5, 2)).toBe(3);
    expect(freeSupplierUnits(2, 5)).toBe(0);
    expect(freeSupplierUnits(4, 0)).toBe(4);
  });
});

describe('sourceOrdersFittingFreeStock', () => {
  test('два заказа по 5 при остатке 5 — берём только первый', () => {
    const fitted = sourceOrdersFittingFreeStock(
      [
        { marketplace: 'ozon', orderId: 'a', quantity: 5 },
        { marketplace: 'ozon', orderId: 'b', quantity: 5 },
      ],
      5,
      10
    );
    expect(fitted.quantity).toBe(5);
    expect(fitted.sourceOrders.map((o) => o.orderId)).toEqual(['a']);
  });

  test('заказ целиком не влезает — не привязываем его частично', () => {
    const fitted = sourceOrdersFittingFreeStock(
      [{ marketplace: 'wb', orderId: 'a', quantity: 5 }],
      2,
      5
    );
    expect(fitted.quantity).toBe(0);
    expect(fitted.sourceOrders).toEqual([]);
  });

  test('без количества на заказах — всё или ничего', () => {
    expect(
      sourceOrdersFittingFreeStock([{ marketplace: 'ozon', orderId: 'a' }], 3, 2).quantity
    ).toBe(2);
    expect(
      sourceOrdersFittingFreeStock([{ marketplace: 'ozon', orderId: 'a' }], 1, 2).quantity
    ).toBe(0);
  });
});
