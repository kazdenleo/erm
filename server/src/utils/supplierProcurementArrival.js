/**
 * Окна складов поставщика → bucket закупки для автозаказов.
 * Bucket = закрытие окна cutoff:YYYY-MM-DD:HH:MM (МСК), чтобы после отсечки — новая закупка.
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
  findLastConsecutiveWeekendDay,
  getMoscowDateParts,
  isWeekendWeekday,
  normalizeWeekendDays,
  weekdayForYmd,
} from './warehouseWorkingCalendar.js';

export { SUPPLIER_ARRIVAL_TODAY, SUPPLIER_ARRIVAL_TOMORROW };

const AUTO_ARRIVAL_NOTE_PREFIX = '[auto-arrival:';
const DATE_BUCKET_PREFIX = 'date:';
export const CUTOFF_BUCKET_PREFIX = 'cutoff:';

export function isDateArrivalBucket(bucket) {
  return String(bucket || '').startsWith(DATE_BUCKET_PREFIX);
}

export function isCutoffArrivalBucket(bucket) {
  return String(bucket || '').startsWith(CUTOFF_BUCKET_PREFIX);
}

export function cutoffBucketFromParts(dateYmd, timeHm) {
  const d = String(dateYmd || '').trim();
  const t = normalizeWarehouseTime(timeHm, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !t) return null;
  return `${CUTOFF_BUCKET_PREFIX}${d}:${t}`;
}

export function parseCutoffBucket(bucket) {
  const b = String(bucket || '');
  if (!b.startsWith(CUTOFF_BUCKET_PREFIX)) return null;
  const rest = b.slice(CUTOFF_BUCKET_PREFIX.length);
  const m = rest.match(/^(\d{4}-\d{2}-\d{2}):([0-2]\d:[0-5]\d)$/);
  if (!m) return null;
  return { date: m[1], time: m[2] };
}

export function arrivalBucketFromShipDate(shipDate) {
  const d = String(shipDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return `${DATE_BUCKET_PREFIX}${d}`;
}

export function shipDateFromArrivalBucket(bucket) {
  const b = String(bucket || '');
  if (b.startsWith(DATE_BUCKET_PREFIX)) {
    const d = b.slice(DATE_BUCKET_PREFIX.length);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }
  const cutoff = parseCutoffBucket(b);
  if (!cutoff) return null;
  return cutoff.date;
}

export function autoArrivalNoteMarker(bucket) {
  const b = normalizeArrivalBucket(bucket);
  return `${AUTO_ARRIVAL_NOTE_PREFIX}${b}]`;
}

export function autoArrivalNoteText(bucket) {
  const b = normalizeArrivalBucket(bucket);
  const shipDate = shipDateFromArrivalBucket(b);
  const cutoff = parseCutoffBucket(b);
  let label;
  if (cutoff) {
    label = `окно до ${cutoff.time} ${cutoff.date}`;
  } else if (shipDate) {
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
  if (b.startsWith(CUTOFF_BUCKET_PREFIX)) {
    const parsed = parseCutoffBucket(b);
    return parsed ? cutoffBucketFromParts(parsed.date, parsed.time) : b;
  }
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

/**
 * До какой даты (включительно) открыто окно bucket с учётом выходных нашего склада.
 * Пример: cutoff сб 21:00 + выходной вс → окно открыто до вс 21:00.
 */
export function getProcurementBucketOpenUntilYmd(bucket, warehouseWeekendDays = null, now = new Date()) {
  const cutoff = parseCutoffBucket(normalizeArrivalBucket(bucket));
  if (!cutoff) return null;
  const weekends = normalizeWeekendDays(warehouseWeekendDays);
  if (!weekends.length) return cutoff.date;

  const nextDay = addDaysToYmd(cutoff.date, 1);
  if (isWeekendWeekday(weekdayForYmd(nextDay, now), weekends)) {
    return findLastConsecutiveWeekendDay(nextDay, weekends, now);
  }
  // Bucket на выходном дне (legacy/сб+вс: cutoff=вс) — открыт до этой даты
  if (isWeekendWeekday(weekdayForYmd(cutoff.date, now), weekends)) {
    return findLastConsecutiveWeekendDay(cutoff.date, weekends, now);
  }
  return cutoff.date;
}

