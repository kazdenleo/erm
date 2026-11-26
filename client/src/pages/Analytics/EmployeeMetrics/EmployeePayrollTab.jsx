/**
 * Вкладка «Зарплата»: оклады, пропуски, расчёт за выбранный период.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { isNavFeatureEnabled } from '../../../utils/userNavSections.js';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { detectAnalyticsPeriodPreset } from '../shared/analyticsPeriod';

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

function payrollQuickRanges() {
  const now = new Date();
  const today = toIsoLocal(now);
  const ym = currentYearMonth();
  const thisMonth = monthBounds(ym);
  const prevYm = shiftYearMonth(ym, -1);
  const prevMonth = monthBounds(prevYm);
  const mid = `${ym}-15`;
  const from25 = `${prevYm}-25`;
  const to10 = `${ym}-10`;
  return [
    { id: 'this-month', label: 'Этот месяц', ...thisMonth },
    { id: 'prev-month', label: 'Прошлый месяц', ...prevMonth },
    { id: '1-15', label: '1–15', dateFrom: thisMonth.dateFrom, dateTo: mid },
    { id: '16-end', label: '16 — конец', dateFrom: `${ym}-16`, dateTo: thisMonth.dateTo },
    { id: '25-10', label: '25 → 10', dateFrom: from25, dateTo: to10 },
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
  const { profileId, isTenantAccountAdmin, isAdmin, features } = useAuth();
  const canPayroll =
    Boolean(isTenantAccountAdmin || isAdmin) || isNavFeatureEnabled(features, 'analytics_employees');
  const canEditBaseSalary = Boolean(isTenantAccountAdmin || isAdmin);
  const initial = useMemo(() => defaultPeriod(), []);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [periodPreset, setPeriodPreset] = useState('custom');
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
  const quickRanges = useMemo(() => payrollQuickRanges(), []);

  const load = useCallback(async () => {
    if (!canPayroll) {
      setLoading(false);
      setError('Нет доступа к разделу «Сотрудники» в правах роли');
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
  }, [dateFrom, dateTo, period, profileId, canPayroll]);

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

  const applyRange = (p) => {
    setPeriodPreset('custom');
    setDateFrom(p.dateFrom);
    setDateTo(p.dateTo);
    setCalMonth(String(p.dateFrom).slice(0, 7));
  };

  const onDateFromChange = (value) => {
    const next = String(value || '').slice(0, 10);
    setDateFrom(next);
    setPeriodPreset(detectAnalyticsPeriodPreset(next, dateTo));
    if (next) setCalMonth(next.slice(0, 7));
  };

  const onDateToChange = (value) => {
    const next = String(value || '').slice(0, 10);
    setDateTo(next);
    setPeriodPreset(detectAnalyticsPeriodPreset(dateFrom, next));
  };

  const loadEmployeeDetail = useCallback(
    async (row, nextPeriod) => {
      if (!row) return;
      const from = nextPeriod?.dateFrom || dateFrom;
      const to = nextPeriod?.dateTo || dateTo;
      const ym = String(from).slice(0, 7) || currentYearMonth();
      setDetailLoading(true);
      try {
        const res = await usersApi.getUserPayroll(row.userId, { dateFrom: from, dateTo: to }, profileId);
        setDetail(res?.data || null);
        setCalMonth(ym);
        await loadCalMonthAbsences(row.userId, ym);
      } catch (err) {
        alert(err?.response?.data?.message || err?.message || 'Не удалось загрузить пропуски');
        setSelected(null);
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [dateFrom, dateTo, profileId, loadCalMonthAbsences]
  );

  const openEmployee = async (row) => {
    setSelected(row);
    setDetail(null);
    await loadEmployeeDetail(row, period);
  };

  // Пересчёт в модалке при смене периода на странице / в самой модалке
  useEffect(() => {
    if (!selected) return;
    if (!dateFrom || !dateTo || dateFrom > dateTo) return;
    loadEmployeeDetail(selected, { dateFrom, dateTo });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при смене дат, не при смене selected
  }, [dateFrom, dateTo]);

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
        Укажите любые даты «С» / «По» — зарплата считается только за рабочие дни (пн–пт) внутри
        периода, пропуски вычитаются. Формула по каждому месяцу: оклад × отработанные дни периода /
        рабочие дни полного месяца.
      </p>

      <div className="sales-analytics__filters erp-filter-bar employee-payroll__filters">
        <AnalyticsPeriodFilters
          periodPreset={periodPreset}
          onPeriodPresetChange={setPeriodPreset}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={onDateFromChange}
          onDateToChange={onDateToChange}
        />
        <div className="employee-payroll__presets" role="group" aria-label="Быстрый период">
          {quickRanges.map((p) => {
            const active = dateFrom === p.dateFrom && dateTo === p.dateTo;
            return (
              <Button
                key={p.id}
                type="button"
                variant={active ? 'primary' : 'secondary'}
                size="small"
                onClick={() => applyRange(p)}
              >
                {p.label}
              </Button>
            );
          })}
        </div>
      </div>

      {summary?.totals ? (
        <div className="employee-payroll__totals">
          Расчёт: <strong>{formatDateRu(summary.dateFrom)}</strong>
          {' — '}
          <strong>{formatDateRu(summary.dateTo)}</strong>
          {' · '}
          Рабочих дней: <strong>{summary.workingDaysCount}</strong>
          {' · '}
          С окладом: <strong>{summary.totals.withSalary}</strong>
          {' · '}
          Итого к выплате: <strong>{formatMoney(summary.totals.salary)}</strong>
        </div>
      ) : null}

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
                      {canEditBaseSalary ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          onClick={() => openSalaryEdit(row)}
                        >
                          Оклад
                        </Button>
                      ) : null}
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
        {detailLoading && !detail ? (
          <div className="sales-analytics__empty">Загрузка...</div>
        ) : (
          <div>
            <div className="employee-payroll__modal-period">
              <label className="employee-payroll__modal-period-field">
                <span>С</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => onDateFromChange(e.target.value)}
                  disabled={saving || detailLoading}
                />
              </label>
              <label className="employee-payroll__modal-period-field">
                <span>По</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => onDateToChange(e.target.value)}
                  disabled={saving || detailLoading}
                />
              </label>
              <div className="employee-payroll__presets">
                {quickRanges.slice(0, 5).map((p) => {
                  const active = dateFrom === p.dateFrom && dateTo === p.dateTo;
                  return (
                    <Button
                      key={p.id}
                      type="button"
                      variant={active ? 'primary' : 'secondary'}
                      size="small"
                      disabled={saving || detailLoading}
                      onClick={() => applyRange(p)}
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <div className="employee-payroll__detail-summary">
              <div>
                Оклад: <strong>{formatMoney(detail?.baseSalary)}</strong>
              </div>
              <div>
                Пропуски:{' '}
                <strong>{detailLoading ? '…' : detail?.missedDays ?? '—'}</strong>
                {!detailLoading && detail ? ` из ${detail.workingDaysCount}` : null}
              </div>
              <div>
                Зарплата:{' '}
                <strong>{detailLoading ? '…' : formatMoney(detail?.salary)}</strong>
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
              Период задаётся датами выше (можно 1–15 или 25 → 10). Календарь — для отметок
              пропусков; дни вне периода затемнены.
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
