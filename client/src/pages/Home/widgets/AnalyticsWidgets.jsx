/**
 * Виджеты главной на основе отчётов аналитики: сводные показатели со ссылкой на полный отчёт.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import {
  DAY_PERIODS,
  MONTH_PERIODS,
  dayRange,
  errorMessage,
  formatPercent,
  formatQty,
  formatRubShort,
  monthRange,
  periodLabel,
} from './widgetUtils';

function useReport(loader, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    load()
      .then((res) => alive && setData(res?.data ?? null))
      .catch((e) => {
        if (!alive) return;
        setError(errorMessage(e, 'Не удалось загрузить отчёт'));
        setData(null);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [load, tick]);

  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

function toneOf(n) {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return undefined;
  return Number(n) > 0 ? 'good' : 'bad';
}

export function KpiCard({ icon, title, period, to, loading, error, onReload, metrics, children }) {
  return (
    <div className="card mb-0 home-kpi-card">
      <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="card-header-title mb-0">
          <i className={`header-icon ${icon} icon-gradient bg-mean-fruit me-2`} />
          {title}
          {period && <span className="home-kpi-card__period">{period}</span>}
        </div>
        {to && (
          <Link to={to} className="home-kpi-card__more">
            Подробнее →
          </Link>
        )}
      </div>
      <div className="card-body">
        {error ? (
          <div className="text-danger small">
            {error}{' '}
            <button type="button" className="btn btn-link btn-sm p-0 align-baseline" onClick={onReload}>
              Повторить
            </button>
          </div>
        ) : (
          <>
            <div className="home-kpi-grid">
              {metrics.map((m) => (
                <div key={m.label} className="home-kpi" title={m.hint || undefined}>
                  <div className="home-kpi__label">{m.label}</div>
                  <div className={`home-kpi__value${m.tone ? ` home-kpi__value--${m.tone}` : ''}`}>
                    {loading ? '…' : m.value}
                  </div>
                </div>
              ))}
            </div>
            {!loading && children}
          </>
        )}
      </div>
    </div>
  );
}

function TopList({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <div className="home-kpi-top">
      <div className="home-kpi-top__title">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="home-kpi-top__row">
          <span className="home-kpi-top__name" title={r.name}>
            {r.name}
          </span>
          <span className="home-kpi-top__val">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function PnlWidget({ settings }) {
  const period = settings?.period || 'month';
  const { data, loading, error, reload } = useReport(() => salesAnalyticsApi.getPnl(monthRange(period)), [period]);
  const t = data?.total || {};
  return (
    <KpiCard
      icon="pe-7s-calculator"
      title="Прибыль (ОПиУ)"
      period={periodLabel(MONTH_PERIODS, period)}
      to="/analytics/pnl"
      loading={loading}
      error={error}
      onReload={reload}
      metrics={[
        { label: 'Выручка', value: formatRubShort(t.revenue) },
        { label: 'Удержания МП', value: formatRubShort(t.mpTake), hint: 'Комиссии, логистика, хранение, штрафы' },
        { label: 'Себестоимость', value: formatRubShort(t.cost) },
        { label: 'Валовая прибыль', value: formatRubShort(t.grossProfit), tone: toneOf(t.grossProfit) },
        { label: 'Чистая прибыль', value: formatRubShort(t.netProfit), tone: toneOf(t.netProfit) },
        { label: 'Маржа', value: formatPercent(t.marginPercent), tone: toneOf(t.marginPercent) },
      ]}
    />
  );
}

export function LostRevenueWidget({ settings }) {
  const period = settings?.period || '30d';
  const { data, loading, error, reload } = useReport(
    () => salesAnalyticsApi.getLostRevenue({ ...dayRange(period), limit: 5 }),
    [period]
  );
  const s = data?.summary || {};
  const top = (data?.items || [])
    .filter((it) => Number(it.lostRevenue) > 0)
    .slice(0, 5)
    .map((it, i) => ({
      key: `${it.productId}-${it.marketplace}-${it.scheme}-${i}`,
      name: it.productName || it.productSku || `Товар #${it.productId}`,
      value: formatRubShort(it.lostRevenue),
    }));
  return (
    <KpiCard
      icon="pe-7s-attention"
      title="Упущенная выручка"
      period={periodLabel(DAY_PERIODS, period)}
      to="/analytics/lost-revenue"
      loading={loading}
      error={error}
      onReload={reload}
      metrics={[
        { label: 'Выручка', value: formatRubShort(s.lostRevenue), tone: s.lostRevenue > 0 ? 'bad' : undefined },
        { label: 'Прибыль', value: formatRubShort(s.lostProfit) },
        { label: 'Нет в наличии сейчас', value: formatQty(Number(s.oosNowCount) || 0) },
        { label: 'Товаров затронуто', value: formatQty(Number(s.productsAffected) || 0) },
      ]}
    >
      <TopList title="Больше всего потерь" rows={top} />
    </KpiCard>
  );
}

export function ReturnsAnalyticsWidget({ settings }) {
  const period = settings?.period || '30d';
  const { data, loading, error, reload } = useReport(
    () => salesAnalyticsApi.getReturns(dayRange(period)),
    [period]
  );
  const s = data?.summary || {};
  return (
    <KpiCard
      icon="pe-7s-back"
      title="Возвраты и отмены"
      period={periodLabel(DAY_PERIODS, period)}
      to="/analytics/returns"
      loading={loading}
      error={error}
      onReload={reload}
      metrics={[
        { label: 'Процент возвратов', value: formatPercent(s.returnRate) },
        { label: 'Возвращено, шт', value: formatQty(Number(s.returnedQty) || 0) },
        { label: 'Сумма возвратов', value: formatRubShort(s.returnedAmount) },
        { label: 'Процент отмен', value: formatPercent(s.cancelRate) },
        { label: 'Обратная логистика', value: formatRubShort(s.reverseLogisticsCost) },
        {
          label: 'Товаров с высоким % возвратов',
          value: formatQty(Number(s.flaggedCount) || 0),
          tone: s.flaggedCount > 0 ? 'bad' : undefined,
        },
      ]}
    />
  );
}

export function DeadStockWidget() {
  const { data, loading, error, reload } = useReport(() => salesAnalyticsApi.getDeadStock(), []);
  const s = data?.summary || {};
  return (
    <KpiCard
      icon="pe-7s-lock"
      title="Неликвиды и замороженные деньги"
      to="/analytics/dead-stock"
      loading={loading}
      error={error}
      onReload={reload}
      metrics={[
        { label: 'Весь остаток', value: formatRubShort(s.totalStockCost) },
        {
          label: `Неликвид (${formatQty(Number(s.deadCount) || 0)} поз.)`,
          value: formatRubShort(s.deadCost),
          tone: s.deadCost > 0 ? 'bad' : undefined,
        },
        { label: `Избыток (${formatQty(Number(s.excessCount) || 0)} поз.)`, value: formatRubShort(s.excessCost) },
        { label: 'Хранение FBO в месяц', value: formatRubShort(s.fboStorageMonth) },
      ]}
    />
  );
}

export function PenaltiesWidget({ settings }) {
  const period = settings?.period || '30d';
  const { data, loading, error, reload } = useReport(
    () => salesAnalyticsApi.getPenalties(dayRange(period)),
    [period]
  );
  const s = data?.summary || {};
  return (
    <KpiCard
      icon="pe-7s-attention"
      title="Штрафы и удержания"
      period={periodLabel(DAY_PERIODS, period)}
      to="/analytics/penalties"
      loading={loading}
      error={error}
      onReload={reload}
      metrics={[
        {
          label: `Штрафы (${formatQty(Number(s.penaltyCount) || 0)})`,
          value: formatRubShort(s.penaltyTotal),
          tone: s.penaltyTotal > 0 ? 'bad' : undefined,
        },
        { label: 'Компенсации', value: formatRubShort(s.compensationTotal), tone: toneOf(s.compensationTotal) },
        {
          label: `Недоплачено (${formatQty(Number(s.underpaidCount) || 0)})`,
          value: formatRubShort(s.underpaidShortfall),
        },
        { label: `Не выплачено (${formatQty(Number(s.unpaidCount) || 0)})`, value: formatRubShort(s.unpaidAmount) },
      ]}
    />
  );
}

function hoursLabel(h) {
  if (!Number.isFinite(h) || h <= 0) return '—';
  if (h < 1) return `${Math.round(h * 60)} мин`;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(h)} ч`;
}

export function EmployeesWidget({ settings }) {
  const period = settings?.period || 'today';
  const { data, loading, error, reload } = useReport(
    () => salesAnalyticsApi.getEmployees(dayRange(period)),
    [period]
  );
  const s = data?.summary || {};
  const rows = (data?.employees || []).map((e) => ({
    id: e.userId,
    name: e.name,
    fbs: e.assembly?.orders || 0,
    collect: e.fboCollect?.units || 0,
    packing: e.packing?.units || 0,
    receipts: (e.receipts?.fbs?.units || 0) + (e.receipts?.fbo?.units || 0),
    hours:
      (e.assembly?.activeHours || 0) +
      (e.fboCollect?.activeHours || 0) +
      (e.packing?.activeHours || 0) +
      (e.receipts?.fbs?.activeHours || 0) +
      (e.receipts?.fbo?.activeHours || 0),
  }));
  return (
    <KpiCard
      icon="pe-7s-users"
      title="Сотрудники"
      period={periodLabel(DAY_PERIODS, period)}
      to="/analytics/employees"
      loading={loading}
      error={error}
      onReload={reload}
      metrics={[
        { label: 'FBS заказов собрано', value: formatQty(Number(s.ordersAssembled) || 0) },
        { label: 'FBO собрано, шт', value: formatQty(Number(s.fboCollectUnits) || 0) },
        { label: 'Упаковано, шт', value: formatQty(Number(s.packingUnits) || 0) },
      ]}
    >
      {rows.length === 0 ? (
        <div className="text-muted small mt-2">За период нет активности сотрудников.</div>
      ) : (
        <div className="table-responsive mt-2">
          <table className="table table-sm align-middle mb-0 home-kpi-table">
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th className="text-end">FBS</th>
                <th className="text-end">Сборка FBO</th>
                <th className="text-end">Упаковка</th>
                <th className="text-end">Приёмка</th>
                <th className="text-end">В работе</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="text-end">{r.fbs ? formatQty(r.fbs) : '—'}</td>
                  <td className="text-end">{r.collect ? formatQty(r.collect) : '—'}</td>
                  <td className="text-end">{r.packing ? formatQty(r.packing) : '—'}</td>
                  <td className="text-end">{r.receipts ? formatQty(r.receipts) : '—'}</td>
                  <td className="text-end text-nowrap">{hoursLabel(r.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </KpiCard>
  );
}
