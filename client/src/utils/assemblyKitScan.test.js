import {
  applyAssemblyBarcodeScan,
  applyAssemblyPickScan,
  assemblyPickedItemsList,
} from './assemblyKitScan.js';

const kitComponents = [
  { productId: 10, quantity: 1, kitProductId: 431, isKitComponent: true },
  { productId: 11, quantity: 1, kitProductId: 431, isKitComponent: true },
];

describe('applyAssemblyPickScan', () => {
  test('скан комплектующих — по штуке каждой, комплект не трогаем', () => {
    let picked = {};
    let scanned = {};
    for (const pid of [10, 11]) {
      const product = { id: pid };
      picked = applyAssemblyPickScan(picked, product, kitComponents, scanned);
      scanned = applyAssemblyBarcodeScan(scanned, product, kitComponents);
    }
    expect(picked).toEqual({ 10: 1, 11: 1 });
  });

  test('скан SKU комплекта при строках-комплектующих — целый комплект', () => {
    const picked = applyAssemblyPickScan({}, { id: 431 }, kitComponents, {}, { kitUnits: 1 });
    expect(picked).toEqual({ 431: 1 });
  });

  test('скан SKU комплекта: kitUnits из количества в заказе', () => {
    const picked = applyAssemblyPickScan({}, { id: 431 }, kitComponents, {}, { kitUnits: 2 });
    expect(picked).toEqual({ 431: 2 });
  });

  test('строка целого комплекта — остаток по строке', () => {
    const items = [{ productId: 431, quantity: 2, isKitWhole: true }];
    const picked = applyAssemblyPickScan({}, { id: 431 }, items, {});
    expect(picked).toEqual({ 431: 2 });
  });

  test('чужой товар не считаем', () => {
    expect(applyAssemblyPickScan({}, { id: 99 }, kitComponents, {})).toEqual({});
  });

  test('заказ без состава — штука товара', () => {
    expect(applyAssemblyPickScan({ 5: 1 }, { id: 5 }, [], {})).toEqual({ 5: 2 });
  });
});

describe('assemblyPickedItemsList', () => {
  test('в список для API без нулей', () => {
    expect(assemblyPickedItemsList({ 10: 1, 11: 0, x: 3 })).toEqual([
      { productId: 10, quantity: 1 },
    ]);
  });
});
