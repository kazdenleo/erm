import {
  buildGoodsReturnDateRanges,
  isWbReturnExcluded,
  isWbReturnWaitingPickup,
} from '../src/services/wbReturns.service.js';

describe('isWbReturnExcluded', () => {
  test('expired storage at pickup point is excluded', () => {
    expect(isWbReturnExcluded({ status: 'Истек срок хранения на пвз' })).toBe(true);
    expect(isWbReturnExcluded({ status: 'Просрочен' })).toBe(true);
  });

  test('completed is excluded', () => {
    expect(isWbReturnExcluded({ status: 'Выдан' })).toBe(true);
  });
});

describe('isWbReturnWaitingPickup', () => {
  test('ready at pickup point', () => {
    expect(isWbReturnWaitingPickup({ status: 'Готов к выдаче' })).toBe(true);
    expect(isWbReturnWaitingPickup({ status: 'Ожидает забор' })).toBe(true);
  });

  test('expired storage is not waiting', () => {
    expect(isWbReturnWaitingPickup({ status: 'Истек срок хранения на пвз' })).toBe(false);
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
