/**
 * Аналитика продаж FBS по товарам
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import './SalesAnalytics.css';

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

export function SalesAnalytics() {
  const initial = useMemo(() => defaultRange(), []);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getFbsByProduct({ dateFrom, dateTo, marketplace });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить аналитику');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary || {};
  const items = Array.isArray(data?.items) ? data.items : [];

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-graph2"
        iconBgClass="bg-mean-fruit"
        title="Продажи FBS"
        subtitle="По товарам: доставлено, отменено и возвращено на склад за период"
      />

      <div className="sales-analytics__filters erp-filter-bar">
        <label className="sales-analytics__filter">
          <span>С</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
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
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      <div className="sales-analytics__cards">
        <div className="sales-analytics__card sales-analytics__card--sold">
          <div className="sales-analytics__card-label">Продано</div>
          <div className="sales-analytics__card-value">{formatQty(summary.soldQty)} шт.</div>
          <div className="sales-analytics__card-sub">{formatRub(summary.soldAmount)}</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--canceled">
          <div className="sales-analytics__card-label">Отменено</div>
          <div className="sales-analytics__card-value">{formatQty(summary.canceledQty)} шт.</div>
          <div className="sales-analytics__card-sub">{formatRub(summary.canceledAmount)}</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--returned">
          <div className="sales-analytics__card-label">Вернулось</div>
          <div className="sales-analytics__card-value">{formatQty(summary.returnedQty)} шт.</div>
          <div className="sales-analytics__card-sub">Приёмки «Возврат от клиента»</div>
        </div>
      </div>

      <div className="sales-analytics__table-wrap">
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <th>Товар</th>
              <th>Артикул</th>
              <th className="sales-analytics__num">Продано</th>
              <th className="sales-analytics__num">Сумма</th>
              <th className="sales-analytics__num">Отменено</th>
              <th className="sales-analytics__num">Вернулось</th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="sales-analytics__empty">
                  Нет данных за выбранный период
                </td>
              </tr>
            )}
            {items.map((row) => (
              <tr key={row.productId}>
                <td>{row.productName || '—'}</td>
                <td>{row.productSku || '—'}</td>
                <td className="sales-analytics__num">{formatQty(row.soldQty)}</td>
                <td className="sales-analytics__num">{formatRub(row.soldAmount)}</td>
                <td className="sales-analytics__num">{formatQty(row.canceledQty)}</td>
                <td className="sales-analytics__num">{formatQty(row.returnedQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Продано и отменено — по заказам FBS (Ozon, WB, Яндекс) со статусами «Доставлен» и «Отменён».
        Вернулось — по документам приёмки «Возврат от клиента» на склад.
      </p>
    </div>
  );
}
