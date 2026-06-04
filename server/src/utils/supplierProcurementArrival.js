/**
 * Окна складов поставщика → bucket закупки (today | tomorrow) для автозаказов.
 */

import {
  SUPPLIER_ARRIVAL_TODAY,
  SUPPLIER_ARRIVAL_TOMORROW,
  normalizeSupplierConfigWarehouses,
  normalizeSupplierWarehouseArrivalDay,
  normalizeWarehouseTime,
} from './supplierWarehouseArrival.js';

export { SUPPLIER_ARRIVAL_TODAY, SUPPLIER_ARRIVAL_TOMORROW };

const AUTO_ARRIVAL_NOTE_PREFIX = '[auto-arrival:';

export function autoArrivalNoteMarker(bucket) {
  const b = normalizeSupplierWarehouseArrivalDay(bucket);
  return `${AUTO_ARRIVAL_NOTE_PREFIX}${b}]`;
}

export function autoArrivalNoteText(bucket) {
  const b = normalizeSupplierWarehouseArrivalDay(bucket);
  const label = b === SUPPLIER_ARRIVAL_TOMORROW ? 'завтра' : 'сегодня';
  return `${autoArrivalNoteMarker(b)} Автозаказ · приедет ${label}`;
}

export function parseArrivalBucketFromPurchaseNote(note) {
  const s = String(note ?? '');
  const m = s.match(/\[auto-arrival:(today|tomorrow)\]/i);
  if (!m) return null;
  return normalizeSupplierWarehouseArrivalDay(m[1]);
}

function timeToMinutes(value, fallback = 0) {
  const t = normalizeWarehouseTime(value, '');
  if (!t) return fallback;
  const [h, m] = t.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Минуты от полуночи в Europe/Moscow. */
export function getMoscowMinutesOfDay(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return hour * 60 + minute;
}

/**
 * Активно ли сейчас окно [timeAfter .. time] (поддержка окна через полночь).
 */
export function isMinutesInWarehouseWindow(minutes, timeAfter, timeUntil) {
  const after = timeToMinutes(timeAfter, 0);
  const until = timeToMinutes(timeUntil, 24 * 60 - 1);
  if (after <= until) {
    return minutes >= after && minutes <= until;
  }
  return minutes >= after || minutes <= until;
}

/**
 * Bucket для новой позиции автозаказа:
 * — в активном окне → arrivalDay окна;
 * — до крайнего времени (time) у окон с приездом «сегодня» → today;
 * — иначе → tomorrow (отдельная закупка).
 */
export function resolveProcurementArrivalBucket(warehouses, now = new Date()) {
  const rows = normalizeSupplierConfigWarehouses(Array.isArray(warehouses) ? warehouses : []);
  if (!rows.length) return SUPPLIER_ARRIVAL_TODAY;

  const mins = getMoscowMinutesOfDay(now);

  for (const w of rows) {
    const after = w.timeAfter || '00:00';
    if (isMinutesInWarehouseWindow(mins, after, w.time)) {
      return normalizeSupplierWarehouseArrivalDay(w.arrivalDay);
    }
  }

  const todayRows = rows.filter(
    (w) => normalizeSupplierWarehouseArrivalDay(w.arrivalDay) === SUPPLIER_ARRIVAL_TODAY
  );
  if (todayRows.length) {
    const stillToday = todayRows.some((w) => mins <= timeToMinutes(w.time, 24 * 60 - 1));
    if (stillToday) return SUPPLIER_ARRIVAL_TODAY;
    return SUPPLIER_ARRIVAL_TOMORROW;
  }

  return SUPPLIER_ARRIVAL_TOMORROW;
}

export function resolveProcurementArrivalBucketFromApiConfig(apiConfig, now = new Date()) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  return resolveProcurementArrivalBucket(cfg.warehouses, now);
}
