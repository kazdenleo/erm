/**
 * Упущенная выручка: продажи, потерянные из-за отсутствия товара на складе МП (FBO) или у нас (FBS).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import {
  Badge,
  MARKETPLACE_OPTIONS,
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

const SORT_GETTERS = {
  product: (r) => r.productSku || '',
  marketplace: (r) => r.marketplace || '',
  scheme: (r) => r.scheme || '',
  oosDays: (r) => Number(r.oosDays) || 0,
  ratePerDay: (r) => Number(r.ratePerDay) || 0,
  lostUnits: (r) => Number(r.lostUnits) || 0,
  lostRevenue: (r) => Number(r.lostRevenue) || 0,
  lostProfit: (r) => Number(r.lostProfit) || 0,
  lastOosDay: (r) => r.lastOosDay || '',
};

const VIEW_FILTERS = [
  { value: 'all', label: 'Все' },
  { value: 'oosNow', label: 'Нет сейчас' },
  { value: 'fbo', label: 'Склад МП (FBO)' },
  { value: 'fbs', label: 'Наш склад (FBS)' },
];

export function LostRevenue() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [view, setView] = useState('all');
  const [hideLowData, setHideLowData] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const { sort, toggleSort } = useTableSort('lostRevenue', 'desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getLostRevenue({ dateFrom, dateTo, marketplace, scheme, limit: 1000 });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось рассчитать упущенную выручку'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => {
    let list = Array.isArray(data?.items) ? data.items : [];
    if (hideLowData) list = list.filter((r) => !r.insufficientData);
    if (view === 'oosNow') list = list.filter((r) => r.oosNow);
    if (view === 'fbo' || view === 'fbs') list = list.filter((r) => r.scheme === view);
    return list;
  }, [data, view, hideLowData]);

  const sorted = useMemo(() => sortRows(items, sort, SORT_GETTERS), [items, sort]);
  const summary = data?.summary || {};
  const byMp = summary.byMarketplace || {};

  const chartData = useMemo(
    () =>
      (data?.byDay || []).map((d) => ({
        day: formatDateRu(d.day).slice(0, 5),
        fbo: Number(d.fbo) || 0,
        fbs: Number(d.fbs) || 0,
      })),
    [data]
  );

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-cash"
        iconBgClass="bg-love-kiss"
        title="Упущенная выручка"
        subtitle="Сколько продаж потеряно из-за того, что товара не было на складе маркетплейса или у нас"
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
        <SelectFilter label="Схема" value={scheme} onChange={setScheme} options={SCHEME_OPTIONS} />
        <SelectFilter label="Маркетплейс" value={marketplace} onChange={setMarketplace} options={MARKETPLACE_OPTIONS} />
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Расчёт…' : 'Обновить'}
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      {data && (
        <SummaryCards
          cards={[
            {
              label: 'Упущенная выручка',
              value: formatRub(summary.lostRevenue),
              tone: 'danger',
              sub: `FBO ${formatRub(summary.fboLostRevenue)} · FBS ${formatRub(summary.fbsLostRevenue)}`,
            },
            {
              label: 'Упущенная прибыль',
              value: formatRub(summary.lostProfit),
              tone: 'danger',
              title: 'Выручка × маржа товара за 90 дней (после комиссий, логистики, себестоимости и налога)',
            },
            { label: 'Потеряно, шт', value: formatQty(summary.lostUnits, 0) },
            {
              label: 'Товаров с потерями',
              value: formatQty(summary.productsAffected, 0),
              sub: `нет в наличии сейчас: ${formatQty(summary.oosNowCount, 0)}`,
            },
            ...Object.entries(byMp)
              .filter(([, v]) => Number(v?.lostRevenue) > 0)
              .map(([mp, v]) => ({
                label: v.label || marketplaceLabel(mp),
                value: formatRub(v.lostRevenue),
                sub: `прибыль ${formatRub(v.lostProfit)}`,
              })),
          ]}
        />
      )}

      <div className="product-dynamics__chart-wrap">
        <h3 className="product-dynamics__chart-title">Потери по дням, ₽</h3>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => formatQty(v, 0)} />
              <Tooltip formatter={(v, name) => [formatRub(v), name]} />
              <Legend />
              <Bar dataKey="fbo" name="Нет на складе МП (FBO)" stackId="a" fill="#f97316" />
              <Bar dataKey="fbs" name="Нет у нас (FBS)" stackId="a" fill="#7c3aed" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="product-dynamics__empty-chart">{loading ? 'Расчёт…' : 'Нет потерь за период'}</div>
        )}
      </div>

      <div className="product-dynamics__controls-row">
        <ToggleGroup label="Показать" value={view} onChange={setView} options={VIEW_FILTERS} disabled={!data} />
        <label className="sales-analytics__filter" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={hideLowData} onChange={(e) => setHideLowData(e.target.checked)} />
          <span>Скрыть товары с недостаточной историей</span>
        </label>
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
              <SortableTh sortKey="scheme" sort={sort} onSort={toggleSort}>
                Где не было
              </SortableTh>
              <SortableTh sortKey="oosDays" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Дней без товара
              </SortableTh>
              <SortableTh
                sortKey="ratePerDay"
                sort={sort}
                onSort={toggleSort}
                className="sales-analytics__num"
                title="Средние продажи в день только по дням, когда товар был в наличии"
              >
                Темп, шт/день
              </SortableTh>
              <SortableTh sortKey="lostUnits" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Потеряно, шт
              </SortableTh>
              <SortableTh sortKey="lostRevenue" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Выручка
              </SortableTh>
              <SortableTh sortKey="lostProfit" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Прибыль
              </SortableTh>
              <SortableTh sortKey="lastOosDay" sort={sort} onSort={toggleSort}>
                Статус
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && sorted.length === 0 && (
              <tr>
                <td colSpan={9} className="sales-analytics__empty">
                  Потерь не найдено
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={`${r.marketplace}|${r.scheme}|${r.productId}`}>
                <td>
                  <ProductCell sku={r.productSku} name={r.productName} />
                </td>
                <td>{marketplaceLabel(r.marketplace)}</td>
                <td>{r.scheme === 'fbo' ? 'Склад МП' : 'Наш склад'}</td>
                <td className="sales-analytics__num">
                  {formatQty(r.oosDays, 0)} из {formatQty(r.periodDays, 0)}
                </td>
                <td className="sales-analytics__num">{formatQty(r.ratePerDay)}</td>
                <td className="sales-analytics__num">{formatQty(r.lostUnits, 1)}</td>
                <td className="sales-analytics__num">{formatRub(r.lostRevenue)}</td>
                <td className="sales-analytics__num" title={`Маржа ${formatPercent(r.marginPercent)}`}>
                  {formatRub(r.lostProfit)}
                </td>
                <td>
                  {r.oosNow ? (
                    <Badge tone="danger">Нет сейчас</Badge>
                  ) : (
                    <Badge tone="neutral">Был до {formatDateRu(r.lastOosDay)}</Badge>
                  )}{' '}
                  {r.supplierBacked ? (
                    <Badge tone="info" title="У поставщика есть остаток — можно было заказать">
                      Есть у поставщика
                    </Badge>
                  ) : null}
                  {r.insufficientData ? (
                    <Badge tone="warning" title="Товар был в наличии меньше 30% окна — темп оценён грубо">
                      Мало данных
                    </Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Темп продаж считается за период и 8 недель до него, только по дням, когда товар был в наличии. Потери = темп ×
        дни без товара × средняя цена. FBO — по ежедневным снимкам остатков маркетплейса (дней со снимками: Ozon{' '}
        {data?.fboSnapshotDays?.ozon ?? '—'}, WB {data?.fboSnapshotDays?.wb ?? '—'}, ЯМ {data?.fboSnapshotDays?.ym ?? '—'}
        ); FBS — по движениям нашего склада. Остатки поставщиков учитываются с{' '}
        {formatDateRu(data?.supplierStockTrackedSince)}.
      </p>
    </div>
  );
}
