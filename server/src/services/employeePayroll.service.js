/**
 * Оклады и расчёт зарплаты сотрудников.
 */

import repositoryFactory from '../config/repository-factory.js';
import absencesRepo from '../repositories/employeeAbsences.repository.pg.js';
import {
  calculateMonthlySalary,
  currentYearMonth,
  isWorkingDay,
  parseMoney,
  parseYearMonth,
} from '../utils/payrollMath.js';

const usersRepo = repositoryFactory.getUsersRepository();

function displayName(user) {
  const parts = [user?.last_name, user?.first_name, user?.middle_name]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (parts.length) return parts.join(' ');
  return String(user?.full_name || user?.phone || user?.email || `Пользователь #${user?.id || ''}`).trim();
}

function normalizeYearMonth(yearMonth) {
  const ym = String(yearMonth || '').trim() || currentYearMonth();
  if (!parseYearMonth(ym)) {
    const err = new Error('Укажите месяц в формате YYYY-MM');
    err.status = 400;
    throw err;
  }
  return ym;
}

export async function getPayrollSummary({ profileId, yearMonth }) {
  const ym = normalizeYearMonth(yearMonth);
  const users = await usersRepo.findAll({ profileId });
  const absences = await absencesRepo.listForProfileMonth(profileId, ym);
  const byUser = new Map();
  for (const row of absences) {
    const uid = Number(row.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(row.absence_date);
  }

  const employees = users.map((u) => {
    const calc = calculateMonthlySalary({
      baseSalary: u.base_salary,
      yearMonth: ym,
      absenceDates: byUser.get(Number(u.id)) || [],
    });
    return {
      userId: Number(u.id),
      name: displayName(u),
      phone: u.phone || null,
      email: u.email || null,
      accountRole: u.account_role || null,
      baseSalary: calc.baseSalary,
      missedDays: calc.missedDays,
      workedDays: calc.workedDays,
      workingDaysCount: calc.workingDaysCount,
      salary: calc.salary,
      absenceDates: calc.absenceDates,
    };
  });

  employees.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));

  const totalSalary = employees.reduce((sum, e) => sum + (e.salary != null ? Number(e.salary) : 0), 0);

  return {
    yearMonth: ym,
    workingDaysCount: employees[0]?.workingDaysCount ?? calculateMonthlySalary({ yearMonth: ym }).workingDaysCount,
    employees,
    totals: {
      employees: employees.length,
      withSalary: employees.filter((e) => e.baseSalary != null).length,
      salary: Math.round(totalSalary * 100) / 100,
    },
  };
}

export async function getUserPayrollMonth({ profileId, userId, yearMonth }) {
  const ym = normalizeYearMonth(yearMonth);
  const user = await usersRepo.findById(userId);
  if (!user || Number(user.profile_id) !== Number(profileId) || user.role === 'admin') {
    const err = new Error('Пользователь не найден');
    err.status = 404;
    throw err;
  }
  const absences = await absencesRepo.listForUserMonth(userId, ym);
  const calc = calculateMonthlySalary({
    baseSalary: user.base_salary,
    yearMonth: ym,
    absenceDates: absences.map((a) => a.absence_date),
  });
  return {
    userId: Number(user.id),
    name: displayName(user),
    ...calc,
  };
}

export async function setUserAbsencesMonth({
  profileId,
  userId,
  yearMonth,
  dates,
  createdByUserId = null,
}) {
  const ym = normalizeYearMonth(yearMonth);
  const user = await usersRepo.findById(userId);
  if (!user || Number(user.profile_id) !== Number(profileId) || user.role === 'admin') {
    const err = new Error('Пользователь не найден');
    err.status = 404;
    throw err;
  }
  const filtered = (dates || [])
    .map((d) => String(d || '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d.startsWith(`${ym}-`) && isWorkingDay(d));

  await absencesRepo.replaceMonthDays({
    profileId,
    userId,
    yearMonth: ym,
    dates: filtered,
    createdByUserId,
  });

  return getUserPayrollMonth({ profileId, userId, yearMonth: ym });
}

export async function toggleUserAbsenceDay({
  profileId,
  userId,
  date,
  present = null,
  createdByUserId = null,
}) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const err = new Error('Укажите дату в формате YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  if (!isWorkingDay(day)) {
    const err = new Error('Отмечать можно только рабочие дни (пн–пт)');
    err.status = 400;
    throw err;
  }
  const user = await usersRepo.findById(userId);
  if (!user || Number(user.profile_id) !== Number(profileId) || user.role === 'admin') {
    const err = new Error('Пользователь не найден');
    err.status = 404;
    throw err;
  }

  const ym = day.slice(0, 7);
  const existing = await absencesRepo.listForUserMonth(userId, ym);
  const has = existing.some((a) => a.absence_date === day);
  const shouldAbsent = present == null ? !has : !present;

  if (shouldAbsent && !has) {
    await absencesRepo.addDay({
      profileId,
      userId,
      absenceDate: day,
      createdByUserId,
    });
  } else if (!shouldAbsent && has) {
    await absencesRepo.removeDay(userId, day);
  }

  return getUserPayrollMonth({ profileId, userId, yearMonth: ym });
}

export function parseBaseSalaryInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = parseMoney(value);
  if (n == null) {
    const err = new Error('Оклад должен быть числом ≥ 0');
    err.status = 400;
    throw err;
  }
  return n;
}
