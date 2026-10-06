import { scannedQtyForAssemblyLine } from './assemblyKitScan.js';
import {
  stockCountsLabel,
  formatAssemblyWarehouseStock,
  mergeComponentStock,
  orderReserveAvailableLabel,
  orderHintAvailable,
  scannedQtyByProductId,
  kitScannedUnitsFromComponents,
  nextRecommendationScanOverlay,
} from './assemblyWarehouseStock.js';

describe('stockCountsLabel', () => {
  test('наличие / резерв / доступно', () => {
    expect(stockCountsLabel({ onHand: 4, reserved: 2, available: 2 })).toBe(
      'наличие 4 · резерв 2 · доступно 2'
    );
  });
});

describe('orderReserveAvailableLabel', () => {
  test('до скана: резерв заказа и доступно склада', () => {
    expect(
      orderReserveAvailableLabel({ reservedForOrder: 2, available: 2, scanned: 0 })
    ).toBe('резерв 2 · доступно 2');
  });

  test('после скана доступно уменьшается', () => {
    expect(
      orderReserveAvailableLabel({ reservedForOrder: 2, available: 2, scanned: 2 })
    ).toBe('резерв 2 · доступно 0');
  });

  test('скан без резерва в журнале поднимает резерв', () => {
    expect(
      orderReserveAvailableLabel({ reservedForOrder: 0, available: 4, scanned: 2 })
    ).toBe('резерв 2 · доступно 2');
  });
});

describe('orderHintAvailable', () => {
  test('у комплекта берёт availableTotal', () => {
    expect(
      orderHintAvailable(
        { isKit: true, available: 0, availableTotal: 1 },
        { isKit: true }
      )
    ).toBe(1);
  });

  test('у обычного товара — available', () => {
    expect(orderHintAvailable({ available: 4, availableTotal: 9 })).toBe(4);
  });
});

describe('scannedQtyByProductId', () => {
  test('суммирует сканы по productId', () => {
    const items = [
      { productId: 10, quantity: 2 },
      { productId: 11, quantity: 2 },
    ];
    const scanned = { 'asm:pid:10:0': 2, 'asm:pid:11:0': 1 };
    const map = scannedQtyByProductId(items, scanned, scannedQtyForAssemblyLine);
    expect(map.get(10)).toBe(2);
    expect(map.get(11)).toBe(1);
  });
});

describe('kitScannedUnitsFromComponents', () => {
  test('min floor по составу', () => {
    const components = [
      { productId: 10, quantity: 2 },
      { productId: 11, quantity: 1 },
    ];
    const byPid = new Map([
      [10, 4],
      [11, 1],
    ]);
    expect(kitScannedUnitsFromComponents(components, byPid)).toBe(1);
  });
});

describe('nextRecommendationScanOverlay', () => {
  const recommendation = {
    groupKey: 'ym|o:627',
    productId: 355,
    isKit: true,
    components: [{ productId: 10, quantity: 2 }],
  };

  test('без текущей сессии — нули', () => {
    const overlay = nextRecommendationScanOverlay({
      recommendation,
      currentOrderKey: '',
      orderItems: [{ productId: 10, quantity: 2 }],
      scannedQuantities: { 'asm:pid:10:0': 2 },
      scannedQtyForLine: scannedQtyForAssemblyLine,
    });
    expect(overlay.kitScanned).toBe(0);
    expect(overlay.byPid.size).toBe(0);
  });

  test('скан комплектующих текущей сессии даёт комплекты', () => {
    const overlay = nextRecommendationScanOverlay({
      recommendation,
      currentOrderKey: 'ym|o:627',
      orderItems: [{ productId: 10, quantity: 2 }],
      scannedQuantities: { 'asm:pid:10:0': 2 },
      scannedQtyForLine: scannedQtyForAssemblyLine,
    });
    expect(overlay.byPid.get(10)).toBe(2);
    expect(overlay.kitScanned).toBe(1);
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
  test('матчит комплектующую по артикулу и сохраняет резерв заказа', () => {
    const merged = mergeComponentStock(
      [{ article: 'TG-5252', quantity: 2, productId: 10 }],
      [
        {
          sku: 'TG-5252',
          productId: 10,
          onHand: 4,
          reserved: 2,
          available: 2,
          reservedForOrder: 2,
          perKit: 2,
        },
      ]
    );
    expect(merged[0].stock.available).toBe(2);
    expect(merged[0].stock.reservedForOrder).toBe(2);
  });
});
