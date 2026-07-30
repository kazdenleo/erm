/**
 * ABC-анализ товаров (выручка / прибыль / штуки)
 */

import React, { useCallback, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './AbcSalesAnalytics.css';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { ABC_METRICS, classifyAbc } from '../shared/abcClassify';

function formatQty(n) {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function formatRub(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(n);
}

function formatPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

const MARKETPLACE_OPTIONS = [
  { value: 'all', label: 'Все маркетплейсы' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'wb', label: 'Wildberries' },
  { value: 'ym', label: 'Яндекс Маркет' },
];

const SCHEME_OPTIONS = [
  { value: 'all', label: 'FBO + FBS' },
  { value: 'fbo', label: 'Только FBO' },
  { value: 'fbs', label: 'Только FBS' },
];

const CLASS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
];

export function AbcSalesAnalytics() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [metric, setMetric] = useState('soldAmount');
  const [classFilter, setClassFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getAbc({
        dateFrom,
        dateTo,
        marketplace,
        scheme,
      });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить ABC-анализ');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  const classified = useMemo(
    () => classifyAbc(data?.products || [], metric),
    [data, metric]
  );

  const items = useMemo(() => {
    if (classFilter === 'all') return classified.items;
    return classified.items.filter((r) => r.abcClass === classFilter);
  }, [classified.items, classFilter]);

  const metricLabel = ABC_METRICS.find((m) => m.value === metric)?.label || 'Выручка';

  return (
    <div className="sales-analytics abc-sales-analytics">
      <PageTitle
        iconClass="pe-7s-graph1"
        iconBgClass="bg-mean-fruit"
        title="ABC-анализ"
        subtitle="Товары A / B / C по выручке, прибыли или штукам (пороги 80% / 15% / 5%)"
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
        <label className="sales-analytics__filter">
          <span>Схема</span>
          <select value={scheme} onChange={(e) => setScheme(e.target.value)}>
            {SCHEME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sales-analytics__filter">
          <span>Маркетплейс</span>
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            {MARKETPLACE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : data ? 'Обновить' : 'Показать'}
        </Button>
      </div>

      <div className="abc-sales-analytics__toggles">
        <div className="abc-sales-analytics__toggle-group" role="group" aria-label="Метрика ABC">
          <span className="abc-sales-analytics__toggle-label">Метрика</span>
          {ABC_METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`abc-sales-analytics__toggle${metric === m.value ? ' is-active' : ''}`}
              onClick={() => setMetric(m.value)}
              disabled={!data}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="abc-sales-analytics__toggle-group" role="group" aria-label="Класс ABC">
          <span className="abc-sales-analytics__toggle-label">Класс</span>
          {CLASS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`abc-sales-analytics__toggle${classFilter === f.value ? ' is-active' : ''}`}
              onClick={() => setClassFilter(f.value)}
              disabled={!data}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      <div className="sales-analytics__cards">
        {['A', 'B', 'C'].map((cls) => {
          const g = classified.groups[cls];
          return (
            <div
              key={cls}
              className={`sales-analytics__card abc-sales-analytics__card abc-sales-analytics__card--${cls.toLowerCase()}`}
            >
              <div className="sales-analytics__card-label">Группа {cls}</div>
              <div className="sales-analytics__card-value">{formatQty(g.productsCount)} тов.</div>
              <div className="sales-analytics__card-sub">
                {metricLabel}: {metric === 'soldQty' ? formatQty(g.metricSum) : formatRub(g.metricSum)} ·{' '}
                {formatPct(g.share)}
              </div>
            </div>
          );
        })}
        <div className="sales-analytics__card">
          <div className="sales-analytics__card-label">Всего</div>
          <div className="sales-analytics__card-value">{formatQty(data?.summary?.productsCount || 0)}</div>
          <div className="sales-analytics__card-sub">
            Выручка {formatRub(data?.summary?.soldAmount)} · прибыль {formatRub(data?.summary?.netIncome)}
          </div>
        </div>
      </div>

      <div className="sales-analytics__table-wrap">
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <th>Класс</th>
              <th>Товар</th>
              <th>Артикул</th>
              <th>Категория</th>
              <th className="sales-analytics__num">Штуки</th>
              <th className="sales-analytics__num">Выручка</th>
              <th className="sales-analytics__num">Прибыль</th>
              <th className="sales-analytics__num">Доля</th>
              <th className="sales-analytics__num">Накопит.</th>
            </tr>
          </thead>
          <tbody>
            {!loading && data == null && (
              <tr>
                <td colSpan={9} className="sales-analytics__empty">
                  Выберите параметры и нажмите «Показать».
                </td>
              </tr>
            )}
            {!loading && data != null && items.length === 0 && (
              <tr>
                <td colSpan={9} className="sales-analytics__empty">
                  Нет данных за выбранный период. Сначала загрузите отчёты FBO/FBS.
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={`${row.productId || 'x'}-${row.sku}-${row.abcClass}`}>
                <td>
                  <span className={`abc-sales-analytics__badge abc-sales-analytics__badge--${row.abcClass.toLowerCase()}`}>
                    {row.abcClass}
                  </span>
                </td>
                <td>{row.productName || '—'}</td>
                <td>{row.erpSku || row.sku || '—'}</td>
                <td>{row.categoryName || '—'}</td>
                <td className="sales-analytics__num">{formatQty(row.soldQty)}</td>
                <td className="sales-analytics__num">{formatRub(row.soldAmount)}</td>
                <td className="sales-analytics__num">{formatRub(row.netIncome)}</td>
                <td className="sales-analytics__num">{formatPct(row.share)}</td>
                <td className="sales-analytics__num">{formatPct(row.cumulativeShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
