import {
  stockCountsLabel,
  formatAssemblyWarehouseStock,
  mergeComponentStock,
} from './assemblyWarehouseStock.js';

describe('stockCountsLabel', () => {
  test('наличие / резерв / доступно', () => {
    expect(stockCountsLabel({ onHand: 4, reserved: 2, available: 2 })).toBe(
      'наличие 4 · резерв 2 · доступно 2'
    );
  });
});

describe('formatAssemblyWarehouseStock', () => {
  test('обычный товар', () => {
    expect(
      formatAssemblyWarehouseStock(
        { isKit: false, onHand: 4, reserved: 2, available: 2 },
        { warehouseName: 'FBS' }
      )
    ).toBe('На складе FBS: наличие 4 · резерв 2 · доступно 2');
  });

  test('комплект: целые + из комплектующих', () => {
    expect(
      formatAssemblyWarehouseStock(
        {
          isKit: true,
          wholeOnHand: 0,
          assemblableFromComponents: 1,
          availableTotal: 1,
        },
        { warehouseName: 'FBS', isKit: true }
      )
    ).toBe('На складе FBS: 0 цел. + 1 из комплектующих (доступно 1)');
  });
});

describe('mergeComponentStock', () => {
  test('матчит комплектующую по артикулу', () => {
    const merged = mergeComponentStock(
      [{ article: 'TG-5252', quantity: 2 }],
      [{ sku: 'TG-5252', onHand: 4, reserved: 2, available: 2, perKit: 2 }]
    );
    expect(merged[0].stock.available).toBe(2);
  });
});
