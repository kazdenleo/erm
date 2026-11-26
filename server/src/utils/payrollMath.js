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

export function parseIsoDate(value) {
  return toDateOnly(value);
}

export function formatIsoDate(value) {
  const d = toDateOnly(value);
  return d ? formatDateUtc(d) : null;
}

/** Границы месяца YYYY-MM → { dateFrom, dateTo }. */
export function monthBounds(yearMonth) {
  const parsed = parseYearMonth(yearMonth);
  if (!parsed) return null;
  const { year, month } = parsed;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    dateFrom: `${yearMonth}-01`,
    dateTo: `${yearMonth}-${String(last).padStart(2, '0')}`,
  };
}

/** Список рабочих дней месяца (YYYY-MM-DD). */
export function listWorkingDaysInMonth(yearMonth) {
  const bounds = monthBounds(yearMonth);
  if (!bounds) return [];
  return listWorkingDaysInRange(bounds.dateFrom, bounds.dateTo);
}

/** Рабочие дни в диапазоне включительно. */
export function listWorkingDaysInRange(dateFrom, dateTo) {
  const from = toDateOnly(dateFrom);
  const to = toDateOnly(dateTo);
  if (!from || !to || from.getTime() > to.getTime()) return [];
  const days = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 24 * 60 * 60 * 1000) {
    const d = new Date(t);
    if (isWorkingDay(d)) days.push(formatDateUtc(d));
  }
  return days;
}

/** Месяцы, пересекающие диапазон (YYYY-MM). */
export function listYearMonthsInRange(dateFrom, dateTo) {
  const from = toDateOnly(dateFrom);
  const to = toDateOnly(dateTo);
  if (!from || !to || from.getTime() > to.getTime()) return [];
  const out = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

export function parseMoney(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Зарплата за период.
 * По каждому месяцу: оклад × отработанные_дни_периода_в_месяце / рабочие_дни_полного_месяца.
 * Так дневная ставка всегда от оклада текущего месяца.
 *
 * @param {{ baseSalary: number|null, dateFrom: string, dateTo: string, absenceDates?: string[] }} input
 */
export function calculatePeriodSalary(input) {
  const dateFrom = formatIsoDate(input?.dateFrom);
  const dateTo = formatIsoDate(input?.dateTo);
  const baseSalary = parseMoney(input?.baseSalary);
  const absenceAll = new Set(
    (input?.absenceDates || []).map((d) => String(d || '').slice(0, 10)).filter(Boolean)
  );

  if (!dateFrom || !dateTo) {
    return {
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      yearMonth: null,
      baseSalary,
      workingDaysCount: 0,
      monthWorkingDaysCount: 0,
      missedDays: 0,
      workedDays: 0,
      salary: baseSalary == null ? null : 0,
      workingDays: [],
      absenceDates: [],
      months: [],
    };
  }

  const months = [];
  let salarySum = 0;
  let workingDays = [];
  let missedDays = 0;
  let workedDays = 0;
  let monthWorkingDaysCount = 0;

  for (const ym of listYearMonthsInRange(dateFrom, dateTo)) {
    const bounds = monthBounds(ym);
    const monthWorking = listWorkingDaysInMonth(ym);
    const fromCmp = dateFrom > bounds.dateFrom ? dateFrom : bounds.dateFrom;
    const toCmp = dateTo < bounds.dateTo ? dateTo : bounds.dateTo;
    const periodWorking = listWorkingDaysInRange(fromCmp, toCmp);
    const missed = periodWorking.filter((d) => absenceAll.has(d));
    const worked = periodWorking.length - missed.length;
    const monthDenom = monthWorking.length;
    let monthSalary = null;
    if (baseSalary != null && monthDenom > 0) {
      monthSalary = Math.round(((baseSalary * worked) / monthDenom) * 100) / 100;
      salarySum += monthSalary;
    } else if (baseSalary != null) {
      monthSalary = 0;
    }

    months.push({
      yearMonth: ym,
      workingDaysCount: periodWorking.length,
      monthWorkingDaysCount: monthDenom,
      missedDays: missed.length,
      workedDays: worked,
      salary: monthSalary,
    });

    workingDays = workingDays.concat(periodWorking);
    missedDays += missed.length;
    workedDays += worked;
    monthWorkingDaysCount += monthDenom;
  }

  const absenceDates = workingDays.filter((d) => absenceAll.has(d)).sort();

  return {
    dateFrom,
    dateTo,
    yearMonth: months.length === 1 ? months[0].yearMonth : null,
    baseSalary,
    workingDaysCount: workingDays.length,
    monthWorkingDaysCount,
    missedDays,
    workedDays,
    salary: baseSalary == null ? null : Math.round(salarySum * 100) / 100,
    workingDays,
    absenceDates,
    months,
  };
}

/**
 * @param {{ baseSalary: number|null, yearMonth: string, absenceDates?: string[] }} input
 */
export function calculateMonthlySalary(input) {
  const yearMonth = String(input?.yearMonth || '').trim();
  const bounds = monthBounds(yearMonth);
  if (!bounds) {
    return calculatePeriodSalary({
      baseSalary: input?.baseSalary,
      dateFrom: null,
      dateTo: null,
      absenceDates: input?.absenceDates,
    });
  }
  const calc = calculatePeriodSalary({
    baseSalary: input?.baseSalary,
    dateFrom: bounds.dateFrom,
    dateTo: bounds.dateTo,
    absenceDates: input?.absenceDates,
  });
  return { ...calc, yearMonth };
}
