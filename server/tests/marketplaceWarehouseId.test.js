import { describe, test, expect } from '@jest/globals';
import {
  parseMarketplaceWarehouseId,
  matchOwnWarehouseIdByMarketplaceWarehouseId,
  shipmentMarketplaceWarehouseKey,
  marketplaceWarehouseLabel,
  shipmentsMatchMarketplaceWarehouse,
} from '../src/utils/marketplaceWarehouseId.js';

describe('parseMarketplaceWarehouseId', () => {
  test('чистое число', () => {
    expect(parseMarketplaceWarehouseId('991873')).toBe('991873');
  });

  test('id — название', () => {
    expect(parseMarketplaceWarehouseId('991873 — Мой склад')).toBe('991873');
    expect(parseMarketplaceWarehouseId('1020005000119286 — Теплый стан')).toBe('1020005000119286');
  });

  test('название без ID', () => {
    expect(parseMarketplaceWarehouseId('Свой склад РФ')).toBeNull();
    expect(parseMarketplaceWarehouseId('Москва (FBS)')).toBeNull();
  });

  test('пустое', () => {
    expect(parseMarketplaceWarehouseId('')).toBeNull();
    expect(parseMarketplaceWarehouseId(null)).toBeNull();
  });
});

describe('matchOwnWarehouseIdByMarketplaceWarehouseId', () => {
  const rows = [
    { warehouse_id: 5, marketplace_warehouse_id: '991873' },
    { warehouse_id: 1, marketplace_warehouse_id: '1020005000119286 — Теплый стан' },
    { warehouse_id: 9, marketplace_warehouse_id: 'Свой склад РФ' },
  ];

  test('связывает по числовому id, даже если в заказе есть название', () => {
    expect(matchOwnWarehouseIdByMarketplaceWarehouseId(rows, '991873 — Свой склад РФ')).toBe(5);
    expect(matchOwnWarehouseIdByMarketplaceWarehouseId(rows, '991873')).toBe(5);
  });

  test('связывает устаревшую запись «id — название» с чистым id', () => {
    expect(matchOwnWarehouseIdByMarketplaceWarehouseId(rows, '1020005000119286')).toBe(1);
  });

  test('не связывает по названию без id', () => {
    expect(matchOwnWarehouseIdByMarketplaceWarehouseId(rows, 'Свой склад РФ')).toBeNull();
    expect(matchOwnWarehouseIdByMarketplaceWarehouseId(rows, 'Мой склад')).toBeNull();
  });
});

describe('shipment marketplace warehouse grouping', () => {
  test('key prefers numeric id', () => {
    expect(shipmentMarketplaceWarehouseKey('1818583 — Киров')).toBe('1818583');
    expect(shipmentMarketplaceWarehouseKey('Москва')).toBe('москва');
  });

  test('label from id — name', () => {
    expect(marketplaceWarehouseLabel('1818583 — Киров')).toBe('Киров');
    expect(marketplaceWarehouseLabel('Москва')).toBe('Москва');
  });

  test('legacy open GI without key does not take Kirov orders', () => {
    const legacy = { id: 'ship-msk' };
    expect(shipmentsMatchMarketplaceWarehouse(legacy, 'Москва')).toBe(true);
    expect(shipmentsMatchMarketplaceWarehouse(legacy, '1818583 — Киров')).toBe(false);
  });

  test('explicit GI only matches same MP warehouse', () => {
    const kirov = { marketplaceWarehouseId: '1818583 — Киров' };
    expect(shipmentsMatchMarketplaceWarehouse(kirov, '1818583')).toBe(true);
    expect(shipmentsMatchMarketplaceWarehouse(kirov, 'Москва')).toBe(false);
  });
});
