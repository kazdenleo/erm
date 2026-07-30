/**
 * Аналитика продаж по категориям товаров
 */

import React, { useCallback, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './CategorySalesAnalytics.css';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';

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

/** Детализация «Затрат» — показывается при раскрытии колонки. */
const COST_BREAKDOWN_COLS = [
  { key: 'costAmount', label: 'Себестоимость', title: 'qty × себестоимость товара в ERP' },
  { key: 'commissionAmount', label: 'Комиссия', title: 'Комиссия / вознаграждение МП' },
  { key: 'logisticsAmount', label: 'Логистика', title: 'Доставка, ПВЗ, возвратная логистика' },
  { key: 'storageAmount', label: 'Хранение', title: 'Хранение на складе МП' },
  { key: 'penaltyAmount', label: 'Штрафы', title: 'Штрафы и удержания за нарушения' },
  { key: 'acquiringAmount', label: 'Эквайринг', title: 'Эквайринг / приём платежа' },
  { key: 'otherDeductions', label: 'Прочее', title: 'Прочие удержания и списания' },
];

function CostCells({ row, costsExpanded }) {
  if (!costsExpanded) return null;
  return COST_BREAKDOWN_COLS.map((col) => (
    <td key={col.key} className="sales-analytics__num category-sales-analytics__cost-detail">
      {formatRub(Number(row[col.key]) || 0)}
    </td>
  ));
}

export function CategorySalesAnalytics() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [costsExpanded, setCostsExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getByCategory({
        dateFrom,
        dateTo,
        marketplace,
        scheme,
      });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить аналитику');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  const summary = data?.summary || {};
  const taxMeta = data?.taxMeta || null;
  const categories = (Array.isArray(data?.categories) ? data.categories : [])
    .map((cat) => {
      const products = (cat.products || []).filter((p) => {
        const pid = Number(p.productId) || 0;
        const sku = String(p.sku || '').trim();
        const name = String(p.productName || '').trim();
        const soldQty = Number(p.soldQty) || 0;
        const soldAmount = Number(p.soldAmount) || 0;
        if (pid > 0) return true;
        if (!sku || sku === '—' || sku === '-' || sku === '0') return false;
        if (soldQty === 0 && soldAmount === 0 && (!name || name === '—')) return false;
        return true;
      });
      if (!products.length) return null;
      const taxAmount = products.reduce((s, p) => s + (Number(p.taxAmount) || 0), 0);
      const netIncome = products.reduce((s, p) => s + (Number(p.netIncome) || 0), 0);
      const costsTotal = products.reduce((s, p) => s + (Number(p.costsTotal) || 0), 0);
      return {
        ...cat,
        products,
        productsCount: products.length,
        taxAmount,
        netIncome,
        costsTotal,
      };
    })
    .filter(Boolean);
  const colCount = 7 + (costsExpanded ? COST_BREAKDOWN_COLS.length : 0);

  const toggleCategory = (categoryId) => {
    const key = String(categoryId ?? 0);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => {
    setExpanded(new Set(categories.map((c) => String(c.categoryId ?? 0))));
  };

  const collapseAll = () => setExpanded(new Set());

  return (
    <div className="sales-analytics category-sales-analytics">
      <PageTitle
        iconClass="pe-7s-portfolio"
        iconBgClass="bg-mean-fruit"
        title="По категориям"
        subtitle="Продажи, затраты и чистая прибыль по категориям товаров"
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
        <Button variant="secondary" size="small" onClick={expandAll} disabled={!categories.length}>
          Развернуть все
        </Button>
        <Button variant="secondary" size="small" onClick={collapseAll} disabled={!expanded.size}>
          Свернуть все
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      <div className="sales-analytics__cards">
        <div className="sales-analytics__card sales-analytics__card--sold">
          <div className="sales-analytics__card-label">Сумма продаж</div>
          <div className="sales-analytics__card-value">{formatRub(summary.soldAmount)}</div>
          <div className="sales-analytics__card-sub">{formatQty(summary.soldQty)} шт.</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--canceled">
          <div className="sales-analytics__card-label">Затраты</div>
          <div className="sales-analytics__card-value">{formatRub(summary.costsTotal)}</div>
          <div className="sales-analytics__card-sub">Себестоимость + удержания МП</div>
        </div>
        <div className="sales-analytics__card">
          <div className="sales-analytics__card-label">Налоги</div>
          <div className="sales-analytics__card-value">{formatRub(summary.taxAmount)}</div>
          <div className="sales-analytics__card-sub">
            {taxMeta?.vatRate > 0
              ? `НДС ${Math.round(taxMeta.vatRate * 100)}%: ${formatRub(summary.vatAmount)} · налог: ${formatRub(summary.incomeTaxAmount)}`
              : taxMeta?.taxSystemLabel || 'По схеме организации'}
          </div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--returned">
          <div className="sales-analytics__card-label">Чистая прибыль</div>
          <div className="sales-analytics__card-value">{formatRub(summary.netIncome)}</div>
          <div className="sales-analytics__card-sub">
            {formatQty(summary.categoriesCount)} катег. · {formatQty(summary.productsCount)} тов.
          </div>
        </div>
      </div>

      <div className="sales-analytics__table-wrap">
        <table className="sales-analytics__table category-sales-analytics__table">
          <thead>
            <tr>
              <th className="category-sales-analytics__col-toggle" />
              <th>Категория / товар</th>
              <th className="sales-analytics__num">Продано</th>
              <th className="sales-analytics__num">Сумма продаж</th>
              {costsExpanded &&
                COST_BREAKDOWN_COLS.map((col) => (
                  <th
                    key={col.key}
                    className="sales-analytics__num category-sales-analytics__cost-detail-th"
                    title={col.title}
                  >
                    {col.label}
                  </th>
                ))}
              <th className="sales-analytics__num">
                <button
                  type="button"
                  className={`category-sales-analytics__col-expand${
                    costsExpanded ? ' is-open' : ''
                  }`}
                  onClick={() => setCostsExpanded((v) => !v)}
                  title={
                    costsExpanded
                      ? 'Скрыть разбивку затрат'
                      : 'Показать разбивку: себестоимость, комиссия, логистика…'
                  }
                  aria-expanded={costsExpanded}
                >
                  <span>Затраты</span>
                  <span className="category-sales-analytics__chevron" aria-hidden>
                    {costsExpanded ? '▾' : '▸'}
                  </span>
                </button>
              </th>
              <th
                className="sales-analytics__num"
                title="По схеме организации. УСН 15% / ОСН — только с прибыли; при убытке = 0"
              >
                Налоги
              </th>
              <th className="sales-analytics__num">Чистая прибыль</th>
            </tr>
          </thead>
          <tbody>
            {!loading && categories.length === 0 && (
              <tr>
                <td colSpan={colCount} className="sales-analytics__empty">
                  {data == null
                    ? 'Выберите параметры и нажмите «Показать».'
                    : 'Нет данных. Сначала загрузите отчёты на вкладках «Продажи FBO» / «Продажи FBS».'}
                </td>
              </tr>
            )}
            {categories.map((cat) => {
              const key = String(cat.categoryId ?? 0);
              const isOpen = expanded.has(key);
              return (
                <React.Fragment key={key}>
                  <tr
                    className={`category-sales-analytics__cat-row${isOpen ? ' is-open' : ''}`}
                    onClick={() => toggleCategory(cat.categoryId)}
                  >
                    <td className="category-sales-analytics__col-toggle">
                      <span className="category-sales-analytics__chevron" aria-hidden>
                        {isOpen ? '▾' : '▸'}
                      </span>
                    </td>
                    <td>
                      <strong>{cat.categoryName || 'Без категории'}</strong>
                      <span className="category-sales-analytics__meta">
                        {' '}
                        · {formatQty(cat.productsCount)} тов.
                      </span>
                    </td>
                    <td className="sales-analytics__num">{formatQty(cat.soldQty)}</td>
                    <td className="sales-analytics__num">{formatRub(cat.soldAmount)}</td>
                    <CostCells row={cat} costsExpanded={costsExpanded} />
                    <td className="sales-analytics__num">{formatRub(cat.costsTotal)}</td>
                    <td
                      className="sales-analytics__num sales-analytics__num--hint"
                      title={cat.taxTooltip || undefined}
                    >
                      {formatRub(cat.taxAmount)}
                    </td>
                    <td className="sales-analytics__num">{formatRub(cat.netIncome)}</td>
                  </tr>
                  {isOpen &&
                    (cat.products || []).map((p) => (
                      <tr
                        key={`${key}-${p.productId || 'x'}-${p.sku}`}
                        className="category-sales-analytics__product-row"
                      >
                        <td />
                        <td className="category-sales-analytics__product-cell">
                          <div>{p.productName || '—'}</div>
                          <div className="category-sales-analytics__meta">
                            Артикул: {p.erpSku || '—'}
                          </div>
                        </td>
                        <td className="sales-analytics__num">{formatQty(p.soldQty)}</td>
                        <td className="sales-analytics__num">{formatRub(p.soldAmount)}</td>
                        <CostCells row={p} costsExpanded={costsExpanded} />
                        <td className="sales-analytics__num">{formatRub(p.costsTotal)}</td>
                        <td
                          className="sales-analytics__num sales-analytics__num--hint"
                          title={p.taxTooltip || undefined}
                        >
                          {formatRub(p.taxAmount)}
                        </td>
                        <td className="sales-analytics__num">{formatRub(p.netIncome)}</td>
                      </tr>
                    ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Затраты = себестоимость + удержания маркетплейса (комиссия, логистика, хранение и др.). Нажмите
        на заголовок «Затраты», чтобы раскрыть статьи. «Налоги» = НДС (если указан в организации) + налог
        по схеме. Чистая прибыль — после налогов.
        {taxMeta?.taxSystemLabel ? (
          <>
            {' '}
            Схема: «{taxMeta.taxSystemLabel}»
            {taxMeta.organizationName ? ` (${taxMeta.organizationName})` : ''}.
          </>
        ) : null}{' '}
        Данные берутся из загруженных финансовых отчётов FBO/FBS.
      </p>
    </div>
  );
}
