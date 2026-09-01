/**
 * Оборачиваемость товаров на маркетплейсах: продажи vs остаток на складах МП.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
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
import '../ProductDynamics/ProductDynamics.css';
import './ProductTurnover.css';

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

const STATUS_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'dead', label: 'Не продаётся' },
  { value: 'slow', label: 'Медленная' },
  { value: 'ok', label: 'Норма' },
  { value: 'fast', label: 'Быстрая' },
  { value: 'stockout', label: 'Нет остатка' },
];

const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс' };
const STATUS_COLORS = {
  dead: '#dc2626',
  slow: '#ea580c',
  ok: '#0284c7',
  fast: '#16a34a',
  stockout: '#7c3aed',
  empty: '#94a3b8',
};

const SORT_GETTERS = {
  article: (r) => r.erpSku || r.sku || '',
  productName: (r) => r.productName || '',
  marketplace: (r) => r.marketplace || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  soldAmount: (r) => Number(r.soldAmount) || 0,
  avgDaily: (r) => Number(r.avgDaily) || 0,
  stockQty: (r) => Number(r.stockQty) || 0,
  daysOfStock: (r) => (r.daysOfStock == null ? Number.POSITIVE_INFINITY : Number(r.daysOfStock)),
  turnover: (r) => (r.turnover == null ? -1 : Number(r.turnover)),
  statusLabel: (r) => r.statusLabel || '',
};

function formatQty(n) {
  if (!Number.isFinite(Number(n))) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(n));
}

function formatRub(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number(n));
}

function formatDays(n) {
  if (n == null || !Number.isFinite(Number(n))) return '∞';
  return formatQty(n);
}

function marketplaceLabel(mp) {
  return MP_LABELS[mp] || mp || '—';
}

function rowKey(r) {
  return `${r.marketplace}|${r.productId || 0}|${r.sku || ''}`;
}

export function ProductTurnover() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const { sort, toggleSort } = useTableSort('daysOfStock', 'desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getTurnover({
        dateFrom,
        dateTo,
        marketplace,
        scheme,
      });
      const next = res?.data ?? null;
      setData(next);
      const items = next?.items || [];
      setSelectedKeys(items.slice(0, 15).map(rowKey));
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить оборачиваемость');
      setData(null);
      setSelectedKeys([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  const items = useMemo(() => {
    const list = Array.isArray(data?.items) ? data.items : [];
    if (statusFilter === 'all') return list;
    return list.filter((r) => r.status === statusFilter);
  }, [data, statusFilter]);

  const sorted = useMemo(() => sortRows(items, sort, SORT_GETTERS), [items, sort]);

  const chartData = useMemo(() => {
    const selected = sorted.filter((r) => selectedKeys.includes(rowKey(r))).slice(0, 20);
    return selected.map((r) => ({
      key: rowKey(r),
      label: (r.erpSku || r.sku || '—').slice(0, 18),
      daysOfStock: r.daysOfStock == null ? null : Number(r.daysOfStock),
      stockQty: Number(r.stockQty) || 0,
      soldQty: Number(r.soldQty) || 0,
      status: r.status,
      name: r.productName,
    }));
  }, [sorted, selectedKeys]);

  const summary = data?.summary || {};

  const toggleRow = (key) => {
    setSelectedKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= 20) return [...prev.slice(1), key];
      return [...prev, key];
    });
  };

  return (
    <div className="sales-analytics product-turnover">
      <PageTitle
        iconClass="pe-7s-timer"
        iconBgClass="bg-mean-fruit"
        title="Оборачиваемость"
        subtitle="Остаток на складах маркетплейса и скорость продаж: дни запаса и коэффициент оборачиваемости"
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

      {error && <div className="sales-analytics__error">{error}</div>}

      {data && (
        <div className="product-dynamics__summary-cards">
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Строк</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.productsCount)}</div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Остаток на МП, шт</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.stockQty)}</div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Продано, шт</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.soldQty)}</div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Не продаётся / медленные</div>
            <div className="product-dynamics__summary-card-value">
              {formatQty(summary.deadCount)} / {formatQty(summary.slowCount)}
            </div>
          </div>
        </div>
      )}

      <div className="product-dynamics__controls-row">
        <div className="product-dynamics__toggle-group" role="group" aria-label="Статус">
          <span className="product-dynamics__toggle-label">Статус</span>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`product-dynamics__toggle${statusFilter === f.value ? ' is-active' : ''}`}
              onClick={() => setStatusFilter(f.value)}
              disabled={!data}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="product-dynamics__chart-wrap">
        <h3 className="product-dynamics__chart-title">Дней запаса по выбранным артикулам</h3>
        {!loading && chartData.length === 0 && (
          <div className="product-dynamics__empty-chart">
            {data == null
              ? 'Выберите период и нажмите «Показать».'
              : 'Отметьте товары в таблице или нет данных за период.'}
          </div>
        )}
        {chartData.length > 0 && (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-35} textAnchor="end" height={70} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(v, name) => [
                  name === 'daysOfStock' ? formatDays(v) : formatQty(v),
                  name === 'daysOfStock' ? 'Дней запаса' : name === 'stockQty' ? 'Остаток' : 'Продано',
                ]}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.name || ''}
              />
              <Legend />
              <Bar dataKey="daysOfStock" name="Дней запаса" maxBarSize={36}>
                {chartData.map((entry) => (
                  <Cell key={entry.key} fill={STATUS_COLORS[entry.status] || '#64748b'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
        <p className="product-dynamics__legend-hint">
          Дней запаса = остаток на складе МП ÷ средние продажи в день за выбранный период. ∞ — продаж не было.
          Оборачиваемость = продано шт ÷ остаток. Остатки — из последнего снапшота складов маркетплейса.
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
              <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
                МП
              </SortableTh>
              <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Продано, шт
              </SortableTh>
              <SortableTh sortKey="soldAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Сумма
              </SortableTh>
              <SortableTh sortKey="avgDaily" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Ср. в день
              </SortableTh>
              <SortableTh sortKey="stockQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Остаток МП
              </SortableTh>
              <SortableTh sortKey="daysOfStock" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Дней запаса
              </SortableTh>
              <SortableTh sortKey="turnover" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Оборач.
              </SortableTh>
              <SortableTh sortKey="statusLabel" sort={sort} onSort={toggleSort}>
                Статус
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sorted.length === 0 && (
              <tr>
                <td colSpan={11} className="sales-analytics__empty">
                  Нет данных. Нужны продажи в отчётах FBO/FBS и снапшот остатков МП (ночной импорт).
                </td>
              </tr>
            )}
            {sorted.map((r) => {
              const key = rowKey(r);
              const active = selectedKeys.includes(key);
              return (
                <tr
                  key={key}
                  className={`product-dynamics__product-row${active ? ' is-selected' : ''}`}
                  onClick={() => toggleRow(key)}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleRow(key)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td>
                    <strong>{r.erpSku || r.sku || '—'}</strong>
                  </td>
                  <td>{r.productName || '—'}</td>
                  <td>{marketplaceLabel(r.marketplace)}</td>
                  <td className="sales-analytics__num">{formatQty(r.soldQty)}</td>
                  <td className="sales-analytics__num">{formatRub(r.soldAmount)}</td>
                  <td className="sales-analytics__num">{formatQty(r.avgDaily)}</td>
                  <td className="sales-analytics__num">{formatQty(r.stockQty)}</td>
                  <td className="sales-analytics__num">{formatDays(r.daysOfStock)}</td>
                  <td className="sales-analytics__num">{r.turnover == null ? '—' : formatQty(r.turnover)}</td>
                  <td>
                    <span className={`product-turnover__status product-turnover__status--${r.status}`}>
                      {r.statusLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Продажи — из финансовых отчётов FBO/FBS за период ({data?.period?.days || '—'} дн.). Остаток — текущий
        склад маркетплейса (state «на складе МП»), не склад продавца FBS. Статусы: быстрая &lt; 14 дней запаса,
        норма 14–45, медленная &gt; 45; «не продаётся» — есть остаток без продаж.
      </p>
    </div>
  );
}
