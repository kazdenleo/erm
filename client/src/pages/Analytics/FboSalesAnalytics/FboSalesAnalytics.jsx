/**
 * Аналитика продаж FBO: финансовые отчёты с маркетплейсов
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { marketplaceFboReportsApi } from '../../../services/marketplaceFboReports.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './FboSalesAnalytics.css';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { OrderEconomicsOrderTable } from '../shared/OrderEconomicsOrderTable';
import { ProductEconomicsTable } from '../shared/ProductEconomicsTable';
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

export function FboSalesAnalytics() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);
  const [data, setData] = useState(null);
  const [orders, setOrders] = useState([]);
  const [view, setView] = useState('order');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [productRes, orderRes] = await Promise.all([
        marketplaceFboReportsApi.getByProduct({ dateFrom, dateTo, marketplace }),
        marketplaceFboReportsApi.getByOrder({ dateFrom, dateTo, marketplace }),
      ]);
      setData(productRes?.data ?? null);
      setOrders(Array.isArray(orderRes?.data?.items) ? orderRes.data.items : []);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить аналитику');
      setData(null);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace]);

  useEffect(() => {
    load();
  }, [load]);

  const syncFromMarketplaces = useCallback(async () => {
    setSyncing(true);
    setSyncMessage('Загрузка с маркетплейсов… Может занять до 10 минут (Яндекс генерирует отчёт на своей стороне).');
    setError(null);
    try {
      const res = await marketplaceFboReportsApi.sync({ dateFrom, dateTo, marketplace });
      const results = res?.data?.results || [];
      const errs = res?.data?.errors || [];
      const imported = results.reduce((s, r) => s + (Number(r.rowsImported) || 0), 0);
      if (errs.length) {
        setSyncMessage(
          `Загружено строк: ${imported}. Ошибки: ${errs.map((e) => `${e.marketplace}: ${e.message}`).join('; ')}`
        );
      } else {
        setSyncMessage(`Загружено строк: ${imported}`);
      }
      await load();
    } catch (e) {
      const isTimeout = e?.code === 'ECONNABORTED' || /timeout/i.test(String(e?.message || ''));
      setError(
        isTimeout
          ? 'Превышено время ожидания. Попробуйте короче период или загружайте по одному маркетплейсу. Данные могли частично сохраниться — таблица обновится сама.'
          : e?.response?.data?.message || e?.message || 'Не удалось загрузить отчёты с маркетплейсов'
      );
      await load();
    } finally {
      setSyncing(false);
    }
  }, [dateFrom, dateTo, marketplace, load]);

  const summary = data?.summary || {};
  const items = Array.isArray(data?.items) ? data.items : [];
  const recentSyncs = Array.isArray(data?.recentSyncs) ? data.recentSyncs : [];
  const taxMeta = data?.taxMeta || null;

  return (
    <div className="sales-analytics fbo-sales-analytics">
      <PageTitle
        iconClass="pe-7s-graph2"
        iconBgClass="bg-mean-fruit"
        title="Продажи FBO"
        subtitle="Факт по каждому заказу: цена продажи, затраты и сколько пришло от маркетплейса"
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
          <span>Маркетплейс</span>
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            {MARKETPLACE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="small" onClick={syncFromMarketplaces} disabled={loading || syncing}>
          {syncing ? 'Загрузка с МП…' : 'Загрузить с маркетплейсов'}
        </Button>
        {loading && !syncing ? (
          <span className="sales-analytics__filter-hint">Обновление…</span>
        ) : null}
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}
      {syncMessage && <div className="fbo-sales-analytics__sync-msg">{syncMessage}</div>}

      <div className="sales-analytics__cards">
        <div className="sales-analytics__card sales-analytics__card--sold">
          <div className="sales-analytics__card-label">Продажи</div>
          <div className="sales-analytics__card-value">{formatQty(summary.soldQty)} шт.</div>
          <div className="sales-analytics__card-sub">{formatRub(summary.soldAmount)}</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--canceled">
          <div className="sales-analytics__card-label">Удержания</div>
          <div className="sales-analytics__card-value">{formatRub(summary.expensesTotal)}</div>
          <div className="sales-analytics__card-sub">Комиссия, логистика, хранение, штрафы</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--returned">
          <div className="sales-analytics__card-label">К перечислению</div>
          <div className="sales-analytics__card-value">{formatRub(summary.payoutAmount)}</div>
          <div className="sales-analytics__card-sub">{formatQty(summary.ordersCount)} заказов с продажей</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--cost">
          <div className="sales-analytics__card-label">Себестоимость</div>
          <div className="sales-analytics__card-value">
            {formatRub((Number(summary.costAmount) || 0) + (Number(summary.additionalExpensesAmount) || 0))}
          </div>
          <div className="sales-analytics__card-sub">
            Себест. {formatRub(summary.costAmount)} · доп. {formatRub(summary.additionalExpensesAmount)}
          </div>
        </div>
        <div className="sales-analytics__card">
          <div className="sales-analytics__card-label">Налоги</div>
          <div className="sales-analytics__card-value">{formatRub(summary.taxAmount)}</div>
          <div className="sales-analytics__card-sub">
            {taxMeta?.taxSystemLabel || 'По схеме организации'}
          </div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--net">
          <div className="sales-analytics__card-label">Чистая прибыль</div>
          <div className="sales-analytics__card-value">{formatRub(summary.netIncome)}</div>
          <div className="sales-analytics__card-sub">Выручка − налоги</div>
        </div>
      </div>

      <div className="fbo-sales-analytics__view-tabs">
        <button
          type="button"
          className={`fbo-sales-analytics__view-tab${view === 'product' ? ' is-active' : ''}`}
          onClick={() => setView('product')}
        >
          По товарам
        </button>
        <button
          type="button"
          className={`fbo-sales-analytics__view-tab${view === 'order' ? ' is-active' : ''}`}
          onClick={() => setView('order')}
        >
          По заказам
        </button>
      </div>

      {view === 'product' ? (
        <ProductEconomicsTable
          loading={loading}
          items={items}
          emptyMessage={
            data == null
              ? 'Загрузка…'
              : 'Нет данных. Нажмите «Загрузить с маркетплейсов» для импорта отчёта за период.'
          }
        />
      ) : (
        <OrderEconomicsOrderTable
          loading={loading}
          orders={orders}
          emptyMessage={
            data == null
              ? 'Загрузка…'
              : 'Нет данных по заказам за выбранный период.'
          }
        />
      )}

      {recentSyncs.length > 0 && (
        <div className="fbo-sales-analytics__sync-history">
          <strong>Последние загрузки:</strong>
          <ul>
            {recentSyncs.map((s, i) => (
              <li key={`${s.marketplace}-${s.finishedAt || i}`}>
                {s.marketplace}: {s.status}
                {s.rowsImported != null ? `, ${s.rowsImported} строк` : ''}
                {s.errorMessage ? ` — ${s.errorMessage}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="sales-analytics__hint">
        Данные загружаются через API маркетплейсов: WB — reportDetailByPeriod (FBW/FBO), Ozon —
        finance/transaction/list (FBO), Яндекс — united-netting (FBY). Во вкладке «По заказам»: цена продажи,
        затраты (удержания МП, без себестоимости и доп. расходов) и сколько пришло от маркетплейса. Одна строка на
        продажу WB (затраты из других операций отчёта подтягиваются по заказу/штрихкоду). В сводке число
        заказов = только операции «Продажа», не служебные строки отчёта.
        {taxMeta?.taxSystemLabel ? (
          <>
            {' '}
            Налоги: схема «{taxMeta.taxSystemLabel}»
            {taxMeta.organizationName ? ` (${taxMeta.organizationName})` : ''}. База — выручка минус
            себестоимость, доп. расходы и удержания МП. При УСН 15% / ОСН налог = 0, если прибыль отрицательная
            (как у большинства строк на скрине). Наведите на «Налоги» — там разбивка базы.
          </>
        ) : (
          <> Укажите систему налогообложения в карточке организации для расчёта налогов.</>
        )}
      </p>
    </div>
  );
}
