import {
  aggregateKitComponents,
  kitBomNeedsMultipleAssemblyScans,
  buildKitComponentQtyMap,
} from '../src/services/kitStock.service.js';

describe('kit BOM helpers', () => {
  test('aggregateKitComponents merges duplicate rows and sums quantity', () => {
    const rows = [
      { component_product_id: 10, quantity: 2 },
      { component_product_id: 10, quantity: 1 },
      { component_product_id: 20, quantity: 1 },
    ];
    expect(aggregateKitComponents(rows)).toEqual([
      { component_product_id: 10, quantity: 3 },
      { component_product_id: 20, quantity: 1 },
    ]);
  });

  test('kitBomNeedsMultipleAssemblyScans: two different components', () => {
    expect(
      kitBomNeedsMultipleAssemblyScans([
        { component_product_id: 1, quantity: 1 },
        { component_product_id: 2, quantity: 1 },
      ])
    ).toBe(true);
  });

  test('kitBomNeedsMultipleAssemblyScans: one component qty 2', () => {
    expect(kitBomNeedsMultipleAssemblyScans([{ component_product_id: 1, quantity: 2 }])).toBe(true);
  });

  test('kitBomNeedsMultipleAssemblyScans: single component qty 1', () => {
    expect(kitBomNeedsMultipleAssemblyScans([{ component_product_id: 1, quantity: 1 }])).toBe(false);
  });

  test('buildKitComponentQtyMap uses aggregated BOM', () => {
    const map = buildKitComponentQtyMap(
      [
        { component_product_id: 5, quantity: 2 },
        { component_product_id: 5, quantity: 1 },
        { component_product_id: 7, quantity: 1 },
      ],
      2
    );
    expect(map.get(5)).toBe(6);
    expect(map.get(7)).toBe(2);
  });
});
