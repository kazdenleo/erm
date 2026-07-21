/**
 * Тесты календаря склада и bucket закупок с выходными.
 */

import {
  findWorkingDayOffset,
  findLastConsecutiveWeekendDay,
  getMoscowDateParts,
  normalizeWeekendDays,
  resolveShipDayOffsetFromNaiveBucket,
} from '../src/utils/warehouseWorkingCalendar.js';
import {
  resolveProcurementArrivalBucketWithCalendar,
  isProcurementBucketOpenForNewOrders,
  isPurchaseCreatedInProcurementWindow,
  shipDateFromArrivalBucket,
} from '../src/utils/supplierProcurementArrival.js';

const WEEKENDS = [6, 0]; // сб, вс

function moscowDate(y, mo, d, h = 12, min = 0) {
  // UTC instant that corresponds to given Moscow local time (no DST in RU since 2014)
  return new Date(Date.UTC(y, mo - 1, d, h - 3, min, 0));
}

describe('warehouseWorkingCalendar', () => {
  test('normalizeWeekendDays parses array', () => {
    expect(normalizeWeekendDays([6, 0, 6])).toEqual([0, 6]);
  });

  test('Friday after cutoff → Monday when Sat/Sun are weekends', () => {
    const now = moscowDate(2026, 5, 29, 19, 0); // Fri 19:00 MSK
    const { shipDayOffset, shipDate } = resolveShipDayOffsetFromNaiveBucket('tomorrow', WEEKENDS, now);
    expect(shipDayOffset).toBe(3);
    expect(shipDate).toBe('2026-06-01');
  });

  test('Saturday orders → same Monday bucket', () => {
    const now = moscowDate(2026, 5, 30, 10, 0); // Sat
    const offset = findWorkingDayOffset(now, WEEKENDS, 0);
    const parts = getMoscowDateParts(now, offset);
    expect(parts.weekday).toBe(1);
    expect(parts.ymd).toBe('2026-06-01');
  });

  test('findLastConsecutiveWeekendDay extends Sat to Sun', () => {
    const last = findLastConsecutiveWeekendDay('2026-05-30', WEEKENDS, moscowDate(2026, 5, 30, 10, 0));
    expect(last).toBe('2026-05-31');
  });
});

describe('resolveProcurementArrivalBucketWithCalendar', () => {
  const supplierWarehouses = [
    { name: 'MSK', time: '18:00', arrivalDay: 'today' },
  ];

  test('before cutoff on Friday uses same-day cutoff bucket', () => {
    const now = moscowDate(2026, 5, 29, 17, 0);
    const bucket = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bucket).toBe('cutoff:2026-05-29:18:00');
  });

  test('after cutoff on Friday groups to Sunday cutoff bucket (weekend batch)', () => {
    const now = moscowDate(2026, 5, 29, 19, 0);
    const bucket = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bucket).toBe('cutoff:2026-05-31:18:00');
  });

  test('Saturday and Sunday before cutoff share Sunday cutoff bucket', () => {
    const friLate = moscowDate(2026, 5, 29, 19, 0);
    const sat = moscowDate(2026, 5, 30, 11, 0);
    const sun = moscowDate(2026, 5, 31, 11, 0);
    const bFri = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now: friLate,
      warehouseWeekendDays: WEEKENDS,
    });
    const bSat = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now: sat,
      warehouseWeekendDays: WEEKENDS,
    });
    const bSun = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now: sun,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bFri).toBe('cutoff:2026-05-31:18:00');
    expect(bSat).toBe(bFri);
    expect(bSun).toBe(bFri);
  });

  test('Sunday after cutoff opens new Monday bucket', () => {
    const sunLate = moscowDate(2026, 5, 31, 19, 0);
    const bucket = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now: sunLate,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bucket).toBe('cutoff:2026-06-01:18:00');
    expect(shipDateFromArrivalBucket(bucket)).toBe('2026-06-01');
  });

  test('weekend batch stays open through Sunday cutoff', () => {
    const bucket = 'cutoff:2026-05-31:18:00';
    const sat = moscowDate(2026, 5, 30, 11, 0);
    const sunBefore = moscowDate(2026, 5, 31, 17, 0);
    const sunAfter = moscowDate(2026, 5, 31, 19, 0);
    expect(isProcurementBucketOpenForNewOrders(bucket, sat)).toBe(true);
    expect(isProcurementBucketOpenForNewOrders(bucket, sunBefore)).toBe(true);
    expect(isProcurementBucketOpenForNewOrders(bucket, sunAfter)).toBe(false);
  });

  test('purchase created Friday after cutoff fits Sunday weekend bucket', () => {
    const bucket = 'cutoff:2026-05-31:18:00';
    const created = moscowDate(2026, 5, 29, 22, 0);
    const now = moscowDate(2026, 5, 30, 11, 0);
    expect(isPurchaseCreatedInProcurementWindow(created, bucket, now, WEEKENDS)).toBe(true);
  });
});
