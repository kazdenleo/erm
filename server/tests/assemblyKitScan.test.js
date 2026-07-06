import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isKitSkuScanForOrder,
  assemblyLinesToCompleteOnKitScan,
  isRootKitSkuScanForOrder,
  assemblyLinesToCompleteOnRootKitScan,
  orderItemMatchesScannedProduct,
} from '../../client/src/utils/assemblyKitScan.js';

const kitId = 5000;
const compA = 2405;
const compB = 2406;

const componentLines = [
  {
    productId: compA,
    quantity: 1,
    kitProductId: kitId,
    isKitComponent: true,
  },
  {
    productId: compB,
    quantity: 1,
    kitProductId: kitId,
    isKitComponent: true,
  },
];

test('scan of kit component is not treated as root kit scan', () => {
  assert.equal(isKitSkuScanForOrder({ id: compA }, componentLines), false);
  const keys = assemblyLinesToCompleteOnKitScan({ id: compA }, componentLines);
  assert.equal(keys.size, 0);
});

test('scan of whole kit line completes only that line', () => {
  const wholeLine = [
    {
      productId: kitId,
      quantity: 1,
      kitProductId: kitId,
      isKitWhole: true,
    },
  ];
  assert.equal(isKitSkuScanForOrder({ id: kitId }, wholeLine), true);
  const keys = assemblyLinesToCompleteOnKitScan({ id: kitId }, wholeLine);
  assert.deepEqual([...keys], [0]);
});

test('component scan matches only its line', () => {
  assert.equal(orderItemMatchesScannedProduct(componentLines[0], { id: compA }), true);
  assert.equal(orderItemMatchesScannedProduct(componentLines[1], { id: compA }), false);
});

test('scan of root kit SKU completes all component lines', () => {
  assert.equal(isRootKitSkuScanForOrder({ id: kitId }, componentLines), true);
  assert.equal(isRootKitSkuScanForOrder({ id: compA }, componentLines), false);
  const keys = assemblyLinesToCompleteOnRootKitScan({ id: kitId }, componentLines);
  assert.deepEqual([...keys].sort(), [0, 1]);
});
