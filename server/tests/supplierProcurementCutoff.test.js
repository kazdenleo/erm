/**
 * Тесты bucket закупки по отсечке времени складов поставщика.
 */

import {
  computeClosingCutoffBucket,
  resolveProcurementArrivalBucketFromApiConfig,
  resolveProcurementArrivalBucketWithCalendar,
  parseCutoffBucket,
  isProcurementBucketOpenForNewOrders,
  isPurchaseCreatedInProcurementWindow,
} from '../src/utils/supplierProcurementArrival.js';

function moscowDate(y, mo, d, h = 12, min = 0) {
  return new Date(Date.UTC(y, mo - 1, d, h - 3, min, 0));
}

const mikadoWarehouses = [
  { name: 'Москва', time: '21:00', arrivalDay: 'tomorrow' },
  { name: 'Москва2', time: '21:00', arrivalDay: 'tomorrow' },
  { name: 'СПБ', time: '14:00', arrivalDay: 'today' },
];

const moskvorechieWarehouses = [{ name: 'Юг', time: '15:30', arrivalDay: 'today' }];

describe('computeClosingCutoffBucket', () => {
  test('до отсечки — закрытие сегодня', () => {
    const now = moscowDate(2026, 6, 29, 20, 0);
    const bucket = computeClosingCutoffBucket({ time: '21:00' }, now);
    expect(bucket).toBe('cutoff:2026-06-29:21:00');
  });

  test('после отсечки — закрытие завтра', () => {
    const now = moscowDate(2026, 6, 29, 22, 0);
    const bucket = computeClosingCutoffBucket({ time: '21:00' }, now);
    expect(bucket).toBe('cutoff:2026-06-30:21:00');
  });
});

describe('Mikado procurement buckets', () => {
  test('Москва 20:00 и 22:00 — разные закупки', () => {
    const before = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 6, 29, 20, 0),
      supplierCode: 'mikado',
    });
    const after = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 6, 29, 22, 0),
      supplierCode: 'mikado',
    });
    expect(before).toBe('cutoff:2026-06-29:21:00');
    expect(after).toBe('cutoff:2026-06-30:21:00');
    expect(before).not.toBe(after);
  });

  test('СПБ до 14:00 — bucket как у Москвы', () => {
    const spbMorning = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 6, 29, 13, 0),
      supplierCode: 'mikado',
    });
    const moscowEvening = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 6, 29, 20, 0),
      supplierCode: 'mikado',
    });
    expect(spbMorning).toBe('cutoff:2026-06-29:21:00');
    expect(moscowEvening).toBe(spbMorning);
  });

  test('СПБ после 14:00 — отдельная закупка', () => {
    const spbAfternoon = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 6, 29, 15, 0),
      supplierCode: 'mikado',
      supplierWarehouseName: 'СПБ',
    });
    expect(spbAfternoon).toBe('cutoff:2026-06-30:14:00');
  });

  test('Москва 15:00 — текущее окно до 21:00', () => {
    const moscowAfternoon = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 6, 29, 15, 0),
      supplierCode: 'mikado',
      supplierWarehouseName: 'Москва',
    });
    expect(moscowAfternoon).toBe('cutoff:2026-06-29:21:00');
  });
});

describe('Moskvorechie procurement buckets', () => {
  test('до 15:30 и после — разные bucket', () => {
    const before = resolveProcurementArrivalBucketWithCalendar(moskvorechieWarehouses, {
      now: moscowDate(2026, 6, 29, 15, 0),
      supplierCode: 'moskvorechie',
    });
    const after = resolveProcurementArrivalBucketWithCalendar(moskvorechieWarehouses, {
      now: moscowDate(2026, 6, 29, 16, 0),
      supplierCode: 'moskvorechie',
    });
    expect(before).toBe('cutoff:2026-06-29:15:30');
    expect(after).toBe('cutoff:2026-06-30:15:30');
  });
});

