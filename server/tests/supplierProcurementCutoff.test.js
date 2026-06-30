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
