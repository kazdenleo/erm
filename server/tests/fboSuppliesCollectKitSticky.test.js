import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPartialKitComponentProgress,
  kitComponentStillNeeded,
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
