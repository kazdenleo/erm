/**
 * Общие утилиты виджетов главной: форматирование, периоды, кэш запросов.
 */

export function formatRub(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(n);
}

/** Крупные суммы для KPI — без копеек. */
export function formatRubShort(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Math.round(Number(n)));
}

export function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

export function formatPercent(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(n))}%`;
}

/** Сумма в рублях для плашки (целое число; суффикс «руб.» выводим отдельно мелким шрифтом) */
export function formatRubAmountInt(n) {
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Math.round(n));
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ym(d) {
  return ymd(d).slice(0, 7);
}

export const DAY_PERIODS = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'month', label: 'Текущий месяц' },
  { value: 'prev_month', label: 'Прошлый месяц' },
];

export const MONTH_PERIODS = [
  { value: 'month', label: 'Текущий месяц' },
  { value: 'prev_month', label: 'Прошлый месяц' },
  { value: '3m', label: '3 месяца' },
  { value: 'year', label: 'С начала года' },
];

export function periodLabel(options, value) {
  return options.find((o) => o.value === value)?.label || '';
}

/** Диапазон дат YYYY-MM-DD для периода виджета. */
export function dayRange(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (days) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  switch (period) {
    case 'today':
      return { dateFrom: ymd(today), dateTo: ymd(today) };
    case 'yesterday':
      return { dateFrom: ymd(shift(-1)), dateTo: ymd(shift(-1)) };
    case '7d':
      return { dateFrom: ymd(shift(-6)), dateTo: ymd(today) };
    case 'month':
      return { dateFrom: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), dateTo: ymd(today) };
    case 'prev_month':
      return {
        dateFrom: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        dateTo: ymd(new Date(today.getFullYear(), today.getMonth(), 0)),
      };
    case '30d':
    default:
      return { dateFrom: ymd(shift(-29)), dateTo: ymd(today) };
  }
}

/** Диапазон месяцев YYYY-MM для ОПиУ. */
export function monthRange(period) {
  const now = new Date();
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  switch (period) {
    case 'prev_month': {
      const p = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
      return { monthFrom: ym(p), monthTo: ym(p) };
    }
    case '3m':
      return { monthFrom: ym(new Date(cur.getFullYear(), cur.getMonth() - 2, 1)), monthTo: ym(cur) };
    case 'year':
      return { monthFrom: ym(new Date(cur.getFullYear(), 0, 1)), monthTo: ym(cur) };
    case 'month':
    default:
      return { monthFrom: ym(cur), monthTo: ym(cur) };
  }
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

/**
 * Общий запрос для нескольких виджетов (например, сводка остатков для «Товаров» и «Остатков»):
 * параллельные вызовы с тем же ключом получают один промис.
 */
export function cachedLoad(key, loader, { force = false } = {}) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = Promise.resolve()
    .then(loader)
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

export function errorMessage(e, fallback) {
  return e?.response?.data?.message || e?.response?.data?.error || e?.message || fallback;
}
