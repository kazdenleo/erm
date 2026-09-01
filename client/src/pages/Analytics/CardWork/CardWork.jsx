/**
 * Очередь карточек, с которыми нужно провести работу.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';
import './CardWork.css';

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

const REASON_FILTERS = [
  { value: 'all', label: 'Все причины' },
  { value: 'high_turnover', label: 'Высокая оборачиваемость' },
  { value: 'overstock', label: 'Затоварен / не продаётся' },
  { value: 'stockout', label: 'Нет остатка' },
];

const SORT_GETTERS = {
  article: (r) => r.erpSku || r.sku || '',
  productName: (r) => r.productName || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  stockQty: (r) => Number(r.stockQty) || 0,
  primary: (r) => r.primaryReason?.label || '',
  severity: (r) => (r.severity === 'high' ? 0 : 1),
};

function formatQty(n) {
  if (!Number.isFinite(Number(n))) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(n));
}

export function CardWork() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [reason, setReason] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const { sort, toggleSort } = useTableSort('severity', 'asc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getCardWork({
        dateFrom,
        dateTo,
        marketplace,
        scheme,
      });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить очередь карточек');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  const items = useMemo(() => {
    const list = Array.isArray(data?.items) ? data.items : [];
    const filtered =
      reason === 'all' ? list : list.filter((i) => (i.reasonCodes || []).includes(reason));
    return sortRows(filtered, sort, SORT_GETTERS);
  }, [data, reason, sort]);
  const summary = data?.summary || {};

  return (
    <div className="sales-analytics card-work">
      <PageTitle
        iconClass="pe-7s-note2"
        iconBgClass="bg-mean-fruit"
        title="Работа с карточками"
        subtitle="Карточки, с которыми нужно провести работу: слишком высокая оборачиваемость, затоваривание, нет остатка"
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
        <div className="product-dynamics__toggle-group" role="group" aria-label="Причина">
          <span className="product-dynamics__toggle-label">Причина</span>
          {REASON_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`product-dynamics__toggle${reason === f.value ? ' is-active' : ''}`}
              onClick={() => setReason(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      {data && (
        <div className="product-dynamics__summary-cards">
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Карточек к работе</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.cardsCount)}</div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Высокая оборачиваемость</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.highTurnoverCount)}</div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Затоварен / не продаётся</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.overstockCount)}</div>
          </div>
          <div className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">Нет остатка</div>
            <div className="product-dynamics__summary-card-value">{formatQty(summary.stockoutCount)}</div>
          </div>
        </div>
      )}

      <div className="sales-analytics__table-wrap" style={{ marginTop: 16 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <SortableTh sortKey="article" sort={sort} onSort={toggleSort}>
                Артикул
              </SortableTh>
              <SortableTh sortKey="productName" sort={sort} onSort={toggleSort}>
                Карточка
              </SortableTh>
              <SortableTh sortKey="primary" sort={sort} onSort={toggleSort}>
                Что сделать
              </SortableTh>
              <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Продано, шт
              </SortableTh>
              <SortableTh sortKey="stockQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Остаток МП
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && items.length === 0 && (
              <tr>
                <td colSpan={5} className="sales-analytics__empty">
                  Нет карточек, требующих работы, по выбранным фильтрам.
                </td>
              </tr>
            )}
            {data == null && !loading && (
              <tr>
                <td colSpan={5} className="sales-analytics__empty">
                  Выберите период и нажмите «Показать».
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr
                key={`${row.productId || 'x'}-${row.sku}`}
                className={row.severity === 'high' ? 'card-work__severity-high' : undefined}
              >
                <td>
                  {row.productId ? (
                    <Link className="card-work__link" to={`/products/${row.productId}`}>
                      {row.erpSku || row.sku || '—'}
                    </Link>
                  ) : (
                    <strong>{row.erpSku || row.sku || '—'}</strong>
                  )}
                </td>
                <td>
                  {row.productId ? (
                    <Link className="card-work__link" to={`/products/${row.productId}`}>
                      {row.productName || '—'}
                    </Link>
                  ) : (
                    row.productName || '—'
                  )}
                </td>
                <td>
                  {(row.reasons || []).map((r) => (
                    <span key={`${r.code}-${r.marketplace}`} className={`card-work__reason card-work__reason--${r.code}`}>
                      {r.label}
                    </span>
                  ))}
                  {(row.reasons || []).map((r) => (
                    <p key={`${r.code}-${r.marketplace}-h`} className="card-work__hint">
                      {r.hint}
                    </p>
                  ))}
                </td>
                <td className="sales-analytics__num">{formatQty(row.soldQty)}</td>
                <td className="sales-analytics__num">{formatQty(row.stockQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Высокая оборачиваемость — остатка хватает меньше чем на 10 дней или продажи за период ≥ 1,5× остатка.
        Затоварен — запас больше 45 дней или продаж нет при остатке. Нет остатка — продажи есть, на складе МП 0.
        Клик по артикулу открывает карточку товара.
      </p>
    </div>
  );
}
