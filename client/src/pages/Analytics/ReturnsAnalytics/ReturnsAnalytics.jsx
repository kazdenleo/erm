/**
 * Аналитика возвратов и отмен: доля по товару, причины, обратная логистика, пометка «много возвратов».
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { rangeLastDays } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import {
  Badge,
  LongPeriodFilters,
  MARKETPLACE_OPTIONS,
  NumberFilter,
  ProductCell,
  SCHEME_OPTIONS,
  SelectFilter,
  SummaryCards,
  ToggleGroup,
  errorMessage,
  formatPercent,
  formatQty,
  formatRub,
  marketplaceLabel,
} from '../shared/analyticsKit';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

const SORT_GETTERS = {
  product: (r) => r.productSku || '',
  marketplace: (r) => r.marketplace || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  returnedQty: (r) => Number(r.returnedQty) || 0,
  returnRate: (r) => Number(r.returnRate) || 0,
  returnedAmount: (r) => Number(r.returnedAmount) || 0,
  nonPurchaseQty: (r) => Number(r.nonPurchaseQty) || 0,
  nonPurchaseRate: (r) => Number(r.nonPurchaseRate) || 0,
  reverseLogisticsCost: (r) => Number(r.reverseLogisticsCost) || 0,
  reverseCostPerSale: (r) => Number(r.reverseCostPerSale) || 0,
  cancelRate: (r) => Number(r.cancelRate) || 0,
  topReasonLabel: (r) => r.topReasonLabel || '',
};

const VIEW_FILTERS = [
  { value: 'flagged', label: 'Много возвратов' },
  { value: 'returns', label: 'С возвратами' },
  { value: 'all', label: 'Все' },
];

export function ReturnsAnalytics() {
  const initial = useMemo(() => rangeLastDays(90), []);
  const [periodPreset, setPeriodPreset] = useState('90');
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [minReturns, setMinReturns] = useState('3');
  const [ratePercent, setRatePercent] = useState('10');
  const [view, setView] = useState('flagged');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const { sort, toggleSort } = useTableSort('returnRate', 'desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getReturns({ dateFrom, dateTo, marketplace, scheme, minReturns, ratePercent });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить возвраты'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme, minReturns, ratePercent]);

  useEffect(() => {
    load();
  }, [load]);

  const all = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data]);
  const items = useMemo(() => {
    if (view === 'flagged') return all.filter((r) => r.highReturns);
    if (view === 'returns') return all.filter((r) => Number(r.returnedQty) > 0 || Number(r.cancelled) > 0);
    return all;
  }, [all, view]);
  const sorted = useMemo(() => sortRows(items, sort, SORT_GETTERS), [items, sort]);
  const summary = data?.summary || {};
  const reasons = Array.isArray(summary.reasons) ? summary.reasons : [];
  const byMp = Array.isArray(summary.byMarketplace) ? summary.byMarketplace : [];
  const reasonsTotal = reasons.reduce((s, r) => s + (Number(r.count) || 0), 0);

  const viewOptions = VIEW_FILTERS.map((f) => ({
    ...f,
    count:
      f.value === 'flagged'
        ? all.filter((r) => r.highReturns).length
        : f.value === 'returns'
          ? all.filter((r) => Number(r.returnedQty) > 0 || Number(r.cancelled) > 0).length
          : all.length,
  }));

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-refresh-2"
        iconBgClass="bg-sunny-morning"
        title="Возвраты и отмены"
        subtitle="Доля возвратов по товару, причины и стоимость обратной логистики"
      />

      <div className="sales-analytics__filters erp-filter-bar">
        <LongPeriodFilters
          periodPreset={periodPreset}
          setPeriodPreset={setPeriodPreset}
          dateFrom={dateFrom}
          dateTo={dateTo}
          setDateFrom={setDateFrom}
          setDateTo={setDateTo}
        />
        <SelectFilter label="Схема" value={scheme} onChange={setScheme} options={SCHEME_OPTIONS} />
        <SelectFilter label="Маркетплейс" value={marketplace} onChange={setMarketplace} options={MARKETPLACE_OPTIONS} />
        <NumberFilter
          label="Мин. возвратов"
          value={minReturns}
          onChange={setMinReturns}
          min={1}
          width={70}
          title="Пометка ставится, если возвратов не меньше этого числа"
        />
        <NumberFilter
          label="Порог, %"
          value={ratePercent}
          onChange={setRatePercent}
          min={1}
          width={70}
          title="…и доля возвратов не меньше порога"
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
              label: 'Возвраты',
              value: formatPercent(summary.returnRate),
              sub: `${formatQty(summary.returnedQty, 0)} из ${formatQty(summary.soldQty, 0)} шт · ${formatRub(
                summary.returnedAmount
              )}`,
            },
            {
              label: 'Невыкупы',
              value: formatPercent(summary.nonPurchaseRate),
              sub: `${formatQty(summary.nonPurchaseQty, 0)} шт`,
              title: 'Отказ покупателя до выкупа (возврат на склад без продажи)',
            },
            {
              label: 'Обратная логистика',
              value: formatRub(summary.reverseLogisticsCost),
              tone: 'danger',
              title: 'Стоимость доставки возвратов и невыкупов обратно',
            },
            {
              label: 'Отмены заказов',
              value: formatPercent(summary.cancelRate),
              sub: `${formatQty(summary.cancelled, 0)} из ${formatQty(summary.orders, 0)}`,
            },
            {
              label: 'Много возвратов',
              value: formatQty(summary.flaggedCount, 0),
              tone: Number(summary.flaggedCount) > 0 ? 'warning' : undefined,
              sub: 'товаров с пометкой',
            },
          ]}
        />
      )}

      {data && (
        <div className="analytics-kit__grid-2">
          <div className="analytics-kit__panel">
            <h3 className="analytics-kit__section-title">Причины возвратов</h3>
            {reasons.length === 0 ? (
              <div className="sales-analytics__hint">
                Причины берутся из заявок на возврат (раздел «Возвраты»). За период заявок нет.
              </div>
            ) : (
              <table className="sales-analytics__table">
                <tbody>
                  {reasons.map((r) => (
                    <tr key={r.code}>
                      <td>{r.label}</td>
                      <td className="sales-analytics__num">{formatQty(r.count, 0)}</td>
                      <td className="sales-analytics__num">
                        {formatPercent(reasonsTotal ? (r.count / reasonsTotal) * 100 : 0, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="sales-analytics__hint">Заявок с причиной: {formatQty(summary.claimsCount, 0)}</div>
          </div>
          <div className="analytics-kit__panel">
            <h3 className="analytics-kit__section-title">По маркетплейсам</h3>
            <table className="sales-analytics__table">
              <thead>
                <tr>
                  <th>МП</th>
                  <th className="sales-analytics__num">Возвраты</th>
                  <th className="sales-analytics__num">Невыкупы, шт</th>
                  <th className="sales-analytics__num">Обр. логистика</th>
                  <th className="sales-analytics__num">Отмены</th>
                </tr>
              </thead>
              <tbody>
                {byMp.map((m) => (
                  <tr key={m.marketplace}>
                    <td>{m.label || marketplaceLabel(m.marketplace)}</td>
                    <td className="sales-analytics__num">
                      {formatPercent(m.returnRate)} ({formatQty(m.returnedQty, 0)})
                    </td>
                    <td className="sales-analytics__num">{formatQty(m.nonPurchaseQty, 0)}</td>
                    <td className="sales-analytics__num">{formatRub(m.reverseLogisticsCost)}</td>
                    <td className="sales-analytics__num">
                      {formatQty(m.cancelled, 0)} / {formatQty(m.orders, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="product-dynamics__controls-row">
        <ToggleGroup label="Показать" value={view} onChange={setView} options={viewOptions} disabled={!data} />
      </div>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <SortableTh sortKey="product" sort={sort} onSort={toggleSort}>
                Товар
              </SortableTh>
              <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
                МП
              </SortableTh>
              <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Продано
              </SortableTh>
              <SortableTh sortKey="returnedQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Возвращено
              </SortableTh>
              <SortableTh sortKey="returnRate" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                % возвр.
              </SortableTh>
              <SortableTh sortKey="nonPurchaseRate" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                % невыкупа
              </SortableTh>
              <SortableTh
                sortKey="reverseLogisticsCost"
                sort={sort}
                onSort={toggleSort}
                className="sales-analytics__num"
              >
                Обр. логистика
              </SortableTh>
              <SortableTh
                sortKey="reverseCostPerSale"
                sort={sort}
                onSort={toggleSort}
                className="sales-analytics__num"
                title="Обратная логистика на одну продажу"
              >
                На продажу
              </SortableTh>
              <SortableTh sortKey="cancelRate" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                % отмен
              </SortableTh>
              <SortableTh sortKey="topReasonLabel" sort={sort} onSort={toggleSort}>
                Причина / пометка
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="sales-analytics__empty">
                  {view === 'flagged' ? 'Товаров с большим числом возвратов нет' : 'Нет данных'}
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={`${r.marketplace}|${r.productId}`}>
                <td>
                  <ProductCell sku={r.productSku} name={r.productName} />
                </td>
                <td>{marketplaceLabel(r.marketplace)}</td>
                <td className="sales-analytics__num">{formatQty(r.soldQty, 0)}</td>
                <td className="sales-analytics__num">{formatQty(r.returnedQty, 0)}</td>
                <td className="sales-analytics__num">{formatPercent(r.returnRate)}</td>
                <td className="sales-analytics__num">{formatPercent(r.nonPurchaseRate)}</td>
                <td className="sales-analytics__num">{formatRub(r.reverseLogisticsCost)}</td>
                <td className="sales-analytics__num">{formatRub(r.reverseCostPerSale)}</td>
                <td className="sales-analytics__num">
                  {r.orders ? `${formatPercent(r.cancelRate, 0)} (${formatQty(r.cancelled, 0)})` : '—'}
                </td>
                <td className="analytics-kit__hint-cell">
                  {r.highReturns ? (
                    <Badge tone="danger" title={r.flagHint}>
                      Много возвратов
                    </Badge>
                  ) : null}{' '}
                  {r.topReasonLabel ? <Badge tone="neutral">{r.topReasonLabel}</Badge> : null}
                  {r.highReturns && r.flagHint ? <div>{r.flagHint}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Возвраты и невыкупы — из финансовых отчётов маркетплейсов, отмены — из заказов. Пометка «Много возвратов»
        ставится при {minReturns || 3}+ возвратах и доле от {ratePercent || 10}%; она же видна в «Работе с карточками».
      </p>
    </div>
  );
}
