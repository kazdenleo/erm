import test from 'node:test';
import assert from 'node:assert/strict';
import { getFboItemReserveParts } from '../../client/src/pages/FboSupplies/fboSupplyItemReserve.js';

test('getFboItemReserveParts: total is always stock + incoming', () => {
  assert.deepEqual(
    getFboItemReserveParts({ reservedFromStock: 4, reservedFromIncoming: 0, reservedTotal: 10 }),
    { stock: 4, incoming: 0, total: 4 }
  );
});

test('getFboItemReserveParts: ignores reservedTotal=0 when parts are positive', () => {
  assert.deepEqual(
    getFboItemReserveParts({ reservedFromStock: 6, reservedFromIncoming: 0, reservedTotal: 0 }),
    { stock: 6, incoming: 0, total: 6 }
  );
});

test('getFboItemReserveParts: snake_case fields', () => {
  assert.deepEqual(
    getFboItemReserveParts({ reserved_from_stock: 3, reserved_from_incoming: 2 }),
    { stock: 3, incoming: 2, total: 5 }
  );
});
