/**
 * Очередь карточек, с которыми нужно провести работу.
 * Данные из уже загруженных отчётов (ночь / вручную) — показываем сразу при открытии.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { productHypothesesApi } from '../../../services/productHypotheses.api';
import { productCardPath } from '../../../utils/productCardPath.js';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import { DuplicateFixModal } from './DuplicateFixModal';
import { CostFixModal } from './CostFixModal';
import { DimensionsFixModal } from './DimensionsFixModal';
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
  { value: 'low_turnover', label: 'Низкая оборачиваемость' },
  { value: 'stockout', label: 'Нет остатка' },
  { value: 'low_content_rating', label: 'Качество' },
  { value: 'dim_mismatch', label: 'Размеры' },
  { value: 'duplicate', label: 'Дубли' },
  { value: 'missing_cost', label: 'Без себестоимости' },
];

const SORT_GETTERS = {
  article: (r) => r.erpSku || r.sku || '',
  productName: (r) => r.productName || '',
  marketplace: (r) => r.marketplaceLabel || r.marketplace || '',
  soldQty: (r) => Number(r.soldQty) || 0,
  stockQty: (r) => Number(r.stockQty) || 0,
  primary: (r) => r.primaryReason?.label || '',
  severity: (r) => (r.severity === 'high' ? 0 : 1),
};

const COST_SORT_GETTERS = {
  article: (r) => r.sku || '',
  productName: (r) => r.productName || '',
};

function formatQty(n) {
  if (!Number.isFinite(Number(n))) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(n));
}

function uniqueByCode(reasons) {
  const out = [];
  const seen = new Set();
  for (const r of reasons || []) {
    const code = r?.code || r?.label;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(r);
  }
  return out;
}

/** В разделе фильтра — только причина этого раздела. */
function reasonsForSection(reasons, reasonFilter) {
  const list = uniqueByCode(reasons);
  if (!reasonFilter || reasonFilter === 'all') return list;
  const code =
    reasonFilter === 'overstock' || reasonFilter === 'high_turnover'
      ? 'low_turnover'
      : reasonFilter;
  return list.filter((r) => r.code === code);
}

/** Убрать имя МП из старых подсказок размеров (есть отдельный столбец). */
function formatDimHint(hint) {
  return String(hint || '')
    .replace(/На\s+(Ozon|Wildberries|Яндекс(?:\.Маркет)?|Я\.Маркет|WB)\s*:/gi, 'На МП:')
    .trim();
}

