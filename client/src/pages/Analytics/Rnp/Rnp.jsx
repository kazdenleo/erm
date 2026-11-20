/**
 * РНП — пульс магазина: метрики + задачи + гипотезы за период.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import {
  SummaryCards,
  errorMessage,
  formatDateRu,
  formatQty,
  formatRub,
  marketplaceLabel,
} from '../shared/analyticsKit';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

function deltaClass(v) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  if (Number(v) > 0) return ' rnp__delta--up';
  if (Number(v) < 0) return ' rnp__delta--down';
  return '';
}

export function Rnp() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getRnpPulse({ dateFrom, dateTo });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить РНП'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const metrics = data?.metrics;
  const tasks = data?.tasks;
  const hyp = data?.hypotheses;
  const byMp = metrics?.byMarketplace || {};

  const cards = [
    { label: 'Выручка', value: formatRub(metrics?.revenue) },
    { label: 'Заказы, шт', value: formatQty(metrics?.ordersQty, 0) },
    {
      label: 'Задачи закрыто',
      value: formatQty(tasks?.completedInPeriod, 0),
      sub: `открыто сейчас: ${formatQty(tasks?.openCount, 0)}`,
    },
    {
      label: 'Гипотезы в периоде',
      value: formatQty(hyp?.inPeriod, 0),
      sub: `рост продаж: ${formatQty(hyp?.withSalesUp, 0)} · ждут вывод: ${formatQty(hyp?.awaitingConclusion, 0)}`,
    },
  ];

  return (
    <div className="sales-analytics">
      <PageTitle
        title="РНП"
        subtitle="Пульс: продажи за период рядом с работой команды (задачи и гипотезы)"
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
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
        <Link to="/tasks" className="btn btn-secondary btn-sm">
          Задачи
        </Link>
        <Link to="/card-work/hypotheses" className="btn btn-secondary btn-sm">
          Гипотезы
        </Link>
      </div>

      {data?.mvpNote ? <p className="sales-analytics__hint">{data.mvpNote}</p> : null}
      {error ? <div className="sales-analytics__error">{error}</div> : null}

      <SummaryCards cards={cards} />

      <div className="product-dynamics__summary-cards" style={{ marginTop: 8 }}>
        {['wb', 'ozon', 'ym', 'fbo'].map((mp) => (
          <div key={mp} className="product-dynamics__summary-card">
            <div className="product-dynamics__summary-card-label">{marketplaceLabel(mp)}</div>
            <div className="product-dynamics__summary-card-value">{formatRub(byMp[mp]?.amount)}</div>
            <div className="analytics-kit__card-sub">{formatQty(byMp[mp]?.qty, 0)} шт</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="sales-analytics__table-wrap">
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Закрытые задачи</h3>
          <table className="sales-analytics__table">
            <thead>
              <tr>
                <th>Задача</th>
                <th>Товар</th>
                <th>Исполнитель</th>
                <th>Дата</th>
              </tr>
            </thead>
            <tbody>
              {!tasks?.recentCompleted?.length ? (
                <tr>
                  <td colSpan={4} className="sales-analytics__empty">
                    Нет закрытых задач за период
                  </td>
                </tr>
              ) : (
                tasks.recentCompleted.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title || '—'}</td>
                    <td>{t.productSku || '—'}</td>
                    <td>{t.assigneeName || '—'}</td>
                    <td>{formatDateRu(String(t.completedAt || '').slice(0, 10))}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="sales-analytics__table-wrap">
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Гипотезы в периоде</h3>
          <table className="sales-analytics__table">
            <thead>
              <tr>
                <th>Гипотеза</th>
                <th>SKU</th>
                <th>Δ продаж</th>
                <th>Δ прибыль</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {!hyp?.items?.length ? (
                <tr>
                  <td colSpan={5} className="sales-analytics__empty">
                    Нет гипотез, пересекающихся с периодом
                  </td>
                </tr>
              ) : (
                hyp.items.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <div>{h.title || '—'}</div>
                      {h.readyForConclusion && !h.conclusion ? (
                        <div className="sales-analytics__hint">ждёт вывод</div>
                      ) : null}
                    </td>
                    <td>{h.productSku || '—'}</td>
                    <td className={`sales-analytics__num${deltaClass(h.soldQtyDelta)}`}>
                      {h.soldQtyDelta == null ? '—' : formatQty(h.soldQtyDelta, 0)}
                    </td>
                    <td className={`sales-analytics__num${deltaClass(h.netIncomeDelta)}`}>
                      {h.netIncomeDelta == null ? '—' : formatRub(h.netIncomeDelta)}
                    </td>
                    <td>{h.status === 'completed' ? 'закрыта' : 'активна'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        .rnp__delta--up { color: #15803d; }
        .rnp__delta--down { color: #b91c1c; }
        @media (max-width: 960px) {
          .sales-analytics > div[style*="grid-template-columns"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}

export default Rnp;
