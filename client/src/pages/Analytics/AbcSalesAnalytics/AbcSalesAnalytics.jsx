/**
 * ABC-анализ товаров (выручка / прибыль / штуки)
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { productHypothesesApi } from '../../../services/productHypotheses.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './AbcSalesAnalytics.css';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { ABC_METRICS, classifyAbc } from '../shared/abcClassify';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';

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

const ABC_SORT_GETTERS = {
  abcClass: (r) => r.abcClass || '',
  productName: (r) => r.productName || '',
  erpSku: (r) => r.erpSku || r.sku || '',
  categoryName: (r) => r.categoryName || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  soldAmount: (r) => Number(r.soldAmount) || 0,
  netIncome: (r) => Number(r.netIncome) || 0,
  share: (r) => Number(r.share) || 0,
  cumulativeShare: (r) => Number(r.cumulativeShare) || 0,
};

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
  const navigate = useNavigate();
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
  /** productId -> hypothesisId для активных гипотез */
  const [activeHypothesisByProduct, setActiveHypothesisByProduct] = useState(() => new Map());
  const { sort, toggleSort } = useTableSort(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, hypRes] = await Promise.all([
        salesAnalyticsApi.getAbc({
          dateFrom,
          dateTo,
          marketplace,
          scheme,
        }),
        productHypothesesApi.list({ status: 'active' }).catch(() => null),
      ]);
      setData(res?.data ?? null);
      const map = new Map();
      for (const item of hypRes?.data?.items || []) {
        const pid = Number(item.productId);
        if (Number.isFinite(pid) && pid > 0 && !map.has(pid)) {
          map.set(pid, Number(item.id) || 0);
        }
      }
      setActiveHypothesisByProduct(map);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить ABC-анализ');
      setData(null);
      setActiveHypothesisByProduct(new Map());
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  const classified = useMemo(
    () => classifyAbc(data?.products || [], metric),
    [data, metric]
  );

  const items = useMemo(() => {
    const filtered =
      classFilter === 'all'
        ? classified.items
        : classified.items.filter((r) => r.abcClass === classFilter);
    if (!sort.key) return filtered;
    return sortRows(filtered, sort, ABC_SORT_GETTERS);
  }, [classified.items, classFilter, sort]);

  const metricLabel = ABC_METRICS.find((m) => m.value === metric)?.label || 'Выручка';

  const openHypothesis = useCallback(
    (row) => {
      const productId = Number(row.productId);
      if (!Number.isFinite(productId) || productId < 1) return;
      if (activeHypothesisByProduct.has(productId)) {
        navigate('/analytics/hypotheses');
        return;
      }
      navigate('/analytics/hypotheses', {
        state: {
          createFromAbc: {
            productId,
            productName: row.productName || '',
            productSku: row.erpSku || row.sku || '',
            marketplace,
            scheme,
            abcClass: row.abcClass || '',
            metricLabel,
          },
        },
      });
    },
    [navigate, marketplace, scheme, metricLabel, activeHypothesisByProduct]
  );

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
              <SortableTh sortKey="abcClass" sort={sort} onSort={toggleSort}>
                Класс
              </SortableTh>
              <SortableTh sortKey="productName" sort={sort} onSort={toggleSort}>
                Товар
              </SortableTh>
              <SortableTh sortKey="erpSku" sort={sort} onSort={toggleSort}>
                Артикул
              </SortableTh>
              <SortableTh sortKey="categoryName" sort={sort} onSort={toggleSort}>
                Категория
              </SortableTh>
              <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Штуки
              </SortableTh>
              <SortableTh sortKey="soldAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Выручка
              </SortableTh>
              <SortableTh sortKey="netIncome" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Прибыль
              </SortableTh>
              <SortableTh sortKey="share" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Доля
              </SortableTh>
              <SortableTh sortKey="cumulativeShare" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Накопит.
              </SortableTh>
              <th className="abc-sales-analytics__col-action">Гипотеза</th>
            </tr>
          </thead>
          <tbody>
            {!loading && data == null && (
              <tr>
                <td colSpan={10} className="sales-analytics__empty">
                  Выберите параметры и нажмите «Показать».
                </td>
              </tr>
            )}
            {!loading && data != null && items.length === 0 && (
              <tr>
                <td colSpan={10} className="sales-analytics__empty">
                  Нет данных за выбранный период. Сначала загрузите отчёты FBO/FBS.
                </td>
              </tr>
            )}
            {items.map((row) => {
              const productId = Number(row.productId) || 0;
              const canHypothesis = productId > 0;
              const alreadyInWork = canHypothesis && activeHypothesisByProduct.has(productId);
              return (
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
                <td className="abc-sales-analytics__col-action">
                  {alreadyInWork ? (
                    <button
                      type="button"
                      className="abc-sales-analytics__in-work"
                      title="Уже есть гипотеза в работе — открыть список"
                      onClick={() => navigate('/analytics/hypotheses')}
                    >
                      В работе
                    </button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!canHypothesis}
                      title={
                        canHypothesis
                          ? 'Создать гипотезу по этому товару'
                          : 'Товар не сопоставлен с карточкой ERP'
                      }
                      onClick={() => openHypothesis(row)}
                    >
                      В работу
                    </Button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