export function CardWork() {
  const navigate = useNavigate();
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [reason, setReason] = useState('all');
  const [loading, setLoading] = useState(true);
  const [dupLoading, setDupLoading] = useState(true);
  const [costLoading, setCostLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dupError, setDupError] = useState(null);
  const [costError, setCostError] = useState(null);
  const [data, setData] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [missingCost, setMissingCost] = useState(null);
  const [fixTarget, setFixTarget] = useState(null);
  const [costFixId, setCostFixId] = useState(null);
  const [dimFix, setDimFix] = useState(null);
  const [activeHypothesisByProduct, setActiveHypothesisByProduct] = useState(() => new Map());
  const { sort, toggleSort } = useTableSort('severity', 'asc');
  const { sort: costSort, toggleSort: toggleCostSort } = useTableSort('article', 'asc');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, hypRes] = await Promise.all([
        salesAnalyticsApi.getCardWork({
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
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить очередь карточек');
      setData(null);
      setActiveHypothesisByProduct(new Map());
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  const loadDuplicates = useCallback(async () => {
    setDupLoading(true);
    setDupError(null);
    try {
      const res = await salesAnalyticsApi.getCardWorkDuplicates();
      setDuplicates(res?.data ?? null);
    } catch (e) {
      setDupError(e?.response?.data?.message || e?.message || 'Не удалось загрузить дубли');
      setDuplicates(null);
    } finally {
      setDupLoading(false);
    }
  }, []);

  const loadMissingCost = useCallback(async () => {
    setCostLoading(true);
    setCostError(null);
    try {
      const res = await salesAnalyticsApi.getCardWorkMissingCost();
      setMissingCost(res?.data ?? null);
    } catch (e) {
      setCostError(e?.response?.data?.message || e?.message || 'Не удалось загрузить товары без себестоимости');
      setMissingCost(null);
    } finally {
      setCostLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadQueue(), loadDuplicates(), loadMissingCost()]);
  }, [loadQueue, loadDuplicates, loadMissingCost]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  useEffect(() => {
    loadMissingCost();
  }, [loadMissingCost]);

  const items = useMemo(() => {
    const list = Array.isArray(data?.items) ? data.items : [];
    if (reason === 'duplicate' || reason === 'missing_cost') return [];
    const filtered =
      reason === 'all' ? list : list.filter((i) => (i.reasonCodes || []).includes(reason));
    return sortRows(filtered, sort, SORT_GETTERS);
  }, [data, reason, sort]);
  const summary = data?.summary || {};
  const duplicateGroups = duplicates?.groups || [];
  const missingCostItems = useMemo(
    () => sortRows(missingCost?.items || [], costSort, COST_SORT_GETTERS),
    [missingCost, costSort]
  );
  const showDuplicates = reason === 'duplicate';
  const showMissingCost = reason === 'missing_cost';
  const showMainTable = !showDuplicates && !showMissingCost;
  const hideSoldQty = reason === 'low_content_rating' || reason === 'dim_mismatch';
  const showRowActions = reason === 'low_content_rating' || reason === 'dim_mismatch';
  const anyLoading = loading || dupLoading || costLoading;

  const openHypothesis = useCallback(
    (row) => {
      const productId = Number(row.productId);
      if (!Number.isFinite(productId) || productId < 1) return;
      if (activeHypothesisByProduct.has(productId)) {
        navigate('/analytics/hypotheses');
        return;
      }
      const quality = reasonsForSection(row.reasons, 'low_content_rating')[0];
      const note = quality?.hint
        ? `Из «Работы с карточками» (качество): ${quality.hint}`
        : 'Из «Работы с карточками»: низкий контент-рейтинг.';
      navigate('/analytics/hypotheses', {
        state: {
          createFromAbc: {
            productId,
            productName: row.productName || '',
            productSku: row.erpSku || row.sku || '',
            marketplace: row.marketplace || marketplace,
            scheme,
            note,
          },
        },
      });
    },
    [navigate, marketplace, scheme, activeHypothesisByProduct]
  );

  const mainColSpan = 4 + (hideSoldQty ? 0 : 1) + 1 + (showRowActions ? 1 : 0);

  return (
    <div className="sales-analytics card-work">
      <PageTitle
        iconClass="pe-7s-note2"
        iconBgClass="bg-mean-fruit"
        title="Работа с карточками"
        subtitle="По уже загруженным отчётам (ночью и вручную). Смена фильтров пересчитывает сразу; «Загрузить» — обновить данные"
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
        <Button variant="primary" size="small" onClick={load} disabled={anyLoading}>
          {anyLoading ? 'Загрузка…' : 'Загрузить'}
        </Button>
        {loading && data != null ? (
          <span className="sales-analytics__filter-hint">Обновление…</span>
        ) : null}
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
      {dupError && showDuplicates ? <div className="sales-analytics__error">{dupError}</div> : null}
      {costError && showMissingCost ? <div className="sales-analytics__error">{costError}</div> : null}

      <div className="product-dynamics__summary-cards">
        <div className="product-dynamics__summary-card">
          <div className="product-dynamics__summary-card-label">Карточек к работе</div>
          <div className="product-dynamics__summary-card-value">
            {loading && data == null ? '…' : formatQty(summary.cardsCount)}
          </div>
        </div>
        <div className="product-dynamics__summary-card">
          <div className="product-dynamics__summary-card-label">Низкая оборачиваемость</div>
          <div className="product-dynamics__summary-card-value">
            {loading && data == null
              ? '…'
              : formatQty(summary.lowTurnoverCount ?? summary.overstockCount)}
          </div>
        </div>
        <div className="product-dynamics__summary-card">
          <div className="product-dynamics__summary-card-label">Нет остатка</div>
          <div className="product-dynamics__summary-card-value">
            {loading && data == null ? '…' : formatQty(summary.stockoutCount)}
          </div>
        </div>
        <div className="product-dynamics__summary-card">
          <div className="product-dynamics__summary-card-label">Качество</div>
          <div className="product-dynamics__summary-card-value">
            {loading && data == null ? '…' : formatQty(summary.lowContentRatingCount)}
          </div>
        </div>
        <div className="product-dynamics__summary-card">
          <div className="product-dynamics__summary-card-label">Размеры</div>
          <div className="product-dynamics__summary-card-value">
            {loading && data == null ? '…' : formatQty(summary.dimMismatchCount)}
          </div>
        </div>
        <div
          className={`product-dynamics__summary-card${reason === 'duplicate' ? ' is-active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => setReason('duplicate')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setReason('duplicate');
            }
          }}
        >
          <div className="product-dynamics__summary-card-label">Дубли</div>
          <div className="product-dynamics__summary-card-value">
            {dupLoading && duplicates == null
              ? '…'
              : formatQty(duplicates?.productCount ?? duplicateGroups.length)}
          </div>
        </div>
        <div
          className={`product-dynamics__summary-card${reason === 'missing_cost' ? ' is-active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => setReason('missing_cost')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setReason('missing_cost');
            }
          }}
        >
          <div className="product-dynamics__summary-card-label">Без себестоимости</div>
          <div className="product-dynamics__summary-card-value">
            {costLoading && missingCost == null
              ? '…'
              : formatQty(missingCost?.productCount ?? missingCostItems.length)}
          </div>
        </div>
      </div>

      {showMainTable ? (
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
                <SortableTh sortKey="marketplace" sort={sort} onSort={toggleSort}>
                  Маркетплейс
                </SortableTh>
                <SortableTh sortKey="primary" sort={sort} onSort={toggleSort}>
                  Что сделать
                </SortableTh>
                {!hideSoldQty ? (
                  <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                    Продано, шт
                  </SortableTh>
                ) : null}
                <SortableTh sortKey="stockQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                  Остаток на МП
                </SortableTh>
                {showRowActions ? <th className="card-work__dup-actions-col" /> : null}
              </tr>
            </thead>
            <tbody>
              {!loading && data != null && items.length === 0 && (
                <tr>
                  <td colSpan={mainColSpan} className="sales-analytics__empty">
                    Нет карточек, требующих работы, по выбранным фильтрам.
                  </td>
                </tr>
              )}
              {loading && data == null && (
                <tr>
                  <td colSpan={mainColSpan} className="sales-analytics__empty">
                    Загрузка…
                  </td>
                </tr>
              )}
              {items.map((row) => {
                const productId = Number(row.productId) || 0;
                const sectionReasons = reasonsForSection(row.reasons, reason).map((r) =>
                  r.code === 'dim_mismatch' ? { ...r, hint: formatDimHint(r.hint) } : r
                );
                const alreadyInWork = productId > 0 && activeHypothesisByProduct.has(productId);
                return (
                  <tr
                    key={`${row.productId || 'x'}-${row.sku}-${row.marketplace || 'mp'}`}
                    className={row.priority === 'high' ? 'card-work__priority-high' : undefined}
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
                    <td>{row.marketplaceLabel || row.marketplace || '—'}</td>
                    <td>
                      {reason === 'all'
                        ? sectionReasons.map((r) => (
                            <span key={r.code} className={`card-work__reason card-work__reason--${r.code}`}>
                              {r.label}
                            </span>
                          ))
                        : null}
                      {sectionReasons.map((r) => (
                        <p key={`${r.code}-h`} className="card-work__hint">
                          {r.hint}
                        </p>
                      ))}
                    </td>
                    {!hideSoldQty ? (
                      <td className="sales-analytics__num">{formatQty(row.soldQty)}</td>
                    ) : null}
                    <td className="sales-analytics__num">{formatQty(row.stockQty)}</td>
                    {showRowActions ? (
                      <td className="card-work__dup-actions-col">
                        {reason === 'dim_mismatch' ? (
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={!productId}
                            onClick={() =>
                              setDimFix({
                                productId,
                                hint: formatDimHint(
                                  sectionReasons.find((r) => r.code === 'dim_mismatch')?.hint
                                ),
                              })
                            }
                          >
                            Исправить
                          </Button>
                        ) : alreadyInWork ? (
                          <button
                            type="button"
                            className="card-work__in-work"
                            title="Уже есть гипотеза в работе — открыть список"
                            onClick={() => navigate('/analytics/hypotheses')}
                          >
                            В работе
                          </button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={!productId}
                            title={
                              productId
                                ? 'Создать гипотезу по этому товару'
                                : 'Товар не сопоставлен с карточкой ERP'
                            }
                            onClick={() => openHypothesis(row)}
                          >
                            В работу
                          </Button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {showDuplicates ? (
        <section className="card-work__duplicates" aria-labelledby="card-work-duplicates-title">
          <h2 id="card-work-duplicates-title" className="card-work__section-title">
            Дубли артикулов, артикулов продавца и штрихкодов
          </h2>
          <p className="card-work__section-lead">
            Сравниваем только однотипные идентификаторы: артикул ERP с ERP, артикул продавца с артикулом
            продавца, артикул производителя с артикулом производителя, штрихкод со штрихкодом. Бренд и
            название не сверяем. Совпавшие поля перечисляем один раз на группу — отдельно артикул продавца,
            производителя, штрихкод и т.д. Период продаж на этот список не влияет.
          </p>
          {dupLoading && duplicates == null ? (
            <p className="sales-analytics__empty">Загрузка дублей…</p>
          ) : !duplicateGroups.length ? (
            <p className="sales-analytics__empty">Совпадений идентификаторов не найдено.</p>
          ) : (
            <div className="card-work__dup-groups">
              {duplicateGroups.map((group) => (
                <div key={`${(group.kinds || []).join('-')}-${group.value}`} className="card-work__dup-group">
                  <div className="card-work__dup-head">
                    <strong className="card-work__dup-value">{group.value}</strong>
                    {(group.kindLabels || []).map((lab) => (
                      <span key={lab} className="card-work__reason card-work__reason--duplicate">
                        {lab}
                      </span>
                    ))}
                    <span className="card-work__dup-count">{group.products?.length || 0} шт.</span>
                  </div>
                  <table className="sales-analytics__table card-work__dup-table">
                    <thead>
                      <tr>
                        <th>Артикул ERP</th>
                        <th>Карточка</th>
                        <th>Где совпало</th>
                        <th className="card-work__dup-actions-col" />
                      </tr>
                    </thead>
                    <tbody>
                      {(group.products || []).map((p, idx) => (
                        <tr key={`${group.value}-${p.productId}`}>
                          <td>
                            <Link className="card-work__link" to={productCardPath(p.productId)}>
                              {p.sku || '—'}
                            </Link>
                          </td>
                          <td>
                            <Link className="card-work__link" to={productCardPath(p.productId)}>
                              {p.productName || '—'}
                            </Link>
                          </td>
                          {idx === 0 ? (
                            <td
                              className="card-work__dup-match-cell"
                              rowSpan={Math.max(group.products?.length || 1, 1)}
                            >
                              {(group.matchedFields || []).length ? (
                                <div className="card-work__dup-same card-work__dup-same--cell">
                                  {(group.matchedFields || []).map((f) => (
                                    <span
                                      key={`${f.label}:${f.value}`}
                                      className="card-work__reason card-work__reason--same"
                                    >
                                      {f.label}: {f.value}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="card-work__dup-match-fallback">
                                  {(group.kindLabels || []).join(', ') || '—'}
                                  {group.value ? `: ${group.value}` : ''}
                                </span>
                              )}
                            </td>
                          ) : null}
                          {idx === 0 ? (
                            <td
                              className="card-work__dup-actions-col"
                              rowSpan={Math.max(group.products?.length || 1, 1)}
                            >
                              <Button
                                variant="secondary"
                                size="small"
                                onClick={() => setFixTarget(group)}
                              >
                                Исправить
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {showMissingCost ? (
        <section className="card-work__duplicates" aria-labelledby="card-work-cost-title">
          <h2 id="card-work-cost-title" className="card-work__section-title">
            Без себестоимости
          </h2>
          <p className="card-work__section-lead">
            Товары без себестоимости в карточке (пусто или ≤ 0). Период продаж на этот список не влияет.
            «Исправить» — указать или изменить себестоимость и сохранить карточку.
          </p>
          {costLoading && missingCost == null ? (
            <p className="sales-analytics__empty">Загрузка…</p>
          ) : !missingCostItems.length ? (
            <p className="sales-analytics__empty">Все карточки с себестоимостью.</p>
          ) : (
            <div className="sales-analytics__table-wrap">
              <table className="sales-analytics__table card-work__dup-table">
                <thead>
                  <tr>
                    <SortableTh sortKey="article" sort={costSort} onSort={toggleCostSort}>
                      Артикул ERP
                    </SortableTh>
                    <SortableTh sortKey="productName" sort={costSort} onSort={toggleCostSort}>
                      Карточка
                    </SortableTh>
                    <th>Себестоимость</th>
                    <th className="card-work__dup-actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {missingCostItems.map((p) => (
                    <tr key={p.productId}>
                      <td>
                        <Link className="card-work__link" to={productCardPath(p.productId)}>
                          {p.sku || '—'}
                        </Link>
                      </td>
                      <td>
                        <Link className="card-work__link" to={productCardPath(p.productId)}>
                          {p.productName || '—'}
                        </Link>
                        {p.isKit ? (
                          <span className="card-work__reason card-work__reason--missing_cost">
                            Комплект
                          </span>
                        ) : null}
                      </td>
                      <td>{p.cost == null ? '—' : formatQty(p.cost)}</td>
                      <td className="card-work__dup-actions-col">
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => setCostFixId(p.productId)}
                        >
                          Исправить
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      <DuplicateFixModal
        isOpen={!!fixTarget}
        group={fixTarget}
        onClose={() => setFixTarget(null)}
        onSaved={loadDuplicates}
      />

      <CostFixModal
        isOpen={costFixId != null}
        productId={costFixId}
        onClose={() => setCostFixId(null)}
        onSaved={loadMissingCost}
      />

      <DimensionsFixModal
        isOpen={dimFix != null}
        productId={dimFix?.productId}
        marketplaceHint={dimFix?.hint}
        onClose={() => setDimFix(null)}
        onSaved={loadQueue}
      />

      <p className="sales-analytics__hint">
        Каждая строка — один маркетплейс: продажи и остаток не суммируются между Ozon / WB / Яндекс.
        Низкая оборачиваемость — запас больше 45 дней или продаж нет при остатке на МП.
        Нет остатка — на этом МП продажи есть, а склад МП 0.
        Качество — контент-рейтинг Ozon или Яндекс.Маркета ниже порога из настроек аккаунта
        (включается тумблером «Показывать в работе над карточкой»). Оценки обновляются при синхронизации карточки
        и ночью; «В работу» создаёт гипотезу, как в ABC. В «Качестве» и «Размерах» столбец продаж скрыт.
        Размеры — габариты упаковки на маркетплейсе не совпадают с вкладкой «Основное» (пустые значения
        не считаются расхождением; для WB и Яндекс.Маркета сравнение в сантиметрах); «Исправить» — форма мм/г.
        Дубли — несколько карточек с одинаковым полем одного типа (ERP↔ERP, артикул продавца↔продавца,
        артикул производителя↔производителя, ШК↔ШК). Разные типы не склеиваем. Список дублей не зависит от периода.
        Без себестоимости — в карточке не задан cost (пусто или ≤ 0); период продаж не влияет.
        «Исправить» открывает форму правки. Клик по артикулу открывает карточку товара.
      </p>
    </div>
  );
}
