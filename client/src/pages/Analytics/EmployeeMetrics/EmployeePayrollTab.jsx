/**
 * Вкладка «Зарплата» в разделе Сотрудники: оклады, пропуски, расчёт за месяц.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftYearMonth(ym, delta) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

function monthTitle(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const title = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  });
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function buildMonthGrid(yearMonth, workingDays, absenceDates) {
  const [y, m] = String(yearMonth).split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const start = (first.getDay() + 6) % 7;
  const working = new Set(workingDays || []);
  const absences = new Set(absenceDates || []);
  const cells = [];
  for (let i = 0; i < start; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${yearMonth}-${String(day).padStart(2, '0')}`;
    const isWorking = working.has(iso);
    cells.push({
      day,
      iso,
      isWorking,
      isWeekend: !isWorking,
      isAbsent: absences.has(iso),
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function EmployeePayrollTab() {
  const { profileId, isTenantAccountAdmin } = useAuth();
  const [yearMonth, setYearMonth] = useState(currentYearMonth);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [salaryEdit, setSalaryEdit] = useState(null);
  const [salaryValue, setSalaryValue] = useState('');
  const [salarySaving, setSalarySaving] = useState(false);

  const load = useCallback(async () => {
    if (!isTenantAccountAdmin) {
      setLoading(false);
      setError('Зарплата доступна только администратору аккаунта');
      setSummary(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await usersApi.getPayroll(yearMonth, profileId);
      setSummary(res?.data || null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [yearMonth, profileId, isTenantAccountAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const openEmployee = async (row) => {
    setSelected(row);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await usersApi.getUserPayroll(row.userId, yearMonth, profileId);
      setDetail(res?.data || null);
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Не удалось загрузить пропуски');
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    if (saving) return;
    setSelected(null);
    setDetail(null);
  };

  const toggleDay = async (iso) => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const res = await usersApi.toggleUserAbsence(selected.userId, { date: iso }, profileId);
      setDetail(res?.data || null);
      await load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Не удалось сохранить день');
    } finally {
      setSaving(false);
    }
  };

  const openSalaryEdit = (row) => {
    setSalaryEdit(row);
    setSalaryValue(row.baseSalary != null ? String(row.baseSalary) : '');
  };

  const saveSalary = async () => {
    if (!salaryEdit || salarySaving) return;
    setSalarySaving(true);
    try {
      const raw = String(salaryValue ?? '').trim();
      await usersApi.update(salaryEdit.userId, {
        baseSalary: raw === '' ? null : raw,
      });
      setSalaryEdit(null);
      await load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Не удалось сохранить оклад');
    } finally {
      setSalarySaving(false);
    }
  };

  const grid = useMemo(() => {
    if (!detail) return [];
    return buildMonthGrid(detail.yearMonth || yearMonth, detail.workingDays, detail.absenceDates);
  }, [detail, yearMonth]);

  return (
    <div className="employee-payroll">
      <p className="employee-payroll__hint">
        Зарплата = оклад × (рабочие дни − пропуски) / рабочие дни месяца. Рабочие дни — пн–пт.
      </p>

      <div className="employee-payroll__toolbar">
        <div className="employee-payroll__month">
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => setYearMonth((ym) => shiftYearMonth(ym, -1))}
          >
            ←
          </Button>
          <strong>{monthTitle(yearMonth)}</strong>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => setYearMonth((ym) => shiftYearMonth(ym, 1))}
          >
            →
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => setYearMonth(currentYearMonth())}
          >
            Сегодня
          </Button>
        </div>
        {summary?.totals ? (
          <div className="employee-payroll__totals">
            Рабочих дней: <strong>{summary.workingDaysCount}</strong>
            {' · '}
            С окладом: <strong>{summary.totals.withSalary}</strong>
            {' · '}
            Итого к выплате: <strong>{formatMoney(summary.totals.salary)}</strong>
          </div>
        ) : null}
      </div>

      {loading && <div className="sales-analytics__empty">Загрузка...</div>}
      {error && <div className="sales-analytics__error">{error}</div>}

      {!loading && !error && (
        <div className="sales-analytics__table-wrap">
          <table className="sales-analytics__table employee-payroll__table">
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th className="sales-analytics__num">Оклад</th>
                <th className="sales-analytics__num">Пропуски</th>
                <th className="sales-analytics__num">Отработано</th>
                <th className="sales-analytics__num">Зарплата</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(summary?.employees || []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    Сотрудников пока нет
                  </td>
                </tr>
              ) : (
                summary.employees.map((row) => (
                  <tr key={row.userId}>
                    <td>
                      <div className="employee-payroll__name">{row.name}</div>
                      {row.phone ? <div className="employee-payroll__phone">{row.phone}</div> : null}
                    </td>
                    <td className="sales-analytics__num">{formatMoney(row.baseSalary)}</td>
                    <td className="sales-analytics__num">{row.missedDays}</td>
                    <td className="sales-analytics__num">
                      {row.workedDays} / {row.workingDaysCount}
                    </td>
                    <td className="sales-analytics__num">
                      <strong>{formatMoney(row.salary)}</strong>
                    </td>
                    <td className="employee-payroll__actions">
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => openSalaryEdit(row)}
                      >
                        Оклад
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => openEmployee(row)}
                      >
                        Пропуски
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={!!salaryEdit}
        onClose={() => {
          if (!salarySaving) setSalaryEdit(null);
        }}
        title={salaryEdit ? `Оклад — ${salaryEdit.name}` : 'Оклад'}
        size="small"
      >
        <label className="employee-payroll__salary-label">
          Оклад, ₽
          <input
            type="number"
            min="0"
            step="0.01"
            className="login-input"
            style={{ width: '100%', marginTop: 4 }}
            value={salaryValue}
            onChange={(e) => setSalaryValue(e.target.value)}
            placeholder="например 80000"
            disabled={salarySaving}
          />
        </label>
        <div className="employee-payroll__modal-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setSalaryEdit(null)}
            disabled={salarySaving}
          >
            Отмена
          </Button>
          <Button type="button" variant="primary" onClick={saveSalary} disabled={salarySaving}>
            {salarySaving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={!!selected}
        onClose={closeDetail}
        title={selected ? `Пропуски — ${selected.name}` : 'Пропуски'}
        size="medium"
      >
        {detailLoading || !detail ? (
          <div className="sales-analytics__empty">Загрузка...</div>
        ) : (
          <div>
            <div className="employee-payroll__detail-summary">
              <div>
                Оклад: <strong>{formatMoney(detail.baseSalary)}</strong>
              </div>
              <div>
                Пропуски: <strong>{detail.missedDays}</strong> из {detail.workingDaysCount}
              </div>
              <div>
                Зарплата: <strong>{formatMoney(detail.salary)}</strong>
              </div>
            </div>
            <p className="employee-payroll__hint">
              Клик по рабочему дню отмечает или снимает пропуск. Выходные недоступны.
            </p>
            <div className="employee-payroll__cal">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="employee-payroll__cal-head">
                  {label}
                </div>
              ))}
              {grid.map((cell, idx) => {
                if (!cell) {
                  return <div key={`e-${idx}`} className="employee-payroll__cal-empty" />;
                }
                const cls = [
                  'employee-payroll__cal-day',
                  cell.isWeekend ? 'is-weekend' : '',
                  cell.isAbsent ? 'is-absent' : '',
                  cell.isWorking ? 'is-working' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <button
                    key={cell.iso}
                    type="button"
                    className={cls}
                    disabled={!cell.isWorking || saving}
                    title={
                      cell.isWeekend
                        ? 'Выходной'
                        : cell.isAbsent
                          ? 'Пропуск — нажмите, чтобы снять'
                          : 'Рабочий день — нажмите, чтобы отметить пропуск'
                    }
                    onClick={() => toggleDay(cell.iso)}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
            <div className="employee-payroll__modal-actions">
              <Button type="button" variant="secondary" onClick={closeDetail} disabled={saving}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
