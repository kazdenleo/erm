/**
 * Unit-тесты адаптеров отправки заказа поставщику.
 */

import {
  normalizeWarehouseName,
  pickWarehouseLine,
  warehouseNameMatches,
  xmlTag,
} from '../src/services/supplierOrderAdapters/shared.js';
import { parseMoskvorechieOrderResponse } from '../src/services/supplierOrderAdapters/moskvorechie.adapter.js';

describe('supplierOrderAdapters/shared', () => {
  test('xmlTag extracts tag text', () => {
    const xml = '<root><ID>42</ID><Message>OK</Message></root>';
    expect(xmlTag(xml, 'ID')).toBe('42');
    expect(xmlTag(xml, 'Message')).toBe('OK');
  });

  test('warehouseNameMatches partial names', () => {
    expect(warehouseNameMatches('Склад Москва', 'Москва')).toBe(true);
    expect(warehouseNameMatches('SPB', 'Москва')).toBe(false);
  });

  test('pickWarehouseLine prefers named warehouse with stock', () => {
    const lines = [
      { warehouseName: 'Москва', stock: 5, gid: '1' },
      { warehouseName: 'СПб', stock: 20, gid: '2' },
    ];
    const picked = pickWarehouseLine(lines, { warehouseName: 'Москва', quantity: 3 });
    expect(picked.gid).toBe('1');
  });

  test('pickWarehouseLine falls back to highest stock', () => {
    const lines = [
      { warehouseName: 'A', stock: 1, gid: '1' },
      { warehouseName: 'B', stock: 10, gid: '2' },
    ];
    const picked = pickWarehouseLine(lines, { quantity: 2 });
    expect(picked.gid).toBe('2');
  });

  test('pickWarehouseLine ignores lines without gid', () => {
    const lines = [
      { warehouseName: 'A', stock: 100 },
      { warehouseName: 'B', stock: 1, gid: '2' },
    ];
    const picked = pickWarehouseLine(lines, { quantity: 1 });
    expect(picked.gid).toBe('2');
  });

  test('pickWarehouseLine works with Mikado zakazCode', () => {
    const lines = [
      { warehouseName: 'Москва', stock: 5, zakazCode: 'Z1' },
      { warehouseName: 'СПб', stock: 20, zakazCode: 'Z2' },
    ];
    const picked = pickWarehouseLine(lines, { warehouseName: 'Москва', quantity: 1 });
    expect(picked.zakazCode).toBe('Z1');
  });

  test('pickWarehouseLine allows external warehouse with zero stock', () => {
    const lines = [
      { warehouseName: 'Ext', stock: 0, gid: 'ext' },
      { warehouseName: 'Main', stock: 0, gid: 'main' },
    ];
    const picked = pickWarehouseLine(lines, { quantity: 3 });
    expect(picked?.gid).toBeTruthy();
  });

  test('normalizeWarehouseName collapses spaces', () => {
    expect(normalizeWarehouseName('  Склад   MSK  ')).toBe('склад msk');
  });
});

describe('moskvorechie.adapter parseMoskvorechieOrderResponse', () => {
  test('accepts order_id in result object', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ result: { order_id: 'Z123' } }));
    expect(r.ok).toBe(true);
    expect(r.orderId).toBe('Z123');
  });

  test('rejects empty response', () => {
    const r = parseMoskvorechieOrderResponse('');
    expect(r.ok).toBe(false);
  });

  test('rejects response without order_id', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ result: { success: true } }));
    expect(r.ok).toBe(false);
  });

  test('surfaces API error field', () => {
    const r = parseMoskvorechieOrderResponse(JSON.stringify({ error: 'Нет доступа' }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Нет доступа');
  });
});
