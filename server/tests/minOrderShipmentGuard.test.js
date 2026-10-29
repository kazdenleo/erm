import {
  moscowYmdFromDate,
  ymdDiffDays,
  canWaitForMinOrderAmount,
  shouldBypassMinOrderAmount,
} from '../src/utils/minOrderShipmentGuard.js';

describe('moscowYmdFromDate', () => {
  test('берёт календарный день Москвы', () => {
    // 2026-10-29 22:00 UTC = 2026-10-30 01:00 MSK
    expect(moscowYmdFromDate('2026-10-29T22:00:00.000Z')).toBe('2026-10-30');
  });
});

describe('ymdDiffDays', () => {
  test('считает запас дней', () => {
    expect(ymdDiffDays('2026-10-29', '2026-10-31')).toBe(2);
    expect(ymdDiffDays('2026-10-31', '2026-10-31')).toBe(0);
    expect(ymdDiffDays('2026-11-01', '2026-10-31')).toBe(-1);
  });
});

describe('canWaitForMinOrderAmount', () => {
  test('без срока отгрузки — копим', () => {
    expect(
      canWaitForMinOrderAmount({
        shipmentDeadline: null,
        plannedDeliveryYmd: '2026-10-30',
      })
    ).toBe(true);
  });

  test('приход за 2 дня до отгрузки — можно копить', () => {
    expect(
      canWaitForMinOrderAmount({
        shipmentDeadline: '2026-10-31T12:00:00+03:00',
        plannedDeliveryYmd: '2026-10-29',
        minSlackDays: 1,
      })
    ).toBe(true);
  });

  test('приход в день отгрузки — не копим', () => {
    expect(
      shouldBypassMinOrderAmount({
        shipmentDeadline: '2026-10-30T18:00:00+03:00',
        plannedDeliveryYmd: '2026-10-30',
        minSlackDays: 1,
      })
    ).toBe(true);
  });

  test('приход после срока — не копим', () => {
    expect(
      shouldBypassMinOrderAmount({
        shipmentDeadline: '2026-10-29T12:00:00+03:00',
        plannedDeliveryYmd: '2026-10-30',
        minSlackDays: 1,
      })
    ).toBe(true);
  });
});
