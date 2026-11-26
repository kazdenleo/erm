/**
 * Вкладка «Зарплата»: оклады, пропуски, расчёт за выбранный период.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toIsoLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

function monthBounds(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    dateFrom: `${ym}-01`,
    dateTo: `${ym}-${pad2(last)}`,
  };
}

function defaultPeriod() {
  return monthBounds(currentYearMonth());
}

function shiftYearMonth(ym, delta) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function formatMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

function formatDateRu(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU');
}

function monthTitle(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const title = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  });
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function isWorkingIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow >= 1 && dow <= 5;
}

function periodPresets() {
  const now = new Date();
  const today = toIsoLocal(now);
  const thisMonth = monthBounds(currentYearMonth());
  const prevMonth = monthBounds(shiftYearMonth(currentYearMonth(), -1));

  const dow = (now.getDay() + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dow);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);

  const last7Start = new Date(now);
  last7Start.setDate(now.getDate() - 6);

  return [
    { id: 'this-month', label: 'Этот месяц', ...thisMonth },
    { id: 'prev-month', label: 'Прошлый месяц', ...prevMonth },
    { id: 'this-week', label: 'Эта неделя', dateFrom: toIsoLocal(weekStart), dateTo: toIsoLocal(weekEnd) },
    { id: 'last-7', label: '7 дней', dateFrom: toIsoLocal(last7Start), dateTo: today },
    { id: 'month-to-date', label: 'С начала месяца', dateFrom: thisMonth.dateFrom, dateTo: today },
  ];
}

function buildMonthGrid(yearMonth, absenceDates, periodFrom, periodTo) {
  const [y, m] = String(yearMonth).split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const start = (first.getDay() + 6) % 7;
  const absences = new Set(absenceDates || []);
  const cells = [];
  for (let i = 0; i < start; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${yearMonth}-${pad2(day)}`;
    const isWorking = isWorkingIso(iso);
    cells.push({
      day,
      iso,
      isWorking,
      isAbsent: absences.has(iso),
      inPeriod: (!periodFrom || iso >= periodFrom) && (!periodTo || iso <= periodTo),
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function EmployeePayrollTab() {
  const { profileId, isTenantAccountAdmin } = useAuth();
  const initial = useMemo(() => defaultPeriod(), []);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [calMonth, setCalMonth] = useState(currentYearMonth);
  const [calAbsences, setCalAbsences] = useState([]);
  const [saving, setSaving] = useState(false);
  const [salaryEdit, setSalaryEdit] = useState(null);
  const [salaryValue, setSalaryValue] = useState('');
  const [salarySaving, setSalarySaving] = useState(false);

  const period = useMemo(() => ({ dateFrom, dateTo }), [dateFrom, dateTo]);
  const presets = useMemo(() => periodPresets(), []);

  const load = useCallback(async () => {
    if (!isTenantAccountAdmin) {
      setLoading(false);
      setError('Зарплата доступна только администратору аккаунта');
      setSummary(null);
      return;
    }
    if (!dateFrom || !dateTo) {
      setError('Укажите период');
      setSummary(null);
      setLoading(false);
      return;
    }
    if (dateFrom > dateTo) {
      setError('Дата «с» не может быть позже даты «по»');
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await usersApi.getPayroll(period, profileId);
      setSummary(res?.data || null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, period, profileId, isTenantAccountAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const loadCalMonthAbsences = useCallback(
    async (userId, ym) => {
      try {
        const res = await usersApi.getUserPayroll(userId, { yearMonth: ym }, profileId);
        setCalAbsences(res?.data?.absenceDates || []);
      } catch {
        setCalAbsences([]);
      }
    },
    [profileId]
  );

  const applyPreset = (p) => {
    setDateFrom(p.dateFrom);
    setDateTo(p.dateTo);
    setCalMonth(String(p.dateFrom).slice(0, 7));
  };

  const openEmployee = async (row) => {
    setSelected(row);
    setDetail(null);
    const ym = String(dateFrom).slice(0, 7) || currentYearMonth();
    setCalMonth(ym);
    setDetailLoading(true);
    try {
      const res = await usersApi.getUserPayroll(row.userId, period, profileId);
      setDetail(res?.data || null);
      await loadCalMonthAbsences(row.userId, ym);
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Не удалось загрузить пропуски');
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const shiftCalMonth = async (delta) => {
    if (!selected) return;
    const next = shiftYearMonth(calMonth, delta);
    setCalMonth(next);
    await loadCalMonthAbsences(selected.userId, next);
  };

  const closeDetail = () => {
    if (saving) return;
    setSelected(null);
    setDetail(null);
    setCalAbsences([]);
  };

  const toggleDay = async (iso) => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const res = await usersApi.toggleUserAbsence(
        selected.userId,
        { date: iso, dateFrom: period.dateFrom, dateTo: period.dateTo },
        profileId
      );
      setDetail(res?.data || null);
      const ym = String(iso).slice(0, 7);
      if (ym === calMonth) {
        setCalAbsences((prev) => {
          const set = new Set(prev);
          if (set.has(iso)) set.delete(iso);
          else set.add(iso);
          return Array.from(set).sort();
        });
      }
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

  const calGrid = useMemo(
    () => buildMonthGrid(calMonth, calAbsences, dateFrom, dateTo),
    [calMonth, calAbsences, dateFrom, dateTo]
  );

  return (
    <div className="employee-payroll">
      <p className="employee-payroll__hint">
        Зарплата за период: по каждому месяцу оклад × отработанные дни периода / рабочие дни полного
        месяца (пн–пт). Пропуски вычитаются из отработанных.
      </p>

      <div className="employee-payroll__toolbar">
        <div className="employee-payroll__period">
          <label className="employee-payroll__period-field">
            С
            <input
              type="date"
              className="login-input employee-payroll__date-input"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="employee-payroll__period-field">
            По
            <input
              type="date"
              className="login-input employee-payroll__date-input"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <div className="employee-payroll__presets">
            {presets.map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="secondary"
                size="small"
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
        {summary?.totals ? (
          <div className="employee-payroll__totals">
            {formatDateRu(summary.dateFrom)} — {formatDateRu(summary.dateTo)}
            {' · '}
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
                Период:{' '}
                <strong>
                  {formatDateRu(detail.dateFrom)} — {formatDateRu(detail.dateTo)}
                </strong>
              </div>
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
            <div className="employee-payroll__month">
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => shiftCalMonth(-1)}
              >
                ←
              </Button>
              <strong>{monthTitle(calMonth)}</strong>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => shiftCalMonth(1)}
              >
                →
              </Button>
            </div>
            <p className="employee-payroll__hint">
              Клик по рабочему дню отмечает или снимает пропуск. Дни вне выбранного периода
              затемнены.
            </p>
            <div className="employee-payroll__cal">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="employee-payroll__cal-head">
                  {label}
                </div>
              ))}
              {calGrid.map((cell, idx) => {
                if (!cell) {
                  return <div key={`e-${idx}`} className="employee-payroll__cal-empty" />;
                }
                const cls = [
                  'employee-payroll__cal-day',
                  cell.isWorking ? 'is-working' : 'is-weekend',
                  cell.isAbsent ? 'is-absent' : '',
                  !cell.inPeriod ? 'is-out-of-period' : '',
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
                      !cell.isWorking
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
