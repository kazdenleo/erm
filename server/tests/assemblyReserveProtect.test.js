import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isOrderAssemblyReserveProtectedStatus,
  isAssembledOrderReserveStatus,
} from '../src/services/orders.service.js';

test('assembly-protected statuses block background unreserve', () => {
  assert.equal(isOrderAssemblyReserveProtectedStatus('assembled'), true);
  assert.equal(isOrderAssemblyReserveProtectedStatus('in_assembly'), true);
  assert.equal(isOrderAssemblyReserveProtectedStatus('wb_assembly'), true);
  assert.equal(isOrderAssemblyReserveProtectedStatus('Assembled'), true);
  assert.equal(isOrderAssemblyReserveProtectedStatus('in_procurement'), false);
  assert.equal(isOrderAssemblyReserveProtectedStatus('new'), false);
  assert.equal(isOrderAssemblyReserveProtectedStatus('cancelled'), false);
});

test('assembled reserve status helper', () => {
  assert.equal(isAssembledOrderReserveStatus('assembled'), true);
  assert.equal(isAssembledOrderReserveStatus('wb_assembly'), true);
  assert.equal(isAssembledOrderReserveStatus('in_assembly'), false);
});
