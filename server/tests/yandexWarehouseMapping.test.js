import { describe, test, expect } from '@jest/globals';
import {
  buildYandexWarehouseMapping,
  formatYandexWarehouseMappingLabel,
  parseYandexWarehouseMapping,
} from '../src/utils/yandexWarehouseMapping.js';

describe('yandexWarehouseMapping', () => {
  test('legacy число = campaignId', () => {
    expect(parseYandexWarehouseMapping('149210464')).toEqual({
      campaignId: '149210464',
      warehouseId: '',
      raw: '149210464',
    });
  });

  test('новый формат с обоими id', () => {
    expect(parseYandexWarehouseMapping('campaignId=149210464;warehouseId=2384892')).toEqual({
      campaignId: '149210464',
      warehouseId: '2384892',
      raw: 'campaignId=149210464;warehouseId=2384892',
    });
  });

  test('build собирает оба поля', () => {
    expect(
      buildYandexWarehouseMapping({ campaignId: '149210464', warehouseId: '2384892' })
    ).toBe('campaignId=149210464;warehouseId=2384892');
  });

  test('label для UI', () => {
    expect(formatYandexWarehouseMappingLabel('campaignId=1;warehouseId=2')).toBe(
      'campaignId 1 · склад 2'
    );
  });
});
