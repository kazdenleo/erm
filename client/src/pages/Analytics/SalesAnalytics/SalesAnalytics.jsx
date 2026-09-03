/**
 * Аналитика продаж FBS: финансовые отчёты с маркетплейсов
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { marketplaceFbsReportsApi } from '../../../services/marketplaceFbsReports.api';
import '../FboSalesAnalytics/FboSalesAnalytics.css';
import './SalesAnalytics.css';
import { AmountCell } from '../shared/AmountCell';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { OrderEconomicsOrderTable } from '../shared/OrderEconomicsOrderTable';
import { marketplaceRevenueAmount } from '../shared/orderEconomics';
import { AnalyticsAiChat } from '../shared/AnalyticsAiChat';
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

export function SalesAnalytics() {
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
        marketplaceFbsReportsApi.getByProduct({ dateFrom, dateTo, marketplace }),
        marketplaceFbsReportsApi.getByOrder({ dateFrom, dateTo, marketplace }),
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
      const res = await marketplaceFbsReportsApi.sync({ dateFrom, dateTo, marketplace });
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
        title="Продажи FBS"
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

      <AnalyticsAiChat
        dateFrom={dateFrom}
        dateTo={dateTo}
        marketplace={marketplace}
        source="fbs"
      />

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
        <div className="sales-analytics__table-wrap">
          <table className="sales-analytics__table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>Артикул</th>
                <th className="sales-analytics__num">Продано</th>
                <th className="sales-analytics__num">Сумма продаж</th>
                <th className="sales-analytics__num">Комиссия</th>
                <th className="sales-analytics__num">Логистика</th>
                <th className="sales-analytics__num">Хранение</th>
                <th className="sales-analytics__num">Прочее</th>
                <th className="sales-analytics__num">К выплате</th>
                <th className="sales-analytics__num">Себестоимость</th>
                <th
                  className="sales-analytics__num"
                  title="qty × дополнительные расходы из карточки товара"
                >
                  Доп. расходы
                </th>
                <th
                  className="sales-analytics__num"
                  title="К выплате − себестоимость − доп. расходы. У WB ещё − логистика."
                >
                  Выручка
                </th>
                <th
                  className="sales-analytics__num"
                  title="По схеме организации. УСН 15% / ОСН — только с прибыли; при убытке = 0"
                >
                  Налоги
                </th>
                <th
                  className="sales-analytics__num"
                  title="Пришло от МП − себестоимость − доп. расходы − налоги"
                >
                  Чистый доход
                </th>
              </tr>
            </thead>
            <tbody>
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={14} className="sales-analytics__empty">
                    {data == null
                      ? 'Загрузка…'
                      : 'Нет данных. Нажмите «Загрузить с маркетплейсов» для импорта отчёта за период.'}
                  </td>
                </tr>
              )}
              {items.map((row) => (
                <tr key={`${row.productId || 'x'}-${row.sku}`}>
                  <td>{row.productName || '—'}</td>
                  <td>
                    {row.erpSku ? (
                      <span title={row.productId ? `ID ${row.productId}` : undefined}>{row.erpSku}</span>
                    ) : (
                      <span className="fbo-sales-analytics__unlinked">—</span>
                    )}
                  </td>
                  <td className="sales-analytics__num">{formatQty(row.soldQty)}</td>
                  <td className="sales-analytics__num">{formatRub(row.soldAmount)}</td>
                  <td className="sales-analytics__num">{formatRub(row.commissionAmount)}</td>
                  <td className="sales-analytics__num">{formatRub(row.logisticsAmount)}</td>
                  <td className="sales-analytics__num">{formatRub(row.storageAmount)}</td>
                  <td className="sales-analytics__num">
                    {formatRub(
                      (row.penaltyAmount || 0) +
                        (row.acquiringAmount || 0) +
                        (row.otherDeductions || 0)
                    )}
                  </td>
                  <td className="sales-analytics__num">{formatRub(row.payoutAmount)}</td>
                  <td className="sales-analytics__num">{formatRub(row.costAmount)}</td>
                  <td className="sales-analytics__num">{formatRub(row.additionalExpensesAmount)}</td>
                  <td className="sales-analytics__num">{formatRub(marketplaceRevenueAmount(row))}</td>
                  <AmountCell value={row.taxAmount} format={formatRub} tooltip={row.taxTooltip} />
                  <td className="sales-analytics__num">{formatRub(row.netIncome)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        Данные загружаются через API маркетплейсов: WB — reportDetailByPeriod (FBS), Ozon —
        finance/transaction/list (FBS), Яндекс — united-netting (FBS).         Даты — по дате операции в
        отчёте (МСК). Во вкладке «По заказам»: цена продажи, затраты (удержания МП, без себестоимости и доп. расходов)
        и сколько пришло от маркетплейса. После обновления логики перезагрузите период кнопкой «Загрузить с маркетплейсов».
        {taxMeta?.taxSystemLabel ? (
          <>
            {' '}
            Налоги: схема «{taxMeta.taxSystemLabel}»
            {taxMeta.organizationName ? ` (${taxMeta.organizationName})` : ''}. База — выручка минус
            себестоимость, доп. расходы и удержания МП. При УСН 15% / ОСН налог = 0, если прибыль отрицательная.
            Наведите на «Налоги» — там разбивка базы.
          </>
        ) : (
          <> Укажите систему налогообложения в карточке организации для расчёта налогов.</>
        )}
      </p>
    </div>
  );
}
