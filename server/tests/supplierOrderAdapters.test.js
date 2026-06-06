/**
 * Unit-тесты адаптеров отправки заказа поставщику.
 */

import {
  normalizeWarehouseName,
  pickWarehouseLine,
  warehouseNameMatches,
  xmlTag,
} from '../src/services/supplierOrderAdapters/shared.js';

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

  test('normalizeWarehouseName collapses spaces', () => {
    expect(normalizeWarehouseName('  Склад   MSK  ')).toBe('склад msk');
  });
});
