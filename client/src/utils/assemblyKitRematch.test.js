import {
  applyAssemblyBarcodeScan,
  findAssemblyGroupMatchingProductIds,
  isAssemblyCompositionComplete,
  scannedProductIdsFromQuantities,
  scannedProductStillNeededOnOrder,
  seedScannedQuantitiesForProductIds,
} from './assemblyKitScan.js';

function group(key, orderId, componentIds) {
  const primary = {
    orderId,
    marketplace: 'wildberries',
    productId: 9000 + componentIds[0],
    assemblyCompositionLines: componentIds.map((productId) => ({
      productId,
      quantity: 1,
      article: String(productId),
    })),
  };
  return { key, rows: [primary], primary };
}

describe('assembly kit rematch A+B → A+C', () => {
  const A = 20124;
  const B = 20122;
  const C = 20119;
  const kitAb = [
    { productId: A, quantity: 1, kitProductId: 1, isKitComponent: true },
    { productId: B, quantity: 1, kitProductId: 1, isKitComponent: true },
  ];
  const kitAc = [
    { productId: A, quantity: 1, kitProductId: 2, isKitComponent: true },
    { productId: C, quantity: 1, kitProductId: 2, isKitComponent: true },
  ];

  test('после A скан C не нужен на A+B, но находится группа A+C', () => {
    let qty = applyAssemblyBarcodeScan({}, { id: A }, kitAb);
    expect(scannedProductStillNeededOnOrder({ id: C }, kitAb, qty)).toBe(false);
    const scanned = scannedProductIdsFromQuantities(kitAb, qty);
    scanned.add(C);
    const groups = [group('ab', 'AB', [A, B]), group('ac', 'AC', [A, C])];
    const match = findAssemblyGroupMatchingProductIds(groups, scanned, { excludeKey: 'ab' });
    expect(match?.key).toBe('ac');
  });

  test('перенос прогресса A на A+C и скан C закрывает комплект', () => {
    const seeded = seedScannedQuantitiesForProductIds(kitAc, [A]);
    const afterC = applyAssemblyBarcodeScan(seeded, { id: C }, kitAc);
    expect(isAssemblyCompositionComplete(kitAc, afterC)).toBe(true);
  });

  test('точное совпадение предпочтительнее большего комплекта', () => {
    const groups = [
      group('abc', 'ABC', [A, B, C]),
      group('ac', 'AC', [A, C]),
    ];
    const match = findAssemblyGroupMatchingProductIds(groups, [A, C]);
    expect(match?.key).toBe('ac');
  });
});
