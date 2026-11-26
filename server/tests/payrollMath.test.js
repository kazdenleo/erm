import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMonthlySalary,
  calculatePeriodSalary,
  isWorkingDay,
  listWorkingDaysInMonth,
  listWorkingDaysInRange,
} from '../src/utils/payrollMath.js';

test('isWorkingDay: weekends are not working', () => {
  assert.equal(isWorkingDay('2026-11-23'), true); // пн
  assert.equal(isWorkingDay('2026-11-28'), false); // сб
  assert.equal(isWorkingDay('2026-11-29'), false); // вс
});

test('listWorkingDaysInMonth counts weekdays only', () => {
  const days = listWorkingDaysInMonth('2026-11');
  assert.equal(days.length, 21);
  assert.ok(days.includes('2026-11-02'));
  assert.ok(!days.includes('2026-11-01')); // вс
});

test('calculateMonthlySalary prorates by missed working days', () => {
  const calc = calculateMonthlySalary({
    baseSalary: 100000,
    yearMonth: '2026-11',
    absenceDates: ['2026-11-02', '2026-11-03', '2026-11-01'], // вс игнорируется
  });
  assert.equal(calc.workingDaysCount, 21);
  assert.equal(calc.missedDays, 2);
  assert.equal(calc.workedDays, 19);
  assert.equal(calc.salary, Math.round(((100000 * 19) / 21) * 100) / 100);
});

test('listWorkingDaysInRange: half month', () => {
  const days = listWorkingDaysInRange('2026-11-01', '2026-11-15');
  // 2–6, 9–13 = 10 рабочих
  assert.equal(days.length, 10);
});

test('calculatePeriodSalary: partial month uses full-month denominator', () => {
  // 1–15 ноября 2026: 10 рабочих, без пропусков
  // оклад 100000, месяц 21 рабочий → 100000 * 10 / 21
  const calc = calculatePeriodSalary({
    baseSalary: 100000,
    dateFrom: '2026-11-01',
    dateTo: '2026-11-15',
    absenceDates: [],
  });
  assert.equal(calc.workingDaysCount, 10);
  assert.equal(calc.monthWorkingDaysCount, 21);
  assert.equal(calc.missedDays, 0);
  assert.equal(calc.workedDays, 10);
  assert.equal(calc.salary, Math.round(((100000 * 10) / 21) * 100) / 100);
});

test('calculatePeriodSalary: misses in range reduce pay', () => {
  const calc = calculatePeriodSalary({
    baseSalary: 100000,
    dateFrom: '2026-11-01',
    dateTo: '2026-11-15',
    absenceDates: ['2026-11-02', '2026-11-03'],
  });
  assert.equal(calc.workingDaysCount, 10);
  assert.equal(calc.missedDays, 2);
  assert.equal(calc.workedDays, 8);
  assert.equal(calc.salary, Math.round(((100000 * 8) / 21) * 100) / 100);
});

test('calculatePeriodSalary: spans two months', () => {
  // 16 ноя – 15 дек 2026
  // ноя: рабочие 16–20, 23–27, 30 = 11 дней, месяц 21
  // дек: 1–4, 7–11, 14–15 = 11 дней, месяц 23 (дек 2026)
  const novDays = listWorkingDaysInRange('2026-11-16', '2026-11-30');
  const decDays = listWorkingDaysInRange('2026-12-01', '2026-12-15');
  const novMonth = listWorkingDaysInMonth('2026-11').length;
  const decMonth = listWorkingDaysInMonth('2026-12').length;

  const calc = calculatePeriodSalary({
    baseSalary: 100000,
    dateFrom: '2026-11-16',
    dateTo: '2026-12-15',
    absenceDates: [],
  });

  assert.equal(calc.workingDaysCount, novDays.length + decDays.length);
  assert.equal(calc.months.length, 2);
  const expected =
    Math.round(((100000 * novDays.length) / novMonth) * 100) / 100 +
    Math.round(((100000 * decDays.length) / decMonth) * 100) / 100;
  assert.equal(calc.salary, Math.round(expected * 100) / 100);
});
