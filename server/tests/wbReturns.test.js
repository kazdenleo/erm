import {
  buildGoodsReturnDateRanges,
  isWbReturnWaitingPickup,
} from '../src/services/wbReturns.service.js';

describe('isWbReturnWaitingPickup', () => {
  test('ready at pickup point', () => {
    expect(isWbReturnWaitingPickup({ status: 'Готов к выдаче' })).toBe(true);
    expect(isWbReturnWaitingPickup({ status: 'Ожидает забор' })).toBe(true);
  });

  test('in transit is not waiting', () => {
    expect(isWbReturnWaitingPickup({ isStatusActive: 1, status: 'В пути в пвз' })).toBe(false);
    expect(isWbReturnWaitingPickup({ status: 'В пути в ПВЗ' })).toBe(false);
  });

  test('completed is not waiting', () => {
    expect(isWbReturnWaitingPickup({ isStatusActive: 0, status: 'Выдан' })).toBe(false);
  });
});

describe('buildGoodsReturnDateRanges', () => {
  test('splits long spans into 31-day chunks', () => {
    const ranges = buildGoodsReturnDateRanges({
      dateFrom: '2024-01-01',
      dateTo: '2024-03-01',
    });
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0].dateFrom).toBe('2024-01-01');
    expect(ranges[ranges.length - 1].dateTo).toBe('2024-03-01');
  });
});
