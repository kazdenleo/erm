/**
 * Показатели сотрудников склада: время сборки FBS / FBO, упаковки FBO, приёмки, ошибки сканирования.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import {
  SummaryCards,
  ToggleGroup,
  errorMessage,
  formatDateRu,
  formatPercent,
  formatQty,
} from '../shared/analyticsKit';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';
import { PackingCalculator } from './PackingCalculator';
import './EmployeeMetrics.css';

const LINE_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

const timeOrLast = (v) => (v == null ? Number.POSITIVE_INFINITY : Number(v));

const SORT_GETTERS = {
  name: (r) => r.name || '',
  orders: (r) => Number(r.assembly?.orders) || 0,
  units: (r) => Number(r.assembly?.units) || 0,
  fbsSec: (r) => timeOrLast(r.assembly?.secPerOrder),
  errors: (r) => Number(r.assembly?.errors) || 0,
  fboUnits: (r) => Number(r.fboCollect?.units) || 0,
  fboSec: (r) => timeOrLast(r.fboCollect?.secPerUnit),
  packUnits: (r) => Number(r.packing?.units) || 0,
  packSec: (r) => timeOrLast(r.packing?.secPerUnit),
  receipts: (r) => Number(r.receipts?.receipts) || 0,
  receiptSec: (r) => timeOrLast(r.receipts?.secPerUnit),
  receivedUnits: (r) => Number(r.receipts?.units) || 0,
  receiptErrors: (r) => Number(r.receipts?.errors) || 0,
  inventory: (r) => Number(r.inventory?.sessions) || 0,
};

const COLUMN_COUNT = 14;

const CHART_PROCESSES = [
  { value: 'fbs', label: 'Сборка FBS', qtyLabel: 'Собрано заказов', secLabel: 'Время на заказ' },
  { value: 'fboCollect', label: 'Сборка FBO', qtyLabel: 'Собрано, шт', secLabel: 'Время на штуку' },
  { value: 'packing', label: 'Упаковка FBO', qtyLabel: 'Упаковано, шт', secLabel: 'Время на штуку' },
  { value: 'receipts', label: 'Приёмка', qtyLabel: 'Принято, шт', secLabel: 'Время на штуку' },
];

const CHART_MODES = [
  { value: 'qty', label: 'Объём' },
  { value: 'sec', label: 'Время' },
];

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const raw = Number(sec);
  if (raw < 10 && !Number.isInteger(raw)) return `${raw.toFixed(1).replace('.', ',')} с`;
  const s = Math.round(raw);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60 ? `${s % 60} с` : ''}`.trim();
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function minutesLabel(sec) {
  const m = Math.round((Number(sec) || 0) / 60);
  return `${m} мин`;
}

function Sub({ children }) {
  return <div className="analytics-kit__product-name">{children}</div>;
}

function hoursSub(hours) {
  return Number(hours) > 0 ? <Sub>{formatQty(hours, 1)} ч работы</Sub> : null;
}

function receiptTimeCell(avgSec, medianSec) {
  if (avgSec == null) return '—';
  return (
    <>
      {formatDuration(avgSec)}
      <Sub>медиана {formatDuration(medianSec)}</Sub>
    </>
  );
}

function errorsCell(errors, scans, rate) {
  return scans ? `${formatQty(errors, 0)} (${formatPercent(rate)})` : formatQty(errors, 0);
}

export function EmployeeMetrics() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const { sort, toggleSort } = useTableSort('orders', 'desc');
  const [chartProcess, setChartProcess] = useState('fbs');
  const [chartMode, setChartMode] = useState('qty');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getEmployees({ dateFrom, dateTo });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить показатели сотрудников'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const employees = useMemo(() => (Array.isArray(data?.employees) ? data.employees : []), [data]);
  const sorted = useMemo(() => sortRows(employees, sort, SORT_GETTERS), [employees, sort]);
  const summary = data?.summary || {};
  const idle = data?.idleThresholdsSec || {};

  const chartMeta = CHART_PROCESSES.find((p) => p.value === chartProcess) || CHART_PROCESSES[0];
  const chartEmployees = useMemo(() => {
    const total = (e) =>
      Object.values(e.daily?.[chartProcess] || {}).reduce((s, v) => s + Math.abs(Number(v?.qty) || 0), 0);
    return employees
      .map((e) => ({ e, total: total(e) }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, LINE_COLORS.length)
      .map((x) => x.e);
  }, [employees, chartProcess]);
  const chartDays = useMemo(() => {
    const days = new Set();
    chartEmployees.forEach((e) => Object.keys(e.daily?.[chartProcess] || {}).forEach((d) => days.add(d)));
    return chartMode === 'qty' ? data?.days || [] : [...days].sort();
  }, [chartEmployees, chartProcess, chartMode, data]);
  const chartData = useMemo(
    () =>
      chartDays.map((day) => {
        const row = { day: formatDateRu(day).slice(0, 5) };
        chartEmployees.forEach((e) => {
          const v = e.daily?.[chartProcess]?.[day];
          row[`u${e.userId}`] = chartMode === 'qty' ? Number(v?.qty) || 0 : v?.sec ?? null;
        });
        return row;
      }),
    [chartDays, chartEmployees, chartProcess, chartMode]
  );

  const th = (key, label, title) => (
    <SortableTh sortKey={key} sort={sort} onSort={toggleSort} className="sales-analytics__num" title={title}>
      {label}
    </SortableTh>
  );

  return (
    <div className="sales-analytics employee-metrics">
      <PageTitle
        iconClass="pe-7s-users"
        iconBgClass="bg-premium-dark"
        title="Сотрудники"
        subtitle="Время сборки FBS и FBO, упаковки и приёмки, ошибки сканирования по сотрудникам склада"
      />

      <div className="sales-analytics__filters erp-filter-bar">
        <AnalyticsPeriodFilters
          periodPreset={periodPreset}
          onPeriodPresetChange={setPeriodPreset}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        />
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      {data && (
        <SummaryCards
          cards={[
            {
              label: 'Сборка FBS, на заказ',
              value: formatDuration(summary.fbsSecPerOrder),
              sub: `${formatQty(summary.ordersAssembled, 0)} заказов · ${formatQty(summary.unitsAssembled, 0)} шт`,
            },
            {
              label: 'Сборка FBO, на штуку',
              value: formatDuration(summary.fboCollectSecPerUnit),
              sub: `${formatQty(summary.fboCollectUnits, 0)} шт`,
            },
            {
              label: 'Упаковка FBO, на штуку',
              value: formatDuration(summary.packingSecPerUnit),
              sub: `${formatQty(summary.packingUnits, 0)} шт`,
            },
            {
              label: 'Приёмка, на штуку',
              value: formatDuration(summary.receiptSecPerUnit),
              sub:
                summary.receiptMedianSecPerUnit != null
                  ? `медиана ${formatDuration(summary.receiptMedianSecPerUnit)} · ${formatQty(summary.unitsReceived, 0)} шт`
                  : `${formatQty(summary.unitsReceived, 0)} шт`,
            },
            {
              label: 'Ошибки сборки',
              value: formatQty(summary.assemblyErrors, 0),
              tone: Number(summary.assemblyErrors) > 0 ? 'warning' : undefined,
              sub:
                summary.assemblyErrorRate != null
                  ? `${formatPercent(summary.assemblyErrorRate)} от ${formatQty(summary.assemblyScans, 0)} сканов`
                  : 'нет данных о сканах',
            },
          ]}
        />
      )}

      <div className="product-dynamics__chart-wrap">
        <div className="employee-metrics__chart-head">
          <h3 className="product-dynamics__chart-title">
            {chartMeta.label}: {(chartMode === 'qty' ? chartMeta.qtyLabel : chartMeta.secLabel).toLowerCase()} по дням
          </h3>
          <div className="employee-metrics__chart-controls">
            <ToggleGroup value={chartProcess} onChange={setChartProcess} options={CHART_PROCESSES} />
            <ToggleGroup value={chartMode} onChange={setChartMode} options={CHART_MODES} />
          </div>
        </div>
        {chartData.length > 0 && chartEmployees.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 12 }}
                allowDecimals={false}
                tickFormatter={chartMode === 'sec' ? (v) => formatDuration(v) : undefined}
                width={chartMode === 'sec' ? 72 : 48}
              />
              <Tooltip formatter={(v) => (chartMode === 'sec' ? formatDuration(v) : formatQty(v, 0))} />
              <Legend />
              {chartEmployees.map((e, i) => (
                <Line
                  key={e.userId}
                  type="monotone"
                  dataKey={`u${e.userId}`}
                  name={e.name}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={2}
                  dot={chartMode === 'sec' ? { r: 3 } : false}
                  connectNulls={chartMode === 'sec'}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="product-dynamics__empty-chart">
            {loading ? 'Загрузка…' : `${chartMeta.label}: за период данных нет`}
          </div>
        )}
      </div>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 16 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <SortableTh sortKey="name" sort={sort} onSort={toggleSort}>
                Сотрудник
              </SortableTh>
              {th('orders', 'FBS заказов')}
              {th('units', 'FBS штук')}
              {th(
                'fbsSec',
                'FBS на заказ',
                `Время работы ÷ заказы. Пауза без сканов дольше ${minutesLabel(idle.fbs)} — перерыв, не считается`
              )}
              {th('errors', 'Ошибки сборки')}
              {th('fboUnits', 'FBO собрано, шт')}
              {th(
                'fboSec',
                'FBO на штуку',
                `Время работы ÷ штуки. Пауза без сканов дольше ${minutesLabel(idle.fboCollect)} — перерыв, не считается`
              )}
              {th('packUnits', 'Упаковано, шт')}
              {th(
                'packSec',
                'Упаковка на штуку',
                `Время работы ÷ штуки. Пауза без сканов дольше ${minutesLabel(idle.packing)} — перерыв, не считается`
              )}
              {th('receipts', 'Приёмок')}
              {th(
                'receiptSec',
                'Приёмка на штуку',
                'Время от создания до закрытия приёмок ÷ принятые штуки. Ниже — медиана по приёмкам'
              )}
              {th('receivedUnits', 'Принято, шт')}
              {th('receiptErrors', 'Ошибки приёмки')}
              {th('inventory', 'Инвент.')}
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMN_COUNT} className="sales-analytics__empty">
                  Нет активности сотрудников за период
                </td>
              </tr>
            )}
            {sorted.map((e) => {
              const a = e.assembly || {};
              const f = e.fboCollect || {};
              const p = e.packing || {};
              const r = e.receipts || {};
              return (
                <tr key={e.userId}>
                  <td>
                    <strong>{e.name}</strong>
                    {e.role ? <Sub>{e.role}</Sub> : null}
                  </td>
                  <td className="sales-analytics__num">{formatQty(a.orders, 0)}</td>
                  <td className="sales-analytics__num">{formatQty(a.units, 0)}</td>
                  <td className="sales-analytics__num">
                    {formatDuration(a.secPerOrder)}
                    {hoursSub(a.activeHours)}
                  </td>
                  <td className="sales-analytics__num">{errorsCell(a.errors, a.scans, a.errorRate)}</td>
                  <td className="sales-analytics__num">
                    {formatQty(f.units, 0)}
                    {f.supplies ? <Sub>поставок: {formatQty(f.supplies, 0)}</Sub> : null}
                  </td>
                  <td className="sales-analytics__num">
                    {formatDuration(f.secPerUnit)}
                    {hoursSub(f.activeHours)}
                  </td>
                  <td className="sales-analytics__num">{formatQty(p.units, 0)}</td>
                  <td className="sales-analytics__num">
                    {formatDuration(p.secPerUnit)}
                    {hoursSub(p.activeHours)}
                  </td>
                  <td className="sales-analytics__num">{formatQty(r.receipts, 0)}</td>
                  <td className="sales-analytics__num">{receiptTimeCell(r.secPerUnit, r.medianSecPerUnit)}</td>
                  <td className="sales-analytics__num">
                    {formatQty(r.units, 0)}
                    {r.diffLines ? <Sub>расхождений: {formatQty(r.diffLines, 0)}</Sub> : null}
                  </td>
                  <td className="sales-analytics__num">{errorsCell(r.errors, r.scans, r.errorRate)}</td>
                  <td className="sales-analytics__num">{formatQty(e.inventory?.sessions, 0)}</td>
                </tr>
              );
            })}
          </tbody>
          {sorted.length > 0 && (
            <tfoot>
              <tr className="employee-metrics__total">
                <td>Итого / среднее</td>
                <td className="sales-analytics__num">{formatQty(summary.ordersAssembled, 0)}</td>
                <td className="sales-analytics__num">{formatQty(summary.unitsAssembled, 0)}</td>
                <td className="sales-analytics__num">
                  {formatDuration(summary.fbsSecPerOrder)}
                  {hoursSub(summary.fbsActiveHours)}
                </td>
                <td className="sales-analytics__num">
                  {errorsCell(summary.assemblyErrors, summary.assemblyScans, summary.assemblyErrorRate)}
                </td>
                <td className="sales-analytics__num">{formatQty(summary.fboCollectUnits, 0)}</td>
                <td className="sales-analytics__num">
                  {formatDuration(summary.fboCollectSecPerUnit)}
                  {hoursSub(summary.fboCollectActiveHours)}
                </td>
                <td className="sales-analytics__num">{formatQty(summary.packingUnits, 0)}</td>
                <td className="sales-analytics__num">
                  {formatDuration(summary.packingSecPerUnit)}
                  {hoursSub(summary.packingActiveHours)}
                </td>
                <td className="sales-analytics__num">{formatQty(summary.receipts, 0)}</td>
                <td className="sales-analytics__num">
                  {receiptTimeCell(summary.receiptSecPerUnit, summary.receiptMedianSecPerUnit)}
                </td>
                <td className="sales-analytics__num">{formatQty(summary.unitsReceived, 0)}</td>
                <td className="sales-analytics__num">{formatQty(summary.receiptErrors, 0)}</td>
                <td className="sales-analytics__num">{formatQty(summary.inventorySessions, 0)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {data && <PackingCalculator summary={summary} />}

      <p className="sales-analytics__hint">
        Время работы — сумма промежутков между сканами сотрудника. Если сканов нет дольше{' '}
        {minutesLabel(idle.fbs)} на сборке FBS, {minutesLabel(idle.fboCollect)} на сборке FBO или{' '}
        {minutesLabel(idle.packing)} на упаковке, отсчёт останавливается и продолжается со следующего скана. Итог —
        общее время всех сотрудников, делённое на все заказы или штуки. Приёмка — время от создания до закрытия документа, делённое на принятые штуки. В сборке FBO комплект
        считается одной штукой, даже если его части сканируются по отдельности.
        <br />
        Сканы сборки FBS{' '}
        {data?.fbsScansSince
          ? `записываются с ${formatDateRu(data.fbsScansSince)}; раньше время считается по отметкам «Собран»`
          : 'пока не записывались — время считается по отметкам «Собран»'}
        . Упаковка FBO{' '}
        {data?.packingSince
          ? `записывается с ${formatDateRu(data.packingSince)}`
          : 'пока не записывалась — данные появятся после первых сканов упаковки'}
        .
      </p>
    </div>
  );
}
