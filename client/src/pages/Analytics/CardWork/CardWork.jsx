/**
 * Очередь карточек, с которыми нужно провести работу.
 * Данные из уже загруженных отчётов (ночь / вручную) — показываем сразу при открытии.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import { productCardPath } from '../../../utils/productCardPath.js';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import { DuplicateFixModal } from './DuplicateFixModal';
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

export function CardWork() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [reason, setReason] = useState('all');
  const [loading, setLoading] = useState(true);
  const [dupLoading, setDupLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dupError, setDupError] = useState(null);
  const [data, setData] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [fixTarget, setFixTarget] = useState(null);
  const { sort, toggleSort } = useTableSort('severity', 'asc');

  const loadQueue = useCallback(async () => {
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

  const load = useCallback(async () => {
    await Promise.all([loadQueue(), loadDuplicates()]);
  }, [loadQueue, loadDuplicates]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  const items = useMemo(() => {
    const list = Array.isArray(data?.items) ? data.items : [];
    if (reason === 'duplicate') return [];
    const filtered =
      reason === 'all' ? list : list.filter((i) => (i.reasonCodes || []).includes(reason));
    return sortRows(filtered, sort, SORT_GETTERS);
  }, [data, reason, sort]);
  const summary = data?.summary || {};
  const duplicateGroups = duplicates?.groups || [];
  const showDuplicates = reason === 'duplicate';
  const anyLoading = loading || dupLoading;

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
      </div>

      {!showDuplicates ? (
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
                <SortableTh sortKey="soldQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                  Продано, шт
                </SortableTh>
                <SortableTh sortKey="stockQty" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                  Остаток на МП
                </SortableTh>
              </tr>
            </thead>
            <tbody>
              {!loading && data != null && items.length === 0 && (
                <tr>
                  <td colSpan={6} className="sales-analytics__empty">
                    Нет карточек, требующих работы, по выбранным фильтрам.
                  </td>
                </tr>
              )}
              {loading && data == null && (
                <tr>
                  <td colSpan={6} className="sales-analytics__empty">
                    Загрузка…
                  </td>
                </tr>
              )}
              {items.map((row) => (
                <tr
                  key={`${row.productId || 'x'}-${row.sku}-${row.marketplace || 'mp'}`}
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
                  <td>{row.marketplaceLabel || row.marketplace || '—'}</td>
                  <td>
                    {uniqueByCode(row.reasons).map((r) => (
                      <span key={r.code} className={`card-work__reason card-work__reason--${r.code}`}>
                        {r.label}
                      </span>
                    ))}
                    {uniqueByCode(row.reasons).map((r) => (
                      <p key={`${r.code}-h`} className="card-work__hint">
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

      <DuplicateFixModal
        isOpen={!!fixTarget}
        group={fixTarget}
        onClose={() => setFixTarget(null)}
        onSaved={loadDuplicates}
      />

      <p className="sales-analytics__hint">
        Каждая строка — один маркетплейс: продажи и остаток не суммируются между Ozon / WB / Яндекс.
        Низкая оборачиваемость — запас больше 45 дней или продаж нет при остатке на МП.
        Нет остатка — на этом МП продажи есть, а склад МП 0.
        Качество — контент-рейтинг Ozon или Яндекс.Маркета ниже порога из настроек аккаунта
        (включается тумблером «Показывать в работе над карточкой»). Оценки обновляются при синхронизации карточки
        и ночью. Размеры — габариты упаковки на маркетплейсе не совпадают с вкладкой «Основное» (пустые значения
        не считаются расхождением; для WB и Яндекс.Маркета сравнение в сантиметрах).
        Дубли — несколько карточек с одинаковым полем одного типа (ERP↔ERP, артикул продавца↔продавца,
        артикул производителя↔производителя, ШК↔ШК). Разные типы не склеиваем. Список дублей не зависит от периода.
        «Исправить» у группы открывает одну форму по совпавшим полям всех карточек. Клик по артикулу открывает
        карточку товара.
      </p>
    </div>
  );
}
