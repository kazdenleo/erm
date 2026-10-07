import { scannedQtyForAssemblyLine } from './assemblyKitScan.js';
import {
  stockCountsLabel,
  mergeComponentStock,
  onShelfLabel,
  stockOnShelf,
  scannedQtyByProductId,
  kitScannedUnitsFromComponents,
  nextRecommendationScanOverlay,
  applyPickedToStock,
} from './assemblyWarehouseStock.js';

describe('applyPickedToStock', () => {
  test('снятое с полки уходит в «собрано в заказах» у комплекта и комплектующих', () => {
    const stock = {
      onHand: 1,
      assembledInOrders: 0,
      onShelf: 1,
      components: [
        { productId: 574, onHand: 8, assembledInOrders: 0, onShelf: 8 },
        { productId: 575, onHand: 7, assembledInOrders: 0, onShelf: 7 },
      ],
    };
    const out = applyPickedToStock(stock, 431, { 574: 1, 575: 1 });
    expect(out.onShelf).toBe(1);
    expect(out.components.map((c) => c.onShelf)).toEqual([7, 6]);
    expect(out.components.map((c) => c.assembledInOrders)).toEqual([1, 1]);
    expect(applyPickedToStock(stock, 431, { 431: 1 }).onShelf).toBe(0);
  });
});

describe('stockCountsLabel', () => {
  test('наличие / в собранных заказах / на полке', () => {
    expect(stockCountsLabel({ onHand: 7, assembledInOrders: 1, onShelf: 6 })).toBe(
      'наличие 7 · в собранных заказах 1 · на полке 6'
    );
  });
});

describe('stockOnShelf', () => {
  test('берёт onShelf с сервера', () => {
    expect(stockOnShelf({ onHand: 7, assembledInOrders: 1, onShelf: 6 })).toBe(6);
  });

  test('без onShelf — наличие минус собранное, не ниже нуля', () => {
    expect(stockOnShelf({ onHand: 7, assembledInOrders: 2 })).toBe(5);
    expect(stockOnShelf({ onHand: 1, assembledInOrders: 3 })).toBe(0);
  });

  test('нет данных — 0', () => {
    expect(stockOnShelf(null)).toBe(0);
  });
});

describe('onShelfLabel', () => {
  test('до скана', () => {
    expect(onShelfLabel({ onShelf: 6, scanned: 0 })).toBe('на полке 6');
  });

  test('скан уменьшает, не ниже нуля', () => {
    expect(onShelfLabel({ onShelf: 6, scanned: 2 })).toBe('на полке 4');
    expect(onShelfLabel({ onShelf: 1, scanned: 3 })).toBe('на полке 0');
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

  test('pickedQuantities: комплект только по скану его SKU', () => {
    const fromParts = nextRecommendationScanOverlay({
      recommendation,
      currentOrderKey: 'ym|o:627',
      pickedQuantities: { 10: 2 },
    });
    expect(fromParts.byPid.get(10)).toBe(2);
    expect(fromParts.kitScanned).toBe(0);

    const whole = nextRecommendationScanOverlay({
      recommendation,
      currentOrderKey: 'ym|o:627',
      pickedQuantities: { 355: 1 },
    });
    expect(whole.kitScanned).toBe(1);
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
