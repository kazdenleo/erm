import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isKitSkuScanForOrder,
  assemblyLinesToCompleteOnKitScan,
  isRootKitSkuScanForOrder,
  assemblyLinesToCompleteOnRootKitScan,
  orderItemMatchesScannedProduct,
  assemblyLineScanKey,
  applyAssemblyBarcodeScan,
  isAssemblyCompositionComplete,
  scannedProductStillNeededOnOrder,
  shouldPreferCurrentAssemblyOrder,
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

test('scan keys stay stable when orderLineId / row order changes', () => {
  const first = [
    { productId: compA, quantity: 1, orderLineId: '111', kitProductId: kitId, isKitComponent: true },
    { productId: compB, quantity: 1, orderLineId: '111', kitProductId: kitId, isKitComponent: true },
  ];
  const second = [
    { productId: compB, quantity: 1, orderLineId: '222', kitProductId: kitId, isKitComponent: true },
    { productId: compA, quantity: 1, orderLineId: '222', kitProductId: kitId, isKitComponent: true },
  ];
  assert.equal(assemblyLineScanKey(first[0], 0, first), assemblyLineScanKey(second[1], 1, second));
  assert.equal(assemblyLineScanKey(first[1], 1, first), assemblyLineScanKey(second[0], 0, second));
});

test('scanning A then B completes a 2-component kit (no loop)', () => {
  let qty = {};
  qty = applyAssemblyBarcodeScan(qty, { id: compA }, componentLines);
  assert.equal(isAssemblyCompositionComplete(componentLines, qty), false);

  qty = applyAssemblyBarcodeScan(qty, { id: compB }, componentLines);
  assert.equal(isAssemblyCompositionComplete(componentLines, qty), true);
});

test('progress survives orderLineId change between component scans', () => {
  const afterA = [
    { productId: compA, quantity: 1, orderLineId: 'oid-A', kitProductId: kitId, isKitComponent: true },
    { productId: compB, quantity: 1, orderLineId: 'oid-A', kitProductId: kitId, isKitComponent: true },
  ];
  const afterB = [
    { productId: compA, quantity: 1, orderLineId: 'oid-B', kitProductId: kitId, isKitComponent: true },
    { productId: compB, quantity: 1, orderLineId: 'oid-B', kitProductId: kitId, isKitComponent: true },
  ];
  let qty = applyAssemblyBarcodeScan({}, { id: compA }, afterA);
  qty = applyAssemblyBarcodeScan(qty, { id: compB }, afterB);
  assert.equal(isAssemblyCompositionComplete(afterB, qty), true);
});

test('partial progress on order A: barcode shared with B stays on A', () => {
  // Заказ A: кисти 650 + 400; заказ B: 400 + 550. После скана 650 на A скан 400 не должен «увести» на B.
  const brush650 = 650;
  const brush400 = 400;
  const brush550 = 550;
  const orderAItems = [
    { productId: brush650, quantity: 1, kitProductId: 9001, isKitComponent: true },
    { productId: brush400, quantity: 1, kitProductId: 9001, isKitComponent: true },
  ];
  const orderBItems = [
    { productId: brush400, quantity: 1, kitProductId: 9002, isKitComponent: true },
    { productId: brush550, quantity: 1, kitProductId: 9002, isKitComponent: true },
  ];

  let qtyA = applyAssemblyBarcodeScan({}, { id: brush650 }, orderAItems);
  assert.equal(isAssemblyCompositionComplete(orderAItems, qtyA), false);
  assert.equal(scannedProductStillNeededOnOrder({ id: brush400 }, orderAItems, qtyA), true);
  assert.equal(scannedProductStillNeededOnOrder({ id: brush400 }, orderBItems, {}), true);
  assert.equal(shouldPreferCurrentAssemblyOrder({ id: brush400 }, orderAItems, qtyA), true);

  qtyA = applyAssemblyBarcodeScan(qtyA, { id: brush400 }, orderAItems);
  assert.equal(isAssemblyCompositionComplete(orderAItems, qtyA), true);
  assert.equal(shouldPreferCurrentAssemblyOrder({ id: brush400 }, orderAItems, qtyA), false);
  assert.equal(shouldPreferCurrentAssemblyOrder({ id: brush550 }, orderAItems, qtyA), false);
});
