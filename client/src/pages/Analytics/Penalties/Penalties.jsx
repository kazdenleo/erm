/**
 * Штрафы и удержания: типы штрафов, товары, компенсации, перемер габаритов, задержки выплат.
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
  formatDateRu,
  formatPercent,
  formatQty,
  formatRub,
  marketplaceLabel,
} from '../shared/analyticsKit';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

const TABS = [
  { value: 'types', label: 'Типы штрафов' },
  { value: 'products', label: 'По товарам' },
  { value: 'compensations', label: 'Компенсации' },
  { value: 'dims', label: 'Габариты' },
  { value: 'unpaid', label: 'Не начислено' },
];

export function Penalties() {
  const initial = useMemo(() => rangeLastDays(90), []);
  const [periodPreset, setPeriodPreset] = useState('90');
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [unpaidAfterDays, setUnpaidAfterDays] = useState('14');
  const [tab, setTab] = useState('types');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getPenalties({ dateFrom, dateTo, marketplace, scheme, unpaidAfterDays });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить штрафы'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme, unpaidAfterDays]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary || {};
  const byCategory = Object.entries(summary.byCategory || {}).filter(([, v]) => Number(v?.count) > 0);
  const tabOptions = TABS.map((t) => ({
    ...t,
    count:
      t.value === 'types'
        ? data?.penaltyTypes?.length
        : t.value === 'products'
          ? data?.penaltyProducts?.length
          : t.value === 'compensations'
            ? data?.compensations?.length
            : t.value === 'dims'
              ? data?.dimensionIssues?.length
              : data?.unpaid?.length,
  }));

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-attention"
        iconBgClass="bg-happy-itmeo"
        title="Штрафы и удержания"
        subtitle="Штрафы маркетплейсов, перемер габаритов, заниженные компенсации и задержки выплат"
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
          label="Не начислено через, дн."
          value={unpaidAfterDays}
          onChange={setUnpaidAfterDays}
          min={1}
          width={70}
          title="Доставленный заказ считается неоплаченным, если за столько дней продажа не появилась в финотчёте"
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
              label: 'Штрафы',
              value: formatRub(summary.penaltyTotal),
              tone: 'danger',
              sub: `${formatQty(summary.penaltyCount, 0)} шт · ${Object.entries(summary.byMarketplace || {})
                .filter(([, v]) => Number(v) > 0)
                .map(([mp, v]) => `${marketplaceLabel(mp)} ${formatRub(v)}`)
                .join(' · ')}`,
            },
            {
              label: 'Компенсации',
              value: formatRub(summary.compensationTotal),
              tone: 'success',
              sub: `${formatQty(summary.compensationCount, 0)} шт · занижено ${formatQty(summary.underpaidCount, 0)}`,
            },
            Number(summary.underpaidShortfall) > 0
              ? { label: 'Недоплата по компенсациям', value: formatRub(summary.underpaidShortfall), tone: 'warning' }
              : null,
            {
              label: 'Расхождения габаритов',
              value: formatQty(summary.dimensionIssuesCount, 0),
              tone: Number(summary.dimensionIssuesCount) > 0 ? 'warning' : undefined,
              sub: 'товаров: ERP ≠ карточка МП',
            },
            {
              label: 'Не начислено',
              value: formatRub(summary.unpaidAmount),
              tone: Number(summary.unpaidCount) > 0 ? 'danger' : undefined,
              sub: `${formatQty(summary.unpaidCount, 0)} доставленных заказов без выплаты`,
            },
          ]}
        />
      )}

      {data && byCategory.length > 0 && (
        <div className="product-dynamics__controls-row">
          {byCategory.map(([code, v]) => (
            <Badge key={code} tone={code === 'dims' ? 'danger' : 'neutral'}>
              {v.label}: {formatRub(v.amount)} ({formatQty(v.count, 0)})
            </Badge>
          ))}
        </div>
      )}

      {data && Array.isArray(data.payoutLag) && data.payoutLag.length > 0 && (
        <div className="analytics-kit__section analytics-kit__panel">
          <h3 className="analytics-kit__section-title">Скорость выплат</h3>
          <table className="sales-analytics__table">
            <thead>
              <tr>
                <th>МП</th>
                <th className="sales-analytics__num">Доставлено заказов</th>
                <th className="sales-analytics__num">Найдено в отчётах</th>
                <th className="sales-analytics__num">Средняя задержка, дн.</th>
                <th className="sales-analytics__num">Медиана, дн.</th>
                <th className="sales-analytics__num">Не начислено</th>
              </tr>
            </thead>
            <tbody>
              {data.payoutLag.map((m) => (
                <tr key={m.marketplace}>
                  <td>{m.label || marketplaceLabel(m.marketplace)}</td>
                  <td className="sales-analytics__num">{formatQty(m.deliveredOrders, 0)}</td>
                  <td className="sales-analytics__num">{formatQty(m.matched, 0)}</td>
                  <td className="sales-analytics__num">{formatQty(m.avgLagDays, 1)}</td>
                  <td className="sales-analytics__num">{formatQty(m.medianLagDays, 1)}</td>
                  <td className="sales-analytics__num">
                    {Number(m.unpaidCount) > 0 ? `${formatQty(m.unpaidCount, 0)} · ${formatRub(m.unpaidAmount)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="product-dynamics__controls-row" style={{ marginTop: 16 }}>
        <ToggleGroup value={tab} onChange={setTab} options={tabOptions} disabled={!data} />
      </div>

      {data && tab === 'types' && <TypesTable rows={data.penaltyTypes || []} loading={loading} />}
      {data && tab === 'products' && <ProductsTable rows={data.penaltyProducts || []} loading={loading} />}
      {data && tab === 'compensations' && <CompensationsTable rows={data.compensations || []} loading={loading} />}
      {data && tab === 'dims' && (
        <DimsTable rows={data.dimensionIssues || []} median={data.mpLogisticsMedian || {}} loading={loading} />
      )}
      {data && tab === 'unpaid' && <UnpaidTable rows={data.unpaid || []} loading={loading} />}

      <p className="sales-analytics__hint">
        Штрафы и компенсации — из финансовых отчётов. Компенсация считается заниженной, если она меньше себестоимости или
        половины средней цены продажи. «Габариты» — товары, у которых размеры в ERP и на маркетплейсе расходятся (как в
        «Работе с карточками»), с логистикой на единицу и штрафами за перемер. «Не начислено» — доставленные заказы, по
        которым за {unpaidAfterDays || 14}+ дн. нет продажи в загруженных отчётах.
      </p>
    </div>
  );
}

function EmptyRow({ colSpan, loading, text = 'Нет данных' }) {
  if (loading) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="sales-analytics__empty">
        {text}
      </td>
    </tr>
  );
}

function TypesTable({ rows, loading }) {
  const { sort, toggleSort } = useTableSort('amount', 'desc');
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  return (
    <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
      <table className="sales-analytics__table">
        <thead>
          <tr>
            <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
              МП
            </SortableTh>
            <SortableTh sortKey="name" sort={sort} onSort={toggleSort}>
              Тип удержания
            </SortableTh>
            <SortableTh sortKey="categoryLabel" sort={sort} onSort={toggleSort}>
              Категория
            </SortableTh>
            <SortableTh sortKey="count" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Кол-во
            </SortableTh>
            <SortableTh sortKey="amount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Сумма
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <EmptyRow colSpan={5} loading={loading} text="Штрафов за период нет" />}
          {sorted.map((r) => (
            <tr key={`${r.marketplace}|${r.name}`}>
              <td>{marketplaceLabel(r.marketplace)}</td>
              <td>{r.name}</td>
              <td>
                <Badge tone={r.category === 'dims' ? 'danger' : 'neutral'}>{r.categoryLabel}</Badge>
              </td>
              <td className="sales-analytics__num">{formatQty(r.count, 0)}</td>
              <td className="sales-analytics__num">{formatRub(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductsTable({ rows, loading }) {
  const { sort, toggleSort } = useTableSort('amount', 'desc');
  const sorted = useMemo(
    () => sortRows(rows, sort, { product: (r) => r.productSku || '' }),
    [rows, sort]
  );
  return (
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
            <SortableTh sortKey="topCategoryLabel" sort={sort} onSort={toggleSort}>
              Основная причина
            </SortableTh>
            <SortableTh sortKey="count" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Кол-во
            </SortableTh>
            <SortableTh sortKey="amount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Сумма
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <EmptyRow colSpan={5} loading={loading} text="Штрафов по товарам нет" />}
          {sorted.map((r) => (
            <tr key={`${r.marketplace}|${r.productId}`}>
              <td>
                <ProductCell sku={r.productSku} name={r.productName} />
              </td>
              <td>{marketplaceLabel(r.marketplace)}</td>
              <td>{r.topCategoryLabel || '—'}</td>
              <td className="sales-analytics__num">{formatQty(r.count, 0)}</td>
              <td className="sales-analytics__num">{formatRub(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompensationsTable({ rows, loading }) {
  const { sort, toggleSort } = useTableSort('date', 'desc');
  const sorted = useMemo(
    () => sortRows(rows, sort, { product: (r) => r.productSku || '' }),
    [rows, sort]
  );
  return (
    <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
      <table className="sales-analytics__table">
        <thead>
          <tr>
            <SortableTh sortKey="date" sort={sort} onSort={toggleSort}>
              Дата
            </SortableTh>
            <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
              МП
            </SortableTh>
            <SortableTh sortKey="product" sort={sort} onSort={toggleSort}>
              Товар
            </SortableTh>
            <SortableTh sortKey="operationType" sort={sort} onSort={toggleSort}>
              Операция
            </SortableTh>
            <SortableTh sortKey="amount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Сумма
            </SortableTh>
            <SortableTh sortKey="perUnit" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              За шт
            </SortableTh>
            <SortableTh sortKey="cost" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Себестоимость
            </SortableTh>
            <SortableTh sortKey="percentOfPrice" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              % от цены
            </SortableTh>
            <SortableTh sortKey="shortfall" sort={sort} onSort={toggleSort}>
              Оценка
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <EmptyRow colSpan={9} loading={loading} text="Компенсаций за период нет" />}
          {sorted.map((r, i) => (
            <tr key={`${r.marketplace}|${r.orderId}|${r.date}|${i}`}>
              <td>{formatDateRu(r.date)}</td>
              <td>{marketplaceLabel(r.marketplace)}</td>
              <td>
                <ProductCell sku={r.productSku} name={r.productName} />
              </td>
              <td className="analytics-kit__hint-cell">
                {r.operationType}
                {r.orderId ? <div>Заказ {r.orderId}</div> : null}
              </td>
              <td className="sales-analytics__num">{formatRub(r.amount)}</td>
              <td className="sales-analytics__num">{formatRub(r.perUnit)}</td>
              <td className="sales-analytics__num">{formatRub(r.cost)}</td>
              <td className="sales-analytics__num">{formatPercent(r.percentOfPrice, 0)}</td>
              <td>
                {r.underpaid ? (
                  <Badge tone="danger" title={`Недоплата ≈ ${formatRub(r.shortfall)}`}>
                    {r.belowCost ? 'Ниже себестоимости' : 'Занижена'}
                  </Badge>
                ) : (
                  <Badge tone="success">Ок</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DimsTable({ rows, median, loading }) {
  const { sort, toggleSort } = useTableSort('logisticsAmount', 'desc');
  const sorted = useMemo(
    () => sortRows(rows, sort, { product: (r) => r.productSku || '' }),
    [rows, sort]
  );
  return (
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
            <SortableTh sortKey="hint" sort={sort} onSort={toggleSort}>
              Расхождение
            </SortableTh>
            <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Продано
            </SortableTh>
            <SortableTh
              sortKey="logisticsPerUnit"
              sort={sort}
              onSort={toggleSort}
              className="sales-analytics__num"
              title="Логистика на единицу; в скобках — медиана по маркетплейсу"
            >
              Логистика/шт
            </SortableTh>
            <SortableTh sortKey="logisticsAmount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Логистика всего
            </SortableTh>
            <SortableTh sortKey="dimsPenalty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Штраф за перемер
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <EmptyRow colSpan={7} loading={loading} text="Расхождений габаритов нет" />}
          {sorted.map((r) => {
            const med = Number(median[r.marketplace]) || 0;
            const high = med > 0 && Number(r.logisticsPerUnit) > med * 1.3;
            return (
              <tr key={`${r.marketplace}|${r.productId}`}>
                <td>
                  <ProductCell sku={r.productSku} name={r.productName} />
                </td>
                <td>{marketplaceLabel(r.marketplace)}</td>
                <td className="analytics-kit__hint-cell">{r.hint}</td>
                <td className="sales-analytics__num">{formatQty(r.soldQty, 0)}</td>
                <td className={`sales-analytics__num${high ? ' analytics-kit__neg' : ''}`}>
                  {Number(r.soldQty) > 0 ? formatRub(r.logisticsPerUnit) : '—'}
                  {med > 0 ? <div className="analytics-kit__product-name">({formatRub(med)})</div> : null}
                </td>
                <td className="sales-analytics__num">{formatRub(r.logisticsAmount)}</td>
                <td className="sales-analytics__num">
                  {Number(r.dimsPenalty) > 0 ? <Badge tone="danger">{formatRub(r.dimsPenalty)}</Badge> : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UnpaidTable({ rows, loading }) {
  const { sort, toggleSort } = useTableSort('daysSinceDelivery', 'desc');
  const sorted = useMemo(
    () => sortRows(rows, sort, { product: (r) => r.productSku || '' }),
    [rows, sort]
  );
  return (
    <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
      <table className="sales-analytics__table">
        <thead>
          <tr>
            <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
              МП
            </SortableTh>
            <SortableTh sortKey="orderId" sort={sort} onSort={toggleSort}>
              Заказ
            </SortableTh>
            <SortableTh sortKey="product" sort={sort} onSort={toggleSort}>
              Товар
            </SortableTh>
            <SortableTh sortKey="deliveredAt" sort={sort} onSort={toggleSort}>
              Доставлен
            </SortableTh>
            <SortableTh sortKey="daysSinceDelivery" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Дней прошло
            </SortableTh>
            <SortableTh sortKey="amount" sort={sort} onSort={toggleSort} className="sales-analytics__num">
              Сумма заказа
            </SortableTh>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <EmptyRow colSpan={6} loading={loading} text="Все доставленные заказы оплачены" />}
          {sorted.map((r) => (
            <tr key={`${r.marketplace}|${r.orderId}|${r.productId}`}>
              <td>{marketplaceLabel(r.marketplace)}</td>
              <td>{r.orderId}</td>
              <td>
                <ProductCell sku={r.productSku} name={r.productName} />
              </td>
              <td>{formatDateRu(r.deliveredAt)}</td>
              <td className="sales-analytics__num">{formatQty(r.daysSinceDelivery, 0)}</td>
              <td className="sales-analytics__num">{formatRub(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
