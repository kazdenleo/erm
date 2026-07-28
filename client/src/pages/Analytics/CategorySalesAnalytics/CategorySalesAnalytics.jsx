/**
 * Аналитика продаж по категориям товаров
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './CategorySalesAnalytics.css';

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { dateFrom: formatYmd(from), dateTo: formatYmd(to) };
}

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
  const initial = useMemo(() => defaultRange(), []);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary || {};
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const taxMeta = data?.taxMeta || null;
  const colCount = 6 + (costsExpanded ? COST_BREAKDOWN_COLS.length : 0);

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
        <label className="sales-analytics__filter">
          <span>С</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className="sales-analytics__filter">
          <span>По</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
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
          {loading ? 'Загрузка…' : 'Обновить'}
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
              <th className="sales-analytics__num">Чистая прибыль</th>
            </tr>
          </thead>
          <tbody>
            {!loading && categories.length === 0 && (
              <tr>
                <td colSpan={colCount} className="sales-analytics__empty">
                  Нет данных. Сначала загрузите отчёты на вкладках «Продажи FBO» / «Продажи FBS».
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
                            {p.erpSku ? `ERP: ${p.erpSku}` : 'ERP: —'}
                            {p.sku ? ` · МП: ${p.sku}` : ''}
                          </div>
                        </td>
                        <td className="sales-analytics__num">{formatQty(p.soldQty)}</td>
                        <td className="sales-analytics__num">{formatRub(p.soldAmount)}</td>
                        <CostCells row={p} costsExpanded={costsExpanded} />
                        <td className="sales-analytics__num">{formatRub(p.costsTotal)}</td>
                        <td className="sales-analytics__num" title={p.taxTooltip || undefined}>
                          {formatRub(p.netIncome)}
                        </td>
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
        на заголовок «Затраты», чтобы раскрыть статьи. Чистая прибыль — после налогов по схеме
        организации.
        {taxMeta?.taxSystemLabel ? (
          <>
            {' '}
            Налоги: «{taxMeta.taxSystemLabel}»
            {taxMeta.organizationName ? ` (${taxMeta.organizationName})` : ''}.
          </>
        ) : null}{' '}
        Данные берутся из загруженных финансовых отчётов FBO/FBS.
      </p>
    </div>
  );
}
