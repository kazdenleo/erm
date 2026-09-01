import assert from 'node:assert/strict';
import { wbExtractShipmentDate } from '../src/services/orders.sync.service.js';

assert.equal(wbExtractShipmentDate({ sellerDate: '02.06.2025' }), '2025-06-02');
assert.equal(wbExtractShipmentDate({ ddate: '17.05.2024' }), '2024-05-17');
assert.equal(wbExtractShipmentDate({ sellerDate: '2025-06-02' }), '2025-06-02');
assert.equal(wbExtractShipmentDate({}), '');
assert.equal(wbExtractShipmentDate(null), '');

console.log('wbExtractShipmentDate: ok');
