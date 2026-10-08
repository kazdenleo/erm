/**
 * Показатели сотрудников склада: скорость сборки, ошибки сканирования, объём приёмки.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import { SummaryCards, errorMessage, formatDateRu, formatPercent, formatQty } from '../shared/analyticsKit';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

const LINE_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#dc2626', '#0891b2', '#ca8a04', '#db2777'];

const SORT_GETTERS = {
  name: (r) => r.name || '',
  orders: (r) => Number(r.assembly?.orders) || 0,
  units: (r) => Number(r.assembly?.units) || 0,
  ordersPerHour: (r) => Number(r.assembly?.ordersPerHour) || 0,
  medianSec: (r) => (r.assembly?.medianSecPerOrder == null ? Number.POSITIVE_INFINITY : r.assembly.medianSecPerOrder),
  errors: (r) => Number(r.assembly?.errors) || 0,
  errorRate: (r) => Number(r.assembly?.errorRate) || 0,
  receipts: (r) => Number(r.receipts?.receipts) || 0,
  receivedUnits: (r) => Number(r.receipts?.units) || 0,
  receiptErrors: (r) => Number(r.receipts?.errors) || 0,
  inventory: (r) => Number(r.inventory?.sessions) || 0,
};

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Math.round(Number(sec));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60 ? `${s % 60} с` : ''}`.trim();
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
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

  const chartEmployees = useMemo(
    () =>
      [...employees]
        .filter((e) => Number(e.assembly?.orders) > 0)
        .sort((a, b) => (b.assembly?.orders || 0) - (a.assembly?.orders || 0))
        .slice(0, LINE_COLORS.length),
    [employees]
  );
  const chartData = useMemo(
    () =>
      (data?.days || []).map((day) => {
        const row = { day: formatDateRu(day).slice(0, 5) };
        chartEmployees.forEach((e) => {
          row[`u${e.userId}`] = Number(e.assembly?.byDay?.[day]) || 0;
        });
        return row;
      }),
    [data, chartEmployees]
  );

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-users"
        iconBgClass="bg-premium-dark"
        title="Сотрудники"
        subtitle="Скорость сборки, ошибки сканирования и объём приёмки по сотрудникам склада"
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
            { label: 'Сотрудников', value: formatQty(summary.employees, 0) },
            {
              label: 'Собрано заказов',
              value: formatQty(summary.ordersAssembled, 0),
              sub: `${formatQty(summary.unitsAssembled, 0)} шт`,
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
            {
              label: 'Приёмок',
              value: formatQty(summary.receipts, 0),
              sub: `${formatQty(summary.unitsReceived, 0)} шт принято`,
            },
            { label: 'Инвентаризаций', value: formatQty(summary.inventorySessions, 0) },
          ]}
        />
      )}

      <div className="product-dynamics__chart-wrap">
        <h3 className="product-dynamics__chart-title">Собрано заказов по дням</h3>
        {chartData.length > 0 && chartEmployees.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              {chartEmployees.map((e, i) => (
                <Line
                  key={e.userId}
                  type="monotone"
                  dataKey={`u${e.userId}`}
                  name={e.name}
                  stroke={LINE_COLORS[i % LINE_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="product-dynamics__empty-chart">{loading ? 'Загрузка…' : 'Сборок за период нет'}</div>
        )}
      </div>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 16 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <SortableTh sortKey="name" sort={sort} onSort={toggleSort}>
                Сотрудник
              </SortableTh>
              <SortableTh sortKey="orders" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Заказов
              </SortableTh>
              <SortableTh sortKey="units" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Штук
              </SortableTh>
              <SortableTh
                sortKey="ordersPerHour"
                sort={sort}
                onSort={toggleSort}
                className="sales-analytics__num"
                title="Заказов за час активной работы (перерывы дольше 20 минут не учитываются)"
              >
                Заказов/час
              </SortableTh>
              <SortableTh sortKey="medianSec" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                На заказ (медиана)
              </SortableTh>
              <SortableTh sortKey="errors" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Ошибки сборки
              </SortableTh>
              <SortableTh sortKey="receipts" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Приёмок
              </SortableTh>
              <SortableTh sortKey="receivedUnits" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Принято, шт
              </SortableTh>
              <SortableTh sortKey="receiptErrors" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Ошибки приёмки
              </SortableTh>
              <SortableTh sortKey="inventory" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Инвент.
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="sales-analytics__empty">
                  Нет активности сотрудников за период
                </td>
              </tr>
            )}
            {sorted.map((e) => {
              const a = e.assembly || {};
              const r = e.receipts || {};
              return (
                <tr key={e.userId}>
                  <td>
                    <strong>{e.name}</strong>
                    {e.role ? <div className="analytics-kit__product-name">{e.role}</div> : null}
                  </td>
                  <td className="sales-analytics__num">{formatQty(a.orders, 0)}</td>
                  <td className="sales-analytics__num">{formatQty(a.units, 0)}</td>
                  <td className="sales-analytics__num">
                    {formatQty(a.ordersPerHour, 1)}
                    {a.activeHours ? (
                      <div className="analytics-kit__product-name">{formatQty(a.activeHours, 1)} ч активно</div>
                    ) : null}
                  </td>
                  <td
                    className="sales-analytics__num"
                    title={
                      a.paceSource === 'scan'
                        ? 'По сканам: от первого скана до завершения заказа'
                        : 'По интервалам между завершёнными заказами'
                    }
                  >
                    {formatDuration(a.medianSecPerOrder)}
                  </td>
                  <td className="sales-analytics__num">
                    {a.scans ? `${formatQty(a.errors, 0)} (${formatPercent(a.errorRate)})` : formatQty(a.errors, 0)}
                  </td>
                  <td className="sales-analytics__num">
                    {formatQty(r.receipts, 0)}
                    {r.medianSec ? (
                      <div className="analytics-kit__product-name">медиана {formatDuration(r.medianSec)}</div>
                    ) : null}
                  </td>
                  <td className="sales-analytics__num">
                    {formatQty(r.units, 0)}
                    {r.diffLines ? (
                      <div className="analytics-kit__product-name">расхождений: {formatQty(r.diffLines, 0)}</div>
                    ) : null}
                  </td>
                  <td className="sales-analytics__num">
                    {r.scans ? `${formatQty(r.errors, 0)} (${formatPercent(r.errorRate)})` : formatQty(r.errors, 0)}
                  </td>
                  <td className="sales-analytics__num">{formatQty(e.inventory?.sessions, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Сборка и приёмка — по завершённым заказам и документам приёмки. Ошибки сканирования (не тот товар, лишний скан)
        записываются{' '}
        {data?.trackingSince
          ? `с ${formatDateRu(data.trackingSince)}`
          : 'с момента обновления — данные появятся после первых сканов'}
        .
      </p>
    </div>
  );
}
