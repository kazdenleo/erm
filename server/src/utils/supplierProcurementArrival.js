/**
 * Окна складов поставщика → bucket закупки для автозаказов.
 * Учитывает выходные нашего склада (warehouses.weekend_days).
 */

import {
  SUPPLIER_ARRIVAL_TODAY,
  SUPPLIER_ARRIVAL_TOMORROW,
  normalizeSupplierConfigWarehouses,
  normalizeSupplierWarehouseArrivalDay,
  normalizeWarehouseTime,
} from './supplierWarehouseArrival.js';
import {
  getMoscowDateParts,
  normalizeWeekendDays,
  resolveShipDayOffsetFromNaiveBucket,
} from './warehouseWorkingCalendar.js';

export { SUPPLIER_ARRIVAL_TODAY, SUPPLIER_ARRIVAL_TOMORROW };

const AUTO_ARRIVAL_NOTE_PREFIX = '[auto-arrival:';
const DATE_BUCKET_PREFIX = 'date:';

export function isDateArrivalBucket(bucket) {
  return String(bucket || '').startsWith(DATE_BUCKET_PREFIX);
}

export function arrivalBucketFromShipDate(shipDate) {
  const d = String(shipDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return `${DATE_BUCKET_PREFIX}${d}`;
}

export function shipDateFromArrivalBucket(bucket) {
  const b = String(bucket || '');
  if (!b.startsWith(DATE_BUCKET_PREFIX)) return null;
  const d = b.slice(DATE_BUCKET_PREFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

export function autoArrivalNoteMarker(bucket) {
  const b = normalizeArrivalBucket(bucket);
  return `${AUTO_ARRIVAL_NOTE_PREFIX}${b}]`;
}

export function autoArrivalNoteText(bucket) {
  const b = normalizeArrivalBucket(bucket);
  const shipDate = shipDateFromArrivalBucket(b);
  let label;
  if (shipDate) {
    label = shipDate;
  } else if (b === SUPPLIER_ARRIVAL_TOMORROW) {
    label = 'завтра';
  } else {
    label = 'сегодня';
  }
  return `${autoArrivalNoteMarker(b)} Автозаказ · отправка ${label}`;
}

export function parseArrivalBucketFromPurchaseNote(note) {
  const s = String(note ?? '');
  const m = s.match(/\[auto-arrival:([^\]]+)\]/i);
  if (!m) return null;
  return normalizeArrivalBucket(m[1]);
}

export function normalizeArrivalBucket(bucket) {
  const b = String(bucket ?? '').trim();
  if (b.startsWith(DATE_BUCKET_PREFIX)) {
    const d = b.slice(DATE_BUCKET_PREFIX.length);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${DATE_BUCKET_PREFIX}${d}`;
  }
  return normalizeSupplierWarehouseArrivalDay(b);
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
 * Bucket по окнам поставщика (без выходных нашего склада): today | tomorrow.
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

/**
 * Bucket с учётом выходных нашего склада.
 * После cutoff в пятницу (выходные сб/вс) → date:YYYY-MM-DD (понедельник), одна закупка на все заказы до него.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number[]|null} [options.warehouseWeekendDays]
 */
export function resolveProcurementArrivalBucketWithCalendar(
  warehouses,
  { now = new Date(), warehouseWeekendDays = null } = {}
) {
  const naive = resolveProcurementArrivalBucket(warehouses, now);
  const weekends = normalizeWeekendDays(warehouseWeekendDays);
  if (!weekends.length) return naive;

  const { shipDayOffset, shipDate } = resolveShipDayOffsetFromNaiveBucket(naive, weekends, now);
  if (shipDayOffset === 0 && naive === SUPPLIER_ARRIVAL_TODAY) {
    return SUPPLIER_ARRIVAL_TODAY;
  }
  if (shipDayOffset === 1 && naive === SUPPLIER_ARRIVAL_TOMORROW) {
    const { weekday } = getMoscowDateParts(now, 1);
    if (!weekends.includes(weekday)) return SUPPLIER_ARRIVAL_TOMORROW;
  }
  return arrivalBucketFromShipDate(shipDate) || naive;
}

export function resolveProcurementArrivalBucketFromApiConfig(
  apiConfig,
  now = new Date(),
  warehouseWeekendDays = null
) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  return resolveProcurementArrivalBucketWithCalendar(cfg.warehouses, {
    now,
    warehouseWeekendDays,
  });
}

/** Дата в Europe/Moscow как YYYY-MM-DD. */
export function formatMoscowDate(now = new Date(), dayOffset = 0) {
  return getMoscowDateParts(now, dayOffset).ymd;
}

/** Склад поставщика, определивший bucket (для ship_date / planned_delivery). */
export function pickActiveSupplierWarehouse(
  apiConfig,
  now = new Date(),
  warehouseWeekendDays = null
) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const rows = normalizeSupplierConfigWarehouses(Array.isArray(cfg.warehouses) ? cfg.warehouses : []);
  if (!rows.length) {
    const bucket = resolveProcurementArrivalBucketWithCalendar([], {
      now,
      warehouseWeekendDays,
    });
    return { warehouse: null, bucket };
  }

  const mins = getMoscowMinutesOfDay(now);
  for (const w of rows) {
    const after = w.timeAfter || '00:00';
    if (isMinutesInWarehouseWindow(mins, after, w.time)) {
      const naive = normalizeSupplierWarehouseArrivalDay(w.arrivalDay);
      const bucket = resolveProcurementArrivalBucketWithCalendar(rows, {
        now,
        warehouseWeekendDays,
      });
      return { warehouse: w, bucket: bucket || naive };
    }
  }

  const bucket = resolveProcurementArrivalBucketWithCalendar(rows, {
    now,
    warehouseWeekendDays,
  });
  const todayRows = rows.filter(
    (w) => normalizeSupplierWarehouseArrivalDay(w.arrivalDay) === SUPPLIER_ARRIVAL_TODAY
  );
  const pool = bucket === SUPPLIER_ARRIVAL_TODAY && todayRows.length ? todayRows : rows;
  return { warehouse: pool[0] || rows[0] || null, bucket };
}

/**
 * @param {number} [deliveryDays] delivery_days из supplier_stocks
 * @param {number[]|null} [warehouseWeekendDays] warehouses.weekend_days
 * @returns {{ shipDate: string, plannedDeliveryDate: string, arrivalBucket: string, supplierWarehouseName: string|null }}
 */
export function computeProcurementDates(
  apiConfig,
  now = new Date(),
  deliveryDays = 0,
  warehouseWeekendDays = null
) {
  const { warehouse, bucket } = pickActiveSupplierWarehouse(apiConfig, now, warehouseWeekendDays);

  let shipDayOffset = 0;
  const shipFromBucket = shipDateFromArrivalBucket(bucket);
  if (shipFromBucket) {
    for (let off = 0; off <= 14; off += 1) {
      if (formatMoscowDate(now, off) === shipFromBucket) {
        shipDayOffset = off;
        break;
      }
    }
  } else if (bucket === SUPPLIER_ARRIVAL_TOMORROW) {
    shipDayOffset = 1;
  }

  const shipDate = formatMoscowDate(now, shipDayOffset);
  const lead = Math.max(0, Math.floor(Number(deliveryDays) || 0));
  const plannedDeliveryDate = formatMoscowDate(now, shipDayOffset + lead);
  const supplierWarehouseName = warehouse?.name ? String(warehouse.name).trim() : null;

  return { shipDate, plannedDeliveryDate, arrivalBucket: bucket, supplierWarehouseName };
}
