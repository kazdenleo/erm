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
