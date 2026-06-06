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

/** Дата в Europe/Moscow как YYYY-MM-DD. */
export function formatMoscowDate(now = new Date(), dayOffset = 0) {
  const d = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/** Склад поставщика, определивший bucket (для ship_date / planned_delivery). */
export function pickActiveSupplierWarehouse(apiConfig, now = new Date()) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const rows = normalizeSupplierConfigWarehouses(Array.isArray(cfg.warehouses) ? cfg.warehouses : []);
  if (!rows.length) return { warehouse: null, bucket: SUPPLIER_ARRIVAL_TODAY };

  const mins = getMoscowMinutesOfDay(now);
  for (const w of rows) {
    const after = w.timeAfter || '00:00';
    if (isMinutesInWarehouseWindow(mins, after, w.time)) {
      return {
        warehouse: w,
        bucket: normalizeSupplierWarehouseArrivalDay(w.arrivalDay),
      };
    }
  }

  const bucket = resolveProcurementArrivalBucket(rows, now);
  const todayRows = rows.filter(
    (w) => normalizeSupplierWarehouseArrivalDay(w.arrivalDay) === SUPPLIER_ARRIVAL_TODAY
  );
  const pool = bucket === SUPPLIER_ARRIVAL_TODAY && todayRows.length ? todayRows : rows;
  return { warehouse: pool[0] || rows[0] || null, bucket };
}

/**
 * @param {number} [deliveryDays] delivery_days из supplier_stocks
 * @returns {{ shipDate: string, plannedDeliveryDate: string, arrivalBucket: string, supplierWarehouseName: string|null }}
 */
export function computeProcurementDates(apiConfig, now = new Date(), deliveryDays = 0) {
  const { warehouse, bucket } = pickActiveSupplierWarehouse(apiConfig, now);
  const offset = bucket === SUPPLIER_ARRIVAL_TOMORROW ? 1 : 0;
  const shipDate = formatMoscowDate(now, offset);
  const lead = Math.max(0, Math.floor(Number(deliveryDays) || 0));
  const plannedDeliveryDate = formatMoscowDate(now, offset + lead);
  const supplierWarehouseName = warehouse?.name ? String(warehouse.name).trim() : null;
  return { shipDate, plannedDeliveryDate, arrivalBucket: bucket, supplierWarehouseName };
}
