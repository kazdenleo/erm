/**
 * Тесты календаря склада и bucket закупок с выходными.
 */

import {
  findWorkingDayOffset,
  getMoscowDateParts,
  normalizeWeekendDays,
  resolveShipDayOffsetFromNaiveBucket,
} from '../src/utils/warehouseWorkingCalendar.js';
import {
  resolveProcurementArrivalBucketWithCalendar,
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
});

describe('resolveProcurementArrivalBucketWithCalendar', () => {
  const supplierWarehouses = [
    { name: 'MSK', time: '18:00', arrivalDay: 'today' },
  ];

  test('before cutoff on Friday stays today', () => {
    const now = moscowDate(2026, 5, 29, 17, 0);
    const bucket = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bucket).toBe('today');
  });

  test('after cutoff on Friday groups to date:Monday', () => {
    const now = moscowDate(2026, 5, 29, 19, 0);
    const bucket = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bucket).toBe('date:2026-06-01');
    expect(shipDateFromArrivalBucket(bucket)).toBe('2026-06-01');
  });

  test('Saturday and Sunday share Monday date bucket', () => {
    const sat = moscowDate(2026, 5, 30, 11, 0);
    const sun = moscowDate(2026, 5, 31, 11, 0);
    const bSat = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now: sat,
      warehouseWeekendDays: WEEKENDS,
    });
    const bSun = resolveProcurementArrivalBucketWithCalendar(supplierWarehouses, {
      now: sun,
      warehouseWeekendDays: WEEKENDS,
    });
    expect(bSat).toBe('date:2026-06-01');
    expect(bSun).toBe(bSat);
  });
});