describe('resolveProcurementArrivalBucketFromApiConfig', () => {
  test('парсит cutoff bucket', () => {
    const bucket = resolveProcurementArrivalBucketFromApiConfig(
      { warehouses: mikadoWarehouses },
      moscowDate(2026, 6, 29, 22, 0),
      null,
      'mikado'
    );
    const parsed = parseCutoffBucket(bucket);
    expect(parsed?.date).toBe('2026-06-30');
    expect(parsed?.time).toBe('21:00');
  });
});

describe('Mikado procurement buckets with warehouse weekends', () => {
  const WEEKENDS = [6, 0];
  const SUNDAY_ONLY = [0];

  test('Friday after 21:00, Sat/Sun before 21:00 — одна закупка; Sun after 21:00 — новая', () => {
    const friLate = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 5, 29, 22, 0),
      warehouseWeekendDays: WEEKENDS,
      supplierCode: 'mikado',
    });
    const sat = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 5, 30, 12, 0),
      warehouseWeekendDays: WEEKENDS,
      supplierCode: 'mikado',
    });
    const sun = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 5, 31, 20, 0),
      warehouseWeekendDays: WEEKENDS,
      supplierCode: 'mikado',
    });
    const sunLate = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 5, 31, 22, 0),
      warehouseWeekendDays: WEEKENDS,
      supplierCode: 'mikado',
    });

    expect(friLate).toBe('cutoff:2026-05-31:21:00');
    expect(sat).toBe(friLate);
    expect(sun).toBe(friLate);
    expect(sunLate).toBe('cutoff:2026-06-01:21:00');
    expect(sunLate).not.toBe(friLate);
  });

  test('только вс: сб после 21:00 и вс до 21:00 — та же субботняя закупка', () => {
    // 2026-08-01 = суббота, 2026-08-02 = воскресенье
    const satBefore = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 8, 1, 20, 0),
      warehouseWeekendDays: SUNDAY_ONLY,
      supplierCode: 'mikado',
    });
    const satAfter = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 8, 1, 22, 0),
      warehouseWeekendDays: SUNDAY_ONLY,
      supplierCode: 'mikado',
    });
    const sun = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 8, 2, 12, 0),
      warehouseWeekendDays: SUNDAY_ONLY,
      supplierCode: 'mikado',
    });
    const sunLate = resolveProcurementArrivalBucketWithCalendar(mikadoWarehouses, {
      now: moscowDate(2026, 8, 2, 22, 0),
      warehouseWeekendDays: SUNDAY_ONLY,
      supplierCode: 'mikado',
    });

    expect(satBefore).toBe('cutoff:2026-08-01:21:00');
    expect(satAfter).toBe(satBefore);
    expect(sun).toBe(satBefore);
    expect(sunLate).toBe('cutoff:2026-08-03:21:00');
    expect(isProcurementBucketOpenForNewOrders(satBefore, moscowDate(2026, 8, 2, 12, 0), SUNDAY_ONLY)).toBe(
      true
    );
    expect(isProcurementBucketOpenForNewOrders(satBefore, moscowDate(2026, 8, 2, 22, 0), SUNDAY_ONLY)).toBe(
      false
    );
  });
});

describe('procurement window guards', () => {
  test('после отсечки bucket закрыт для новых заказов', () => {
    const bucket = 'cutoff:2026-06-29:21:00';
    const after = moscowDate(2026, 6, 29, 22, 0);
    expect(isProcurementBucketOpenForNewOrders(bucket, after)).toBe(false);
    const before = moscowDate(2026, 6, 29, 20, 0);
    expect(isProcurementBucketOpenForNewOrders(bucket, before)).toBe(true);
  });

  test('старая закупка вне окна bucket не подходит', () => {
    const bucket = 'cutoff:2026-06-30:21:00';
    const createdYesterday = new Date(Date.UTC(2026, 5, 28, 14, 46, 49));
    const now = moscowDate(2026, 6, 29, 22, 0);
    expect(isPurchaseCreatedInProcurementWindow(createdYesterday, bucket, now)).toBe(false);
    const createdInWindow = moscowDate(2026, 6, 29, 22, 0);
    expect(isPurchaseCreatedInProcurementWindow(createdInWindow, bucket, now)).toBe(true);
  });
});
