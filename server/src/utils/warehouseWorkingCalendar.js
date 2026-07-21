/**
 * Рабочий календарь нашего склада (выходные) для планирования закупок.
 * Дни недели: 0 = воскресенье … 6 = суббота (как Date.getUTCDay на дате в Moscow).
 */

/** @typedef {0|1|2|3|4|5|6} Weekday */

const VALID_WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

/**
 * @param {unknown} value
 * @returns {Weekday[]}
 */
export function normalizeWeekendDays(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  const out = new Set();
  for (const raw of list) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && VALID_WEEKDAYS.has(n)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** YYYY-MM-DD и день недели (0–6) в Europe/Moscow. */
export function getMoscowDateParts(now = new Date(), dayOffset = 0) {
  const d = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const ymd = fmt.format(d);
  const weekdayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow',
    weekday: 'short',
  });
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wdShort = weekdayFmt.format(d).slice(0, 3);
  return { ymd, weekday: wdMap[wdShort] ?? 0 };
}

export function isWeekendWeekday(weekday, weekendDays) {
  const set = new Set(normalizeWeekendDays(weekendDays));
  if (!set.size) return false;
  return set.has(Number(weekday));
}

/**
 * Смещение в днях от now до первого рабочего дня, начиная с startOffset.
 * @param {Date} now
 * @param {Weekday[]} weekendDays
 * @param {number} startOffset
 * @returns {number}
 */
export function findWorkingDayOffset(now = new Date(), weekendDays = [], startOffset = 0) {
  const weekends = normalizeWeekendDays(weekendDays);
  if (!weekends.length) return Math.max(0, startOffset);

  let offset = Math.max(0, startOffset);
  for (let guard = 0; guard < 14; guard += 1) {
    const { weekday } = getMoscowDateParts(now, offset);
    if (!isWeekendWeekday(weekday, weekends)) return offset;
    offset += 1;
  }
  return Math.max(0, startOffset);
}

/** День недели (0–6) для YYYY-MM-DD в Europe/Moscow. */
export function weekdayForYmd(ymd, now = new Date()) {
  const target = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return getMoscowDateParts(now, 0).weekday;
  for (let off = -14; off <= 28; off += 1) {
    const parts = getMoscowDateParts(now, off);
    if (parts.ymd === target) return parts.weekday;
  }
  const [y, mo, d] = target.split('-').map((x) => parseInt(x, 10));
  return getMoscowDateParts(new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)), 0).weekday;
}

/**
 * Последний день подряд идущих выходных, начиная с startYmd (если startYmd — выходной).
 * Пример: сб+вс → с субботы вернёт воскресенье.
 */
export function findLastConsecutiveWeekendDay(startYmd, weekendDays, now = new Date()) {
  const weekends = normalizeWeekendDays(weekendDays);
  const ymd = String(startYmd || '').trim();
  if (!weekends.length || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  if (!isWeekendWeekday(weekdayForYmd(ymd, now), weekends)) return ymd;

  let last = ymd;
  let cursor = ymd;
  for (let guard = 0; guard < 7; guard += 1) {
    const next = addDaysToYmd(cursor, 1);
    if (!isWeekendWeekday(weekdayForYmd(next, now), weekends)) break;
    last = next;
    cursor = next;
  }
  return last;
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
 * @param {'today'|'tomorrow'} naiveBucket — bucket по окнам поставщика (до учёта выходных)
 * @param {Weekday[]} weekendDays
 * @param {Date} [now]
 * @returns {{ shipDayOffset: number, shipDate: string, weekday: number }}
 */
export function resolveShipDayOffsetFromNaiveBucket(naiveBucket, weekendDays = [], now = new Date()) {
  const weekends = normalizeWeekendDays(weekendDays);
  let startOffset = naiveBucket === 'tomorrow' ? 1 : 0;

  if (!weekends.length) {
    const parts = getMoscowDateParts(now, startOffset);
    return { shipDayOffset: startOffset, shipDate: parts.ymd, weekday: parts.weekday };
  }

  const shipDayOffset = findWorkingDayOffset(now, weekends, startOffset);
  const parts = getMoscowDateParts(now, shipDayOffset);
  return { shipDayOffset, shipDate: parts.ymd, weekday: parts.weekday };
}
