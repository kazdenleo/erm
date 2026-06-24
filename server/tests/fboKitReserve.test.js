import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateKitReservePriority,
  computeAssemblableFromComponentPoolMap,
  resolveComplementaryKitReserveUnits,
} from '../src/services/kitStock.service.js';
import { fboReserveStatusRank } from '../src/services/fboSupplyReserve.service.js';

test('allocateKitReservePriority: whole first, then components', () => {
  const alloc = allocateKitReservePriority(5, {
    wholeReserveAvail: 2,
    fromComponents: 4,
    physicalOnHand: 2,
  });
  assert.deepEqual(alloc, { kitsToReserve: 5, fromWhole: 2, fromComponents: 3 });
});

test('computeAssemblableFromComponentPoolMap: min by composition', () => {
  const components = [
    { component_product_id: 10, quantity: 1 },
    { component_product_id: 20, quantity: 2 },
  ];
  const pools = new Map([
    [10, 5],
    [20, 6],
  ]);
  assert.equal(computeAssemblableFromComponentPoolMap(components, pools), 3);
});

test('resolveComplementaryKitReserveUnits for FBO line without double count', () => {
  assert.equal(resolveComplementaryKitReserveUnits(0, 4, 10), 4);
  assert.equal(resolveComplementaryKitReserveUnits(3, 0, 10), 3);
  assert.equal(resolveComplementaryKitReserveUnits(2, 3, 10), 5);
});

test('fboReserveStatusRank: packed before new in reserve queue', () => {
  assert.ok(fboReserveStatusRank('packed') < fboReserveStatusRank('new'));
  assert.ok(fboReserveStatusRank('ready_for_supply') < fboReserveStatusRank('new'));
  assert.ok(fboReserveStatusRank('packed') < fboReserveStatusRank('ready_for_supply'));
});
