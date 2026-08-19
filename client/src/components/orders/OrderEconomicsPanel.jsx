import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketplaceFbsReportsApi } from '../../services/marketplaceFbsReports.api';
import { marketplaceFboReportsApi } from '../../services/marketplaceFboReports.api';
import { AmountCell, otherDeductionsTotal } from '../../pages/Analytics/shared/AmountCell';
import { formatRub, orderEconomicsFromRow } from '../../pages/Analytics/shared/orderEconomics';
import './OrderEconomicsPanel.css';

function costsTitle(eco) {
  return `Удержания МП: ${formatRub(eco.mpFees)}`;
}

export function OrderEconomicsPanel({ marketplace, orderId, scheme = 'fbs' }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [item, setItem] = useState(null);
  const [found, setFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const mp = String(marketplace || '').trim();
    const oid = String(orderId || '').trim();
    if (!mp || !oid || mp.toLowerCase() === 'manual') {
      setLoading(false);
      setFound(false);
      setItem(null);
      return undefined;
    }
    setLoading(true);
    setError(null);
    const api = scheme === 'fbo' ? marketplaceFboReportsApi : marketplaceFbsReportsApi;
    api
      .lookup({ marketplace: mp, orderId: oid })
      .then((res) => {
        if (cancelled) return;
        const data = res?.data || res;
        setFound(Boolean(data?.found));
        setItem(data?.item || null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить факт по заказу');
        setFound(false);
        setItem(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [marketplace, orderId, scheme]);

  const eco = orderEconomicsFromRow(item);
  const analyticsPath = scheme === 'fbo' ? '/analytics/fbo-sales' : '/analytics/sales';

  return (
    <section className="order-detail-section order-economics">
      <h3>Факт по заказу</h3>
      {loading ? (
        <p className="order-economics__hint">Загрузка финансового отчёта…</p>
      ) : error ? (
        <p className="order-economics__error">{error}</p>
      ) : !found || !item ? (
        <p className="order-economics__hint">
          В отчёте маркетплейса этой продажи ещё нет. Обычно начисления появляются после доставки
          покупателю. Загрузить отчёт: Аналитика → {scheme === 'fbo' ? 'Продажи FBO' : 'Продажи FBS'}.
        </p>
      ) : (
        <>
          <div className="order-economics__facts">
            <div className="order-economics__fact">
              <div className="order-economics__label">Цена продажи</div>
              <div className="order-economics__value">{formatRub(eco.saleAmount)}</div>
              <div className="order-economics__sub">как в отчёте МП</div>
            </div>
            <div className="order-economics__fact" title={costsTitle(eco)}>
              <div className="order-economics__label">Затраты</div>
              <div className="order-economics__value">{formatRub(eco.costsTotal)}</div>
              <div className="order-economics__sub">удержания МП</div>
            </div>
            <div className="order-economics__fact">
              <div className="order-economics__label">Пришло от МП</div>
              <div className="order-economics__value">{formatRub(eco.receivedAmount)}</div>
              <div className="order-economics__sub">к перечислению по отчёту</div>
            </div>
          </div>
          <table className="order-economics__breakdown">
            <tbody>
              <tr>
                <th>Комиссия</th>
                <AmountCell value={item.commissionAmount} format={formatRub} tooltip={item.amountTooltips?.commission} />
              </tr>
              <tr>
                <th>Логистика</th>
                <AmountCell value={item.logisticsAmount} format={formatRub} tooltip={item.amountTooltips?.logistics} />
              </tr>
              <tr>
                <th>Хранение</th>
                <AmountCell value={item.storageAmount} format={formatRub} tooltip={item.amountTooltips?.storage} />
              </tr>
              <tr>
                <th>Прочее</th>
                <AmountCell
                  value={otherDeductionsTotal(item)}
                  format={formatRub}
                  tooltip={item.amountTooltips?.other}
                />
              </tr>
              <tr>
                <th>Себестоимость</th>
                <td>{formatRub(item.costAmount)}</td>
              </tr>
              <tr>
                <th>Доп. расходы</th>
                <td>{formatRub(item.additionalExpensesAmount)}</td>
              </tr>
              <tr>
                <th>Выручка</th>
                <td>{formatRub(eco.revenueAmount)}</td>
              </tr>
              <tr>
                <th>Налоги</th>
                <AmountCell value={item.taxAmount} format={formatRub} tooltip={item.taxTooltip} />
              </tr>
              <tr>
                <th>Чистый доход</th>
                <td>{formatRub(item.netIncome)}</td>
              </tr>
            </tbody>
          </table>
          <p className="order-economics__hint">
            Дата операции: {item.operationDate || '—'}. Полный список за период —{' '}
            <Link to={analyticsPath}>в аналитике</Link>.
          </p>
        </>
      )}
    </section>
  );
}
