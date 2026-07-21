/**
 * Аналитика продаж FBO: финансовые отчёты с маркетплейсов
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { marketplaceFboReportsApi } from '../../../services/marketplaceFboReports.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './FboSalesAnalytics.css';
import { AmountCell, otherDeductionsTotal } from '../shared/AmountCell';

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

export function FboSalesAnalytics() {
  const initial = useMemo(() => defaultRange(), []);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [syncMessage, setSyncMessage] = useState(null);
  const [data, setData] = useState(null);
  const [orders, setOrders] = useState([]);
  const [view, setView] = useState('product');

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
          ? 'Превышено время ожидания. Попробуйте короче период или загружайте по одному маркетплейсу. Данные могли частично сохраниться — нажмите «Обновить».'
          : e?.response?.data?.message || e?.message || 'Не удалось загрузить отчёты с маркетплейсов'
      );
      await load();
    } finally {
      setSyncing(false);
    }
  }, [dateFrom, dateTo, marketplace, load]);

  useEffect(() => {
    load();
  }, [load]);

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
        subtitle="Финансовые отчёты с маркетплейсов: продажи и все удержания по заказам"
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
          <span>Маркетплейс</span>
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            {MARKETPLACE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="small" onClick={load} disabled={loading || syncing}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
        <Button variant="secondary" size="small" onClick={syncFromMarketplaces} disabled={loading || syncing}>
          {syncing ? 'Загрузка с МП…' : 'Загрузить с маркетплейсов'}
        </Button>
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
                <th>Артикул МП</th>
                <th>Товар ERP</th>
                <th className="sales-analytics__num">Продано</th>
                <th className="sales-analytics__num">Выручка</th>
                <th className="sales-analytics__num">Комиссия</th>
                <th className="sales-analytics__num">Логистика</th>
                <th className="sales-analytics__num">Хранение</th>
                <th className="sales-analytics__num">Прочее</th>
                <th className="sales-analytics__num">К выплате</th>
                <th className="sales-analytics__num">Налоги</th>
                <th className="sales-analytics__num">Чистый доход</th>
              </tr>
            </thead>
            <tbody>
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={12} className="sales-analytics__empty">
                    Нет данных. Нажмите «Загрузить с маркетплейсов» для импорта отчёта за период.
                  </td>
                </tr>
              )}
              {items.map((row) => (
                <tr key={`${row.productId || 'x'}-${row.sku}`}>
                  <td>{row.productName || '—'}</td>
                  <td>{row.sku || '—'}</td>
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
                  <AmountCell value={row.taxAmount} format={formatRub} tooltip={row.taxTooltip} />
                  <td className="sales-analytics__num">{formatRub(row.netIncome)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sales-analytics__table-wrap">
          <table className="sales-analytics__table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>МП</th>
                <th>Заказ / отправление</th>
                <th>Товар</th>
                <th className="sales-analytics__num">Кол-во</th>
                <th className="sales-analytics__num">Себестоимость</th>
                <th className="sales-analytics__num">Выручка</th>
                <th className="sales-analytics__num">Комиссия</th>
                <th className="sales-analytics__num">Логистика</th>
                <th className="sales-analytics__num">Хранение</th>
                <th className="sales-analytics__num">Прочее</th>
                <th className="sales-analytics__num">К выплате</th>
                <th className="sales-analytics__num">Налоги</th>
                <th className="sales-analytics__num">Чистый доход</th>
              </tr>
            </thead>
            <tbody>
              {!loading && orders.length === 0 && (
                <tr>
                  <td colSpan={14} className="sales-analytics__empty">
                    Нет данных по заказам за выбранный период.
                  </td>
                </tr>
              )}
              {orders.map((row, idx) => (
                <tr key={`${row.orderId || row.postingNumber || idx}`}>
                  <td>{row.operationDate || '—'}</td>
                  <td>{row.marketplace || '—'}</td>
                  <td title={row.lineCount > 1 ? `Операций в отчёте: ${row.lineCount}` : undefined}>
                    {row.orderId || (row.postingNumber && row.postingNumber !== '0' ? row.postingNumber : null) || '—'}
                  </td>
                  <td>
                    {row.productName || '—'}
                    {row.sku ? ` (${row.sku})` : ''}
                    {row.erpSku ? (
                      <span className="fbo-sales-analytics__erp-sku"> · ERP: {row.erpSku}</span>
                    ) : null}
                  </td>
                  <td className="sales-analytics__num">{formatQty(row.quantity)}</td>
                  <td className="sales-analytics__num">{formatRub(row.costAmount)}</td>
                  <AmountCell value={row.retailAmount} format={formatRub} tooltip={row.amountTooltips?.retail} />
                  <AmountCell value={row.commissionAmount} format={formatRub} tooltip={row.amountTooltips?.commission} />
                  <AmountCell value={row.logisticsAmount} format={formatRub} tooltip={row.amountTooltips?.logistics} />
                  <AmountCell value={row.storageAmount} format={formatRub} tooltip={row.amountTooltips?.storage} />
                  <AmountCell
                    value={otherDeductionsTotal(row)}
                    format={formatRub}
                    tooltip={row.amountTooltips?.other}
                  />
                  <td className="sales-analytics__num">{formatRub(row.payoutAmount)}</td>
                  <AmountCell value={row.taxAmount} format={formatRub} tooltip={row.taxTooltip} />
                  <td className="sales-analytics__num">{formatRub(row.netIncome)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        finance/transaction/list (FBO), Яндекс — united-netting (FBY). Вкладка «По заказам» — одна строка на
        продажу WB (затраты из других операций отчёта подтягиваются по заказу/штрихкоду). В сводке число
        заказов = только операции «Продажа», не служебные строки отчёта.
        {taxMeta?.taxSystemLabel ? (
          <>
            {' '}
            Налоги: схема «{taxMeta.taxSystemLabel}»
            {taxMeta.organizationName ? ` (${taxMeta.organizationName})` : ''}; база — выручка минус
            себестоимость и удержания МП.
          </>
        ) : (
          <> Укажите систему налогообложения в карточке организации для расчёта налогов.</>
        )}
      </p>
    </div>
  );
}
