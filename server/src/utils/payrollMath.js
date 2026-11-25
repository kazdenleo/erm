/**
 * Расчёт зарплаты от оклада по рабочим дням (пн–пт).
 */

function toDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const s = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateUtc(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Пн–пт = рабочие. */
export function isWorkingDay(dateLike) {
  const d = toDateOnly(dateLike);
  if (!d) return false;
  const dow = d.getUTCDay(); // 0 вс … 6 сб
  return dow >= 1 && dow <= 5;
}

export function parseYearMonth(yearMonth) {
  const s = String(yearMonth || '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  return { year, month };
}

export function currentYearMonth(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Список рабочих дней месяца (YYYY-MM-DD). */
export function listWorkingDaysInMonth(yearMonth) {
  const parsed = parseYearMonth(yearMonth);
  if (!parsed) return [];
  const { year, month } = parsed;
  const days = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= last; day += 1) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (isWorkingDay(d)) days.push(formatDateUtc(d));
  }
  return days;
}

export function parseMoney(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * @param {{ baseSalary: number|null, yearMonth: string, absenceDates?: string[] }} input
 */
export function calculateMonthlySalary(input) {
  const yearMonth = String(input?.yearMonth || '').trim();
  const workingDays = listWorkingDaysInMonth(yearMonth);
  const workingDaysCount = workingDays.length;
  const absenceSet = new Set(
    (input?.absenceDates || [])
      .map((d) => String(d || '').slice(0, 10))
      .filter((d) => workingDays.includes(d))
  );
  const missedDays = absenceSet.size;
  const workedDays = Math.max(0, workingDaysCount - missedDays);
  const baseSalary = parseMoney(input?.baseSalary);
  let salary = null;
  if (baseSalary != null && workingDaysCount > 0) {
    salary = Math.round(((baseSalary * workedDays) / workingDaysCount) * 100) / 100;
  } else if (baseSalary != null && workingDaysCount === 0) {
    salary = 0;
  }
  return {
    yearMonth,
    baseSalary,
    workingDaysCount,
    missedDays,
    workedDays,
    salary,
    workingDays,
    absenceDates: [...absenceSet].sort(),
  };
}
