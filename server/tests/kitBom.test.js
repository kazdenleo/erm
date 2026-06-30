import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateKitComponents,
  kitBomNeedsMultipleAssemblyScans,
  buildKitComponentQtyMap,
} from '../src/services/kitStock.service.js';

test('aggregateKitComponents merges duplicate rows and sums quantity', () => {
  const rows = [
    { component_product_id: 10, quantity: 2 },
    { component_product_id: 10, quantity: 1 },
    { component_product_id: 20, quantity: 1 },
  ];
  const agg = aggregateKitComponents(rows);
  assert.deepEqual(agg, [
    { component_product_id: 10, quantity: 3 },
    { component_product_id: 20, quantity: 1 },
  ]);
});

test('kitBomNeedsMultipleAssemblyScans: two different components', () => {
  assert.equal(
    kitBomNeedsMultipleAssemblyScans([
      { component_product_id: 1, quantity: 1 },
      { component_product_id: 2, quantity: 1 },
    ]),
    true
  );
});

test('kitBomNeedsMultipleAssemblyScans: one component qty 2', () => {
  assert.equal(
    kitBomNeedsMultipleAssemblyScans([{ component_product_id: 1, quantity: 2 }]),
    true
  );
});

test('kitBomNeedsMultipleAssemblyScans: single component qty 1', () => {
  assert.equal(
    kitBomNeedsMultipleAssemblyScans([{ component_product_id: 1, quantity: 1 }]),
    false
  );
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
  assert.equal(map.get(5), 6);
  assert.equal(map.get(7), 2);
});
