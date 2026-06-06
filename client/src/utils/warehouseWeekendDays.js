/** 0 = воскресенье … 6 = суббота */
export const WEEKDAY_OPTIONS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
];

export function normalizeWeekendDays(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [];
  const out = new Set();
  for (const raw of list) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 6) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function formatWeekendDaysLabel(days) {
  const normalized = normalizeWeekendDays(days);
  if (!normalized.length) return '—';
  const byValue = new Map(WEEKDAY_OPTIONS.map((o) => [o.value, o.label]));
  return normalized.map((d) => byValue.get(d) || String(d)).join(', ');
}
