/**
 * Динамика продаж по артикулам: таблица шт/сумма + график по выбранным товарам.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import '../SalesAnalytics/SalesAnalytics.css';
import './ProductDynamics.css';
import {
  buildCompareChartData,
  buildMarketplaceChartData,
  buildProductChartData,
  buildSingleProductDualMetricData,
  formatMetricValue,
  marketplaceLabel,
  productLabel,
  productRowKey,
} from './productDynamicsChart';

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

const GRANULARITY_OPTIONS = [
  { value: 'day', label: 'По дням' },
  { value: 'week', label: 'По неделям' },
  { value: 'month', label: 'По месяцам' },
  { value: 'quarter', label: 'По кварталам' },
  { value: 'year', label: 'По годам' },
];

const METRIC_OPTIONS = [
  { value: 'soldAmount', label: 'Выручка' },
  { value: 'soldQty', label: 'Штуки' },
];

const VIEW_MODES = [
  { value: 'products', label: 'По товарам' },
  { value: 'marketplace', label: 'По МП' },
  { value: 'compare', label: 'Сравнение периодов' },
];

const PRODUCT_SORT_GETTERS = {
  article: (r) => r.erpSku || r.sku || '',
  productName: (r) => r.productName || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  soldAmount: (r) => Number(r.soldAmount) || 0,
};

function shiftDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function periodLengthDays(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function makePreviousPeriod(dateFrom, dateTo) {
  const len = periodLengthDays(dateFrom, dateTo);
  const prevTo = shiftDaysYmd(dateFrom, -1);
  const prevFrom = shiftDaysYmd(prevTo, -(len - 1));
  return { dateFrom: prevFrom, dateTo: prevTo, label: 'Предыдущий период' };
}

function CustomTooltip({ active, payload, label, metric, dual }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="sales-analytics__tip-box"
      style={{ position: 'static', opacity: 1, visibility: 'visible' }}
    >
      <b>{label}</b>
      {payload.map((entry) => (
        <span key={entry.dataKey} className="sales-analytics__tip-row">
          <span>{entry.name}</span>
          <span>
            {dual
              ? formatMetricValue(entry.dataKey === 'soldQty' ? 'soldQty' : 'soldAmount', entry.value)
              : formatMetricValue(metric, entry.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

export function ProductDynamics() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [granularity, setGranularity] = useState('week');
  const [metric, setMetric] = useState('soldAmount');
  const [viewMode, setViewMode] = useState('products');
  const [compareMp, setCompareMp] = useState('all');
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [comparePeriods, setComparePeriods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const { sort, toggleSort } = useTableSort('soldAmount', 'desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getProductDynamics({
        dateFrom,
        dateTo,
        comparePeriods: comparePeriods.length ? comparePeriods : null,
        granularity,
        marketplace,
        scheme,
      });
      const next = res?.data ?? null;
      setData(next);
      const products = next?.periods?.[0]?.products || [];
      if (products.length) {
        setSelectedKeys([productRowKey(products[0])]);
      } else {
        setSelectedKeys([]);
      }
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить динамику');
      setData(null);
      setSelectedKeys([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, comparePeriods, granularity, marketplace, scheme]);

  const periods = useMemo(() => (Array.isArray(data?.periods) ? data.periods : []), [data]);
  const primary = periods[0] || null;
  const products = useMemo(() => primary?.products || [], [primary]);
  const sortedProducts = useMemo(
    () => sortRows(products, sort, PRODUCT_SORT_GETTERS),
    [products, sort]
  );

  const selectedProducts = useMemo(
    () => products.filter((p) => selectedKeys.includes(productRowKey(p))),
    [products, selectedKeys]
  );

  const chart = useMemo(() => {
    if (!primary) return { data: [], seriesKeys: [], dual: false };
    if (viewMode === 'compare') {
      const mp = compareMp === 'all' ? null : compareMp;
      return { ...buildCompareChartData(periods, metric, mp), dual: false };
    }
    if (viewMode === 'marketplace') {
      if (selectedProducts.length === 1) {
        const p = selectedProducts[0];
        const fakePeriod = {
          buckets: p.buckets,
          marketplaces: p.marketplaces || primary.marketplaces,
        };
        return { ...buildMarketplaceChartData(fakePeriod, metric), dual: false };
      }
      return { ...buildMarketplaceChartData(primary, metric), dual: false };
    }
    if (selectedProducts.length === 1) {
      return { ...buildSingleProductDualMetricData(selectedProducts[0]), dual: true };
    }
    return { ...buildProductChartData(primary, selectedKeys, metric), dual: false };
  }, [primary, periods, viewMode, metric, compareMp, selectedProducts, selectedKeys]);

  useEffect(() => {
    if (viewMode === 'products' && selectedKeys.length > 8) {
      setSelectedKeys((keys) => keys.slice(0, 8));
    }
  }, [viewMode, selectedKeys.length]);

  const toggleProduct = (key) => {
    setSelectedKeys((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) return prev;
        return prev.filter((k) => k !== key);
      }
      if (prev.length >= 8) return [...prev.slice(1), key];
      return [...prev, key];
    });
    if (viewMode === 'compare') setViewMode('products');
  };

  const addComparePeriod = () => {
    if (comparePeriods.length >= 3) return;
    const prev = makePreviousPeriod(dateFrom, dateTo);
    setComparePeriods((list) => [
      ...list,
      {
        id: `compare-${list.length + 1}`,
        label: prev.label,
        dateFrom: prev.dateFrom,
        dateTo: prev.dateTo,
      },
    ]);
    setViewMode('compare');
  };

  const updateComparePeriod = (idx, patch) => {
    setComparePeriods((list) => list.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const removeComparePeriod = (idx) => {
    setComparePeriods((list) => list.filter((_, i) => i !== idx));
  };

  const chartTitle = (() => {
    if (viewMode === 'compare') return 'Сравнение периодов';
    if (viewMode === 'marketplace') {
      if (selectedProducts.length === 1) {
        return `${productLabel(selectedProducts[0])} — по маркетплейсам`;
      }
      return 'Все товары — по маркетплейсам';
    }
    if (selectedProducts.length === 1) {
      const p = selectedProducts[0];
      return `${p.erpSku || p.sku} — ${p.productName || '—'}`;
    }
    if (selectedProducts.length > 1) return `Выбрано товаров: ${selectedProducts.length}`;
    return 'Выберите товар в таблице';
  })();

  return (
    <div className="sales-analytics product-dynamics">
      <PageTitle
        iconClass="pe-7s-graph"
        iconBgClass="bg-mean-fruit"
        title="Динамика продаж"
        subtitle="По каждому артикулу — количество и сумма продаж на графике по дням, неделям, месяцам"
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

      <div className="product-dynamics__controls-row">
        <div className="product-dynamics__toggle-group" role="group" aria-label="Группировка">
          <span className="product-dynamics__toggle-label">Группировка</span>
          {GRANULARITY_OPTIONS.map((g) => (
            <button
              key={g.value}
              type="button"
              className={`product-dynamics__toggle${granularity === g.value ? ' is-active' : ''}`}
              onClick={() => setGranularity(g.value)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="product-dynamics__toggle-group" role="group" aria-label="Метрика">
          <span className="product-dynamics__toggle-label">Метрика</span>
          {METRIC_OPTIONS.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`product-dynamics__toggle${metric === m.value ? ' is-active' : ''}`}
              onClick={() => setMetric(m.value)}
              disabled={viewMode === 'products' && selectedProducts.length === 1}
              title={
                viewMode === 'products' && selectedProducts.length === 1
                  ? 'Для одного товара на графике сразу выручка и штуки'
                  : undefined
              }
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="product-dynamics__toggle-group" role="group" aria-label="Режим графика">
          <span className="product-dynamics__toggle-label">График</span>
          {VIEW_MODES.map((v) => (
            <button
              key={v.value}
              type="button"
              className={`product-dynamics__toggle${viewMode === v.value ? ' is-active' : ''}`}
              onClick={() => setViewMode(v.value)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {viewMode === 'compare' && (
          <label className="sales-analytics__filter">
            <span>МП для сравнения</span>
            <select value={compareMp} onChange={(e) => setCompareMp(e.target.value)}>
              <option value="all">Итого по всем МП</option>
              {MARKETPLACE_OPTIONS.filter((o) => o.value !== 'all').map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          variant="secondary"
          size="small"
          onClick={addComparePeriod}
          disabled={comparePeriods.length >= 3}
        >
          + Период для сравнения
        </Button>
      </div>

      {comparePeriods.length > 0 && (
        <div className="product-dynamics__compare-list">
          <div className="product-dynamics__compare-item">
            <strong>Основной:</strong>
            <span>
              {dateFrom} — {dateTo}
            </span>
          </div>
          {comparePeriods.map((p, idx) => (
            <div key={p.id} className="product-dynamics__compare-item">
              <label>
                Название
                <input
                  type="text"
                  value={p.label}
                  onChange={(e) => updateComparePeriod(idx, { label: e.target.value })}
                />
              </label>
              <label>
                С
                <input
                  type="date"
                  value={p.dateFrom}
                  onChange={(e) => updateComparePeriod(idx, { dateFrom: e.target.value })}
                />
              </label>
              <label>
                По
                <input
                  type="date"
                  value={p.dateTo}
                  onChange={(e) => updateComparePeriod(idx, { dateTo: e.target.value })}
                />
              </label>
              <Button variant="secondary" size="small" onClick={() => removeComparePeriod(idx)}>
                Убрать
              </Button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="sales-analytics__error">{error}</div>}

      {primary && (
        <div className="product-dynamics__summary-cards">
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Товаров</div>
            <div className="product-dynamics__summary-card-value">
              {formatMetricValue('soldQty', primary.totals?.productsCount || products.length)}
            </div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Штуки</div>
            <div className="product-dynamics__summary-card-value">
              {formatMetricValue('soldQty', primary.totals?.soldQty)}
            </div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Выручка</div>
            <div className="product-dynamics__summary-card-value">
              {formatMetricValue('soldAmount', primary.totals?.soldAmount)}
            </div>
          </div>
        </div>
      )}

      <div className="product-dynamics__chart-wrap">
        <h3 className="product-dynamics__chart-title">{chartTitle}</h3>
        {!loading && chart.data.length === 0 && (
          <div className="product-dynamics__empty-chart">
            {data == null
              ? 'Выберите параметры и нажмите «Показать».'
              : selectedKeys.length === 0
                ? 'Выберите товар в таблице ниже.'
                : 'Нет данных за выбранный период. Загрузите отчёты FBO/FBS.'}
          </div>
        )}
        {chart.data.length > 0 && (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={chart.data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} interval="preserveStartEnd" />
              {chart.dual ? (
                <>
                  <YAxis
                    yAxisId="amount"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => formatMetricValue('soldAmount', v)}
                    width={72}
                  />
                  <YAxis
                    yAxisId="qty"
                    orientation="right"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => formatMetricValue('soldQty', v)}
                    width={48}
                  />
                </>
              ) : (
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => formatMetricValue(metric, v)}
                  width={72}
                />
              )}
              <Tooltip content={<CustomTooltip metric={metric} dual={chart.dual} />} />
              <Legend />
              {chart.seriesKeys.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  yAxisId={chart.dual ? s.yAxisId || 'amount' : undefined}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
        <p className="product-dynamics__legend-hint">
          {viewMode === 'products'
            ? selectedProducts.length === 1
              ? 'Синяя линия — выручка, зелёная — штуки. Выберите другой артикул в таблице или отметьте несколько для сравнения.'
              : 'Линии — выбранные артикулы (до 8). Клик по строке таблицы добавляет/убирает товар.'
            : viewMode === 'marketplace'
              ? 'Линии — маркетплейсы для выбранного товара (или суммарно).'
              : 'Линии — периоды сравнения. Ось X — порядковый номер интервала.'}
        </p>
      </div>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 16 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <th style={{ width: 36 }} />
              <SortableTh sortKey="article" sort={sort} onSort={toggleSort}>
                Артикул
              </SortableTh>
              <SortableTh sortKey="productName" sort={sort} onSort={toggleSort}>
                Товар
              </SortableTh>
              <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Штуки
              </SortableTh>
              <SortableTh
                sortKey="soldAmount"
                sort={sort}
                onSort={toggleSort}
                className="sales-analytics__num"
              >
                Сумма продаж
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sortedProducts.length === 0 && (
              <tr>
                <td colSpan={5} className="sales-analytics__empty">
                  Нет продаж за период. Сначала загрузите отчёты FBO/FBS.
                </td>
              </tr>
            )}
            {sortedProducts.map((p) => {
              const key = productRowKey(p);
              const active = selectedKeys.includes(key);
              return (
                <tr
                  key={key}
                  className={`product-dynamics__product-row${active ? ' is-selected' : ''}`}
                  onClick={() => toggleProduct(key)}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleProduct(key)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Показать на графике ${p.erpSku || p.sku}`}
                    />
                  </td>
                  <td>
                    <strong>{p.erpSku || p.sku || '—'}</strong>
                  </td>
                  <td>{p.productName || '—'}</td>
                  <td className="sales-analytics__num">{formatMetricValue('soldQty', p.soldQty)}</td>
                  <td className="sales-analytics__num">
                    {formatMetricValue('soldAmount', p.soldAmount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedProducts.length === 1 && selectedProducts[0]?.buckets?.length > 0 && (
        <div className="sales-analytics__table-wrap" style={{ marginTop: 16 }}>
          <table className="sales-analytics__table">
            <thead>
              <tr>
                <th>Интервал</th>
                <th>МП</th>
                <th className="sales-analytics__num">Штуки</th>
                <th className="sales-analytics__num">Выручка</th>
              </tr>
            </thead>
            <tbody>
              {(selectedProducts[0].buckets || []).flatMap((bucket) => {
                const mps = Object.keys(bucket.marketplaces || {});
                if (!mps.length) {
                  return [
                    <tr key={`${bucket.bucket}-total`}>
                      <td>{bucket.bucketLabel}</td>
                      <td>—</td>
                      <td className="sales-analytics__num">
                        {formatMetricValue('soldQty', bucket.soldQty)}
                      </td>
                      <td className="sales-analytics__num">
                        {formatMetricValue('soldAmount', bucket.soldAmount)}
                      </td>
                    </tr>,
                  ];
                }
                return mps.map((mp) => (
                  <tr key={`${bucket.bucket}-${mp}`}>
                    <td>{bucket.bucketLabel}</td>
                    <td className="product-dynamics__table-mp">{marketplaceLabel(mp)}</td>
                    <td className="sales-analytics__num">
                      {formatMetricValue('soldQty', bucket.marketplaces[mp]?.soldQty)}
                    </td>
                    <td className="sales-analytics__num">
                      {formatMetricValue('soldAmount', bucket.marketplaces[mp]?.soldAmount)}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="sales-analytics__hint">
        Источник — финансовые отчёты FBO/FBS (операции «Продажа»). В таблице — итог за период по каждому
        артикулу; клик отмечает товар для графика (до 8). Для одного товара график показывает и выручку, и
        штуки.
      </p>
    </div>
  );
}