/** Отсечка bucket ещё не наступила — в эту закупку можно добавлять заказы. */
export function isProcurementBucketOpenForNewOrders(
  bucket,
  now = new Date(),
  warehouseWeekendDays = null
) {
  const normalized = normalizeArrivalBucket(bucket);
  const cutoff = parseCutoffBucket(normalized);
  if (cutoff) {
    const today = getMoscowDateParts(now, 0).ymd;
    const mins = getMoscowMinutesOfDay(now);
    const cutMins = timeToMinutes(cutoff.time);
    const openUntil = getProcurementBucketOpenUntilYmd(normalized, warehouseWeekendDays, now);
    if (openUntil == null) return false;
    if (today < openUntil) return true;
    if (today === openUntil && mins <= cutMins) return true;
    return false;
  }
  // Старые bucket today/tomorrow не используем для автослияния
  if (normalized === SUPPLIER_ARRIVAL_TODAY || normalized === SUPPLIER_ARRIVAL_TOMORROW) {
    return false;
  }
  return false;
}

/**
 * Закупка создана в текущем окне bucket (после предыдущей отсечки).
 * Отсекает старые закупки, которым ошибочно проставили метку нового окна.
 * @param {{ arrivalDay?: string }|null} [supplierWarehouse] склад поставщика (для склейки по дате приезда)
 */
export function isPurchaseCreatedInProcurementWindow(
  createdAt,
  bucket,
  now = new Date(),
  warehouseWeekendDays = null,
  supplierWarehouse = null
) {
  const normalized = normalizeArrivalBucket(bucket);
  const cutoff = parseCutoffBucket(normalized);
  if (!cutoff || createdAt == null) return true;

  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return true;

  const windowStart = getProcurementWindowStart(
    cutoff,
    warehouseWeekendDays,
    now,
    supplierWarehouse
  );
  if (!windowStart) return true;

  const windowStartYmd = windowStart.date;
  const windowStartMins = timeToMinutes(windowStart.time);
  const createdYmd = getMoscowDateParts(created, 0).ymd;
  const createdMins = getMoscowMinutesOfDay(created);

  if (createdYmd > windowStartYmd) return true;
  if (createdYmd === windowStartYmd && createdMins > windowStartMins) return true;
  return false;
}

function normalizeWarehouseNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function findWarehouseByNameKey(rows, ...keys) {
  for (const k of keys) {
    const want = normalizeWarehouseNameKey(k);
    if (!want) continue;
    const found = rows.find((w) => {
      const n = normalizeWarehouseNameKey(w.name);
      return n === want || n.includes(want) || want.includes(n);
    });
    if (found) return found;
  }
  return null;
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

function addDaysToYmd(ymd, days) {
  const [y, mo, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Наивная дата отгрузки по cutoff без выходных склада.
 * tomorrow → день после cutoff; today → день cutoff.
 */
function naiveShipYmdForCutoffDate(cutoffDate, supplierWarehouse) {
  const arrival = normalizeSupplierWarehouseArrivalDay(supplierWarehouse?.arrivalDay);
  return arrival === SUPPLIER_ARRIVAL_TOMORROW
    ? addDaysToYmd(cutoffDate, 1)
    : cutoffDate;
}

/** Сдвиг YYYY-MM-DD вперёд до первого рабочего дня нашего склада. */
function adjustYmdToNextWorkingDay(ymd, weekends, now = new Date()) {
  const normalizedWeekends = normalizeWeekendDays(weekends);
  if (!normalizedWeekends.length || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) {
    return ymd;
  }
  let cursor = ymd;
  for (let guard = 0; guard < 14; guard += 1) {
    if (!isWeekendWeekday(weekdayForYmd(cursor, now), normalizedWeekends)) return cursor;
    cursor = addDaysToYmd(cursor, 1);
  }
  return ymd;
}

function shipYmdFromCutoffDate(cutoffDate, supplierWarehouse, weekends, now = new Date()) {
  const naive = naiveShipYmdForCutoffDate(cutoffDate, supplierWarehouse);
  return adjustYmdToNextWorkingDay(naive, weekends, now);
}

/**
 * Если выходные склада сдвигают приезд позже наивной даты — копим до дня перед приездом
 * (одна закупка на одну дату приезда).
 * Пример Mikado tomorrow + сб/вс: чт после 21:00 → naive пт → ship пн → bucket вс 21:00.
 */
function collapseCutoffDateForSameShip(naiveCutoffDate, timeHm, supplierWarehouse, weekends, now) {
  const normalizedWeekends = normalizeWeekendDays(weekends);
  if (!normalizedWeekends.length || !naiveCutoffDate) {
    return cutoffBucketFromParts(naiveCutoffDate, timeHm);
  }
  const naiveShip = naiveShipYmdForCutoffDate(naiveCutoffDate, supplierWarehouse);
  const ship = adjustYmdToNextWorkingDay(naiveShip, normalizedWeekends, now);
  let closeYmd = naiveCutoffDate;
  if (ship && naiveShip && ship > naiveShip) {
    closeYmd = addDaysToYmd(ship, -1);
    if (closeYmd < naiveCutoffDate) closeYmd = naiveCutoffDate;
  }
  return cutoffBucketFromParts(closeYmd, timeHm);
}

/**
 * Начало окна накопления заказов для bucket с отсечкой.
 * При склейке по дате приезда — после отсечки предыдущего «другого» ship.
 */
function getProcurementWindowStart(cutoff, weekends, now = new Date(), supplierWarehouse = null) {
  if (!cutoff) return null;
  const normalizedWeekends = normalizeWeekendDays(weekends);

  if (supplierWarehouse && normalizedWeekends.length) {
    const ship = shipYmdFromCutoffDate(
      cutoff.date,
      supplierWarehouse,
      normalizedWeekends,
      now
    );
    let earliest = cutoff.date;
    for (let guard = 0; guard < 14; guard += 1) {
      const prev = addDaysToYmd(earliest, -1);
      const prevShip = shipYmdFromCutoffDate(prev, supplierWarehouse, normalizedWeekends, now);
      if (prevShip !== ship) break;
      earliest = prev;
    }
    return { date: addDaysToYmd(earliest, -1), time: cutoff.time };
  }

  if (!normalizedWeekends.length) {
    return { date: addDaysToYmd(cutoff.date, -1), time: cutoff.time };
  }

  if (isWeekendWeekday(weekdayForYmd(cutoff.date, now), normalizedWeekends)) {
    let prev = addDaysToYmd(cutoff.date, -1);
    for (let guard = 0; guard < 14; guard += 1) {
      if (!isWeekendWeekday(weekdayForYmd(prev, now), normalizedWeekends)) {
        return { date: prev, time: cutoff.time };
      }
      prev = addDaysToYmd(prev, -1);
    }
  }

  return { date: addDaysToYmd(cutoff.date, -1), time: cutoff.time };
}

/**
 * Mikado: СПБ до 14:00 — в ту же закупку, что и Москва (окно Москвы).
 */
function applyWarehouseSharingRules(warehouse, rows, now, supplierCode) {
  const code = String(supplierCode || '').toLowerCase();
  const name = normalizeWarehouseNameKey(warehouse?.name);
  const mins = getMoscowMinutesOfDay(now);

  if (code === 'mikado' && name.includes('спб')) {
    if (mins <= timeToMinutes('14:00')) {
      const moscow = findWarehouseByNameKey(rows, 'москва', 'moscow', 'москва2');
      if (moscow) return moscow;
    }
  }
  return warehouse;
}

/**
 * Склад поставщика, по которому определяется окно закупки.
 */
function resolveWarehouseByNameHint(rows, supplierWarehouseName) {
  const hint = normalizeWarehouseNameKey(supplierWarehouseName);
  if (!hint) return null;
  const direct = findWarehouseByNameKey(rows, supplierWarehouseName);
  if (direct) return direct;
  return (
    rows.find((w) => {
      const n = normalizeWarehouseNameKey(w.name);
      return n === hint || n.includes(hint) || hint.includes(n);
    }) || null
  );
}

export function resolveWarehouseForProcurementBucket(
  warehouses,
  now = new Date(),
  supplierCode = null,
  supplierWarehouseName = null
) {
  const rows = normalizeSupplierConfigWarehouses(Array.isArray(warehouses) ? warehouses : []);
  if (!rows.length) return null;

  const hinted = resolveWarehouseByNameHint(rows, supplierWarehouseName);
  if (hinted) {
    return applyWarehouseSharingRules(hinted, rows, now, supplierCode);
  }

  const mins = getMoscowMinutesOfDay(now);

  for (const w of rows) {
    const after = w.timeAfter || '00:00';
    if (isMinutesInWarehouseWindow(mins, after, w.time)) {
      return applyWarehouseSharingRules(w, rows, now, supplierCode);
    }
  }

  const code = String(supplierCode || '').toLowerCase();
  if (code === 'mikado') {
    const moscow = findWarehouseByNameKey(rows, 'москва', 'moscow');
    if (moscow) return moscow;
  }

  let best = null;
  let bestUntil = -1;
  for (const w of rows) {
    const until = timeToMinutes(w.time, 0);
    if (mins > until && until >= bestUntil) {
      bestUntil = until;
      best = w;
    }
  }
  return best || rows[0];
}

/** Bucket закрытия текущего окна заказа: cutoff:YYYY-MM-DD:HH:MM */
export function computeClosingCutoffBucket(warehouse, now = new Date()) {
  const until = normalizeWarehouseTime(warehouse?.time, '18:00');
  const untilMins = timeToMinutes(until);
  const mins = getMoscowMinutesOfDay(now);
  let closeYmd = getMoscowDateParts(now, 0).ymd;
  if (mins > untilMins) {
    closeYmd = getMoscowDateParts(now, 1).ymd;
  }
  return cutoffBucketFromParts(closeYmd, until);
}

/**
 * Bucket по окнам поставщика (без выходных нашего склада): today | tomorrow.
 * @deprecated Используйте resolveProcurementArrivalBucketWithCalendar — cutoff-bucket.
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
 * Заказы с одной датой приезда на наш склад (после сдвига с выходных) — одна закупка.
 *
 * Пример Mikado (отсечка 21:00, arrival=tomorrow) + выходные сб/вс:
 * после чт 21:00 наивное окно — пт, приезд сб→пн → копим до вс 21:00 (чт вечер…вс).
 */
export function resolveProcurementArrivalBucketWithCalendar(
  warehouses,
  {
    now = new Date(),
    warehouseWeekendDays = null,
    supplierCode = null,
    supplierWarehouseName = null,
  } = {}
) {
  const w = resolveWarehouseForProcurementBucket(
    warehouses,
    now,
    supplierCode,
    supplierWarehouseName
  );
  if (!w) return SUPPLIER_ARRIVAL_TODAY;

  const until = normalizeWarehouseTime(w.time, '18:00');
  const weekends = normalizeWeekendDays(warehouseWeekendDays);
  const naiveBucket = computeClosingCutoffBucket(w, now);
  const parsed = parseCutoffBucket(naiveBucket);
  if (!parsed) return naiveBucket;

  if (!weekends.length) return naiveBucket;

  return (
    collapseCutoffDateForSameShip(parsed.date, parsed.time || until, w, weekends, now) ||
    naiveBucket
  );
}

export function resolveProcurementArrivalBucketFromApiConfig(
  apiConfig,
  now = new Date(),
  warehouseWeekendDays = null,
  supplierCode = null,
  supplierWarehouseName = null
) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const code =
    supplierCode ??
    cfg.supplierCode ??
    cfg.supplier_code ??
    null;
  return resolveProcurementArrivalBucketWithCalendar(cfg.warehouses, {
    now,
    warehouseWeekendDays,
    supplierCode: code,
    supplierWarehouseName,
  });
}

/** Дата в Europe/Moscow как YYYY-MM-DD. */
export function formatMoscowDate(now = new Date(), dayOffset = 0) {
  return getMoscowDateParts(now, dayOffset).ymd;
}

function dayOffsetForYmd(now, targetYmd) {
  for (let off = 0; off <= 21; off += 1) {
    if (getMoscowDateParts(now, off).ymd === targetYmd) return off;
  }
  for (let off = -1; off >= -7; off -= 1) {
    if (getMoscowDateParts(now, off).ymd === targetYmd) return off;
  }
  return 0;
}

function shipYmdFromCutoffBucket(bucket, warehouse, now = new Date(), warehouseWeekendDays = null) {
  const parsed = parseCutoffBucket(bucket);
  if (!parsed || !warehouse) return null;
  return shipYmdFromCutoffDate(parsed.date, warehouse, warehouseWeekendDays, now);
}

/** Склад поставщика, определивший bucket (для ship_date / planned_delivery). */
export function pickActiveSupplierWarehouse(
  apiConfig,
  now = new Date(),
  warehouseWeekendDays = null,
  supplierCode = null,
  supplierWarehouseName = null
) {
  const cfg = apiConfig && typeof apiConfig === 'object' ? apiConfig : {};
  const code =
    supplierCode ??
    cfg.supplierCode ??
    cfg.supplier_code ??
    null;
  const rows = normalizeSupplierConfigWarehouses(Array.isArray(cfg.warehouses) ? cfg.warehouses : []);
  const warehouse = resolveWarehouseForProcurementBucket(rows, now, code, supplierWarehouseName);
  const bucket = resolveProcurementArrivalBucketWithCalendar(rows, {
    now,
    warehouseWeekendDays,
    supplierCode: code,
    supplierWarehouseName,
  });
  return { warehouse, bucket };
}

/**
 * @param {number} [deliveryDays] delivery_days из supplier_stocks
 * @param {number[]|null} [warehouseWeekendDays] warehouses.weekend_days
 */
export function computeProcurementDates(
  apiConfig,
  now = new Date(),
  deliveryDays = 0,
  warehouseWeekendDays = null,
  supplierCode = null,
  supplierWarehouseName = null
) {
  const { warehouse, bucket } = pickActiveSupplierWarehouse(
    apiConfig,
    now,
    warehouseWeekendDays,
    supplierCode,
    supplierWarehouseName
  );

  let shipDayOffset = 0;
  const shipFromCutoff = shipYmdFromCutoffBucket(bucket, warehouse, now, warehouseWeekendDays);
  if (shipFromCutoff) {
    shipDayOffset = dayOffsetForYmd(now, shipFromCutoff);
  } else {
    const shipFromBucket = shipDateFromArrivalBucket(bucket);
    if (shipFromBucket) {
      shipDayOffset = dayOffsetForYmd(now, shipFromBucket);
    } else if (bucket === SUPPLIER_ARRIVAL_TOMORROW) {
      shipDayOffset = 1;
    }
  }

  const shipDate = formatMoscowDate(now, shipDayOffset);
  const lead = Math.max(0, Math.floor(Number(deliveryDays) || 0));
  const plannedDeliveryDate = formatMoscowDate(now, shipDayOffset + lead);
  const resolvedWarehouseName = warehouse?.name ? String(warehouse.name).trim() : null;

  return {
    shipDate,
    plannedDeliveryDate,
    arrivalBucket: bucket,
    supplierWarehouseName: resolvedWarehouseName,
  };
}

/**
 * Плановая дата прихода на склад по окнам приёма заказа (time / arrivalDay в api_config)
 * и delivery_days из supplier_stocks. Для сравнения поставщиков при равном сроке доставки.
 */
export function plannedDeliveryYmdForSupplier(
  apiConfig,
  {
    now = new Date(),
    deliveryDays = 0,
    warehouseWeekendDays = null,
    supplierCode = null,
    supplierWarehouseName = null,
  } = {}
) {
  try {
    const dates = computeProcurementDates(
      apiConfig,
      now,
      deliveryDays,
      warehouseWeekendDays,
      supplierCode,
      supplierWarehouseName
    );
    const ymd = String(dates?.plannedDeliveryDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  } catch {
    /* ignore */
  }
  return '9999-12-31';
}
