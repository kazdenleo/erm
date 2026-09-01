/**
 * Пресеты периода для аналитики продаж (FBO / FBS / категории).
 */

export function formatAnalyticsYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Последние N календарных дней включая сегодня. */
export function rangeLastDays(days) {
  const n = Math.max(1, Number(days) || 1);
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (n - 1));
  return { dateFrom: formatAnalyticsYmd(from), dateTo: formatAnalyticsYmd(to) };
}

export const ANALYTICS_PERIOD_PRESETS = [
  { value: '7', label: '7 дней', days: 7 },
  { value: '14', label: '14 дней', days: 14 },
  { value: '28', label: '28 дней', days: 28 },
  { value: 'custom', label: 'Период' },
];

export const DEFAULT_ANALYTICS_PERIOD = '28';

export function defaultAnalyticsRange(preset = DEFAULT_ANALYTICS_PERIOD) {
  const found = ANALYTICS_PERIOD_PRESETS.find((p) => p.value === preset && p.days);
  return rangeLastDays(found?.days || 28);
}

/** Определить пресет по текущим датам (если совпадает с «последние N дней»). */
export function detectAnalyticsPeriodPreset(dateFrom, dateTo) {
  const today = formatAnalyticsYmd(new Date());
  if (dateTo !== today) return 'custom';
  for (const p of ANALYTICS_PERIOD_PRESETS) {
    if (!p.days) continue;
    const range = rangeLastDays(p.days);
    if (range.dateFrom === dateFrom && range.dateTo === dateTo) return p.value;
  }
  return 'custom';
}

export function shiftDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Number(days || 0));
  return formatAnalyticsYmd(dt);
}

export function periodLengthDays(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/** Предыдущий отрезок той же длины сразу до dateFrom. */
export function previousPeriodOfSameLength(dateFrom, dateTo) {
  const len = periodLengthDays(dateFrom, dateTo);
  const prevTo = shiftDaysYmd(dateFrom, -1);
  const prevFrom = shiftDaysYmd(prevTo, -(len - 1));
  return { dateFrom: prevFrom, dateTo: prevTo };
}

/** Период действия: startYmd и следующие days календарных дней включая старт. */
export function rangeFromStartDays(startYmd, days) {
  const n = Math.max(1, Number(days) || 1);
  return { dateFrom: startYmd, dateTo: shiftDaysYmd(startYmd, n - 1) };
}
