import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOzonListOrderIds,
  parseOzonBundleResponse,
  parseWbSuppliesListResponse,
  ozonSupplyRowState,
  isOzonSupplyImportable,
} from '../src/services/fboSuppliesImport.service.js';

test('parseOzonListOrderIds reads root and result.order_ids', () => {
  assert.deepEqual(parseOzonListOrderIds({ order_ids: ['11', 22] }), ['11', '22']);
  assert.deepEqual(parseOzonListOrderIds({ result: { order_ids: [3] } }), ['3']);
});

test('parseOzonListOrderIds reads supply_order_ids and orders[].order_id', () => {
  assert.deepEqual(parseOzonListOrderIds({ supply_order_ids: [9] }), ['9']);
  assert.deepEqual(parseOzonListOrderIds({ orders: [{ order_id: 5 }, { id: 6 }] }), ['5', '6']);
  assert.deepEqual(parseOzonListOrderIds(null), []);
  assert.deepEqual(parseOzonListOrderIds({}), []);
});

test('empty supply.state falls back to order.state for importable check', () => {
  assert.equal(ozonSupplyRowState({ state: 'DATA_FILLING' }, { state: '' }), 'DATA_FILLING');
  assert.equal(isOzonSupplyImportable({ state: 'DATA_FILLING' }, { state: '' }), true);
  assert.equal(isOzonSupplyImportable({ state: 'IN_TRANSIT' }, null), false);
  assert.equal(isOzonSupplyImportable({ state: 'READY_TO_SUPPLY' }, null), true);
});

test('parseOzonBundleResponse prefers total_items', () => {
  const parsed = parseOzonBundleResponse({
    result: { items: [{ offer_id: 'A', quantity: 2 }], total_items: 4, total_count: 1 },
  });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.totalCount, 4);
});

test('parseWbSuppliesListResponse reads nested supplies', () => {
  assert.deepEqual(parseWbSuppliesListResponse({ data: { supplies: [{ supplyID: 1 }] } }), [
    { supplyID: 1 },
  ]);
  assert.deepEqual(parseWbSuppliesListResponse({ result: { supplies: [{ supplyID: 2 }] } }), [
    { supplyID: 2 },
  ]);
});
