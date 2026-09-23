import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPartialKitComponentProgress,
  kitComponentStillNeeded,
  collectStickyTestApi,
} from '../src/services/fboSuppliesCollect.service.js';

const compA = 101;
const compB = 102;
const compC = 103;

const kitAb = [
  { component_product_id: compA, quantity: 1 },
  { component_product_id: compB, quantity: 1 },
];
const kitAc = [
  { component_product_id: compA, quantity: 1 },
  { component_product_id: compC, quantity: 1 },
];

test('after scanning A on A+B kit: partial sticky, A not needed, B needed, C not on kit', () => {
  const progress = { [String(compA)]: 1 };
  assert.equal(hasPartialKitComponentProgress(progress, kitAb), true);
  assert.equal(kitComponentStillNeeded(progress, kitAb, compA), false);
  assert.equal(kitComponentStillNeeded(progress, kitAb, compB), true);
  assert.equal(kitComponentStillNeeded(progress, kitAb, compC), false);
  assert.equal(kitComponentStillNeeded({}, kitAc, compA), true);
  assert.equal(kitComponentStillNeeded({}, kitAc, compC), true);
});

test('empty progress is not sticky; full unit ready counts as partial until subtract', () => {
  assert.equal(hasPartialKitComponentProgress({}, kitAb), false);
  assert.equal(
    hasPartialKitComponentProgress({ [String(compA)]: 1, [String(compB)]: 1 }, kitAb),
    true
  );
});

test('orphan progress keys for other products do not sticky an empty kit', () => {
  const orphan = { '999999': 2 };
  assert.equal(hasPartialKitComponentProgress(orphan, kitAb), false);
  assert.equal(hasPartialKitComponentProgress({ [String(compA)]: 1 }, kitAb), true);
});

test('sticky per-user: two users can hold different kits on same supply', () => {
  collectStickyTestApi.resetAll();
  const supplyId = 183;
  collectStickyTestApi.setUserSticky(supplyId, 10, { userId: 1, userName: 'A' });
  collectStickyTestApi.setUserSticky(supplyId, 20, { userId: 2, userName: 'B' });
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 1 }), 10);
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 2 }), 20);
  collectStickyTestApi.clearUserSticky(supplyId, { userId: 1 });
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 1 }), null);
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 2 }), 20);
  collectStickyTestApi.clearStickiesForSupplyItem(supplyId, 20);
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 2 }), null);
  collectStickyTestApi.resetAll();
});

test('sticky per-user: two users can share the same kit sticky', () => {
  collectStickyTestApi.resetAll();
  const supplyId = 183;
  collectStickyTestApi.setUserSticky(supplyId, 10, { userId: 1, userName: 'A' });
  collectStickyTestApi.setUserSticky(supplyId, 10, { userId: 2, userName: 'B' });
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 1 }), 10);
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 2 }), 10);
  collectStickyTestApi.clearUserSticky(supplyId, { userId: 1 });
  assert.equal(collectStickyTestApi.getUserStickyItemId(supplyId, { userId: 2 }), 10);
  collectStickyTestApi.resetAll();
});
