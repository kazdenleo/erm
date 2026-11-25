import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMonthlySalary,
  isWorkingDay,
  listWorkingDaysInMonth,
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
