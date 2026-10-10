/**
 * Главная: динамика продаж по всем маркетплейсам и частным заказам (шт / ₽).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { salesAnalyticsApi } from '../../services/salesAnalytics.api';

const SERIES = [
  { key: 'ozon', label: 'Ozon FBS', color: '#005bff' },
  { key: 'wb', label: 'Wildberries FBS', color: '#cb11ab' },
  { key: 'ym', label: 'Яндекс Маркет FBS', color: '#f5b800' },
  { key: 'manual', label: 'Частные заказы', color: '#6c757d' },
  { key: 'fbo', label: 'FBO (склад МП)', color: '#16a34a' },
];

const PERIODS = [
  { value: 30, label: '30 дней', granularity: 'day' },
  { value: 90, label: '90 дней', granularity: 'week' },
  { value: 180, label: '6 месяцев', granularity: 'week' },
  { value: 365, label: 'Год', granularity: 'month' },
];

const GRANULARITIES = [
  { value: 'day', label: 'Дни' },
  { value: 'week', label: 'Недели' },
  { value: 'month', label: 'Месяцы' },
];

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d);
}

/** Начало периода выровнено по началу недели / месяца, чтобы первый столбец был полным. */
function periodRange(days, granularity) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  if (granularity === 'week') {
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  } else if (granularity === 'month') {
    from.setDate(1);
  }
  return { dateFrom: ymd(from), dateTo: ymd(to) };
}

const qtyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const rubFmt = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

function formatValue(metric, v) {
  const n = Number(v) || 0;
  return metric === 'amount' ? rubFmt.format(n) : `${qtyFmt.format(n)} шт.`;
}

function formatAxis(metric, v) {
  const n = Number(v) || 0;
  if (metric !== 'amount') return qtyFmt.format(n);
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3).toLocaleString('ru-RU')} тыс`;
  return qtyFmt.format(n);
}

function formatTick(granularity, date) {
  const d = parseYmd(date);
  if (granularity === 'month') {
    return d.toLocaleDateString('ru-RU', { month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function formatBucketTitle(granularity, date) {
  const d = parseYmd(date);
  if (granularity === 'month') {
    return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  }
  if (granularity === 'week') {
    const end = new Date(d);
    end.setDate(end.getDate() + 6);
    const f = (x) => x.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return `Неделя ${f(d)} — ${f(end)}`;
  }
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

function ChartTooltip({ active, payload, label, metric, granularity }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return (
    <div className="home-sales-tooltip">
      <div className="home-sales-tooltip__title">{formatBucketTitle(granularity, label)}</div>
      {[...payload].reverse().map((p) => (
        <div key={p.dataKey} className="home-sales-tooltip__row">
          <span className="home-sales-tooltip__dot" style={{ background: p.color }} />
          <span className="home-sales-tooltip__name">{p.name}</span>
          <span className="home-sales-tooltip__val">{formatValue(metric, p.value)}</span>
        </div>
      ))}
      <div className="home-sales-tooltip__row home-sales-tooltip__total">
        <span className="home-sales-tooltip__name">Итого</span>
        <span className="home-sales-tooltip__val">{formatValue(metric, total)}</span>
      </div>
    </div>
  );
}

const CHART_HEIGHT = 320;

export function HomeSalesDynamics({ profileId }) {
  const [periodDays, setPeriodDays] = useState(30);
  const [granularity, setGranularity] = useState('day');
  const [metric, setMetric] = useState('qty');
  const [hidden, setHidden] = useState(() => new Set());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (profileId == null) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const range = periodRange(periodDays, granularity);
      const res = await salesAnalyticsApi.getHomeDynamics({ ...range, granularity });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить динамику продаж');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [profileId, periodDays, granularity]);

  useEffect(() => {
    load();
  }, [load]);

  const chartData = useMemo(
    () =>
      (data?.buckets || []).map((b) => {
        const row = { date: b.date };
        for (const s of SERIES) row[s.key] = Number(b[s.key]?.[metric]) || 0;
        return row;
      }),
    [data, metric]
  );

  const visibleTotal = useMemo(() => {
    const totals = data?.totals || {};
    return SERIES.filter((s) => !hidden.has(s.key)).reduce(
      (acc, s) => ({
        qty: acc.qty + (Number(totals[s.key]?.qty) || 0),
        amount: acc.amount + (Number(totals[s.key]?.amount) || 0),
      }),
      { qty: 0, amount: 0 }
    );
  }, [data, hidden]);

  const toggleSeries = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onPeriodChange = (value) => {
    const p = PERIODS.find((x) => x.value === value);
    setPeriodDays(value);
    if (p) setGranularity(p.granularity);
  };

  const fboLastDate = data?.fboLastDate
    ? parseYmd(data.fboLastDate).toLocaleDateString('ru-RU')
    : null;

  const fboLiveNote = (() => {
    const entries = Object.entries(data?.fboLive || {}).filter(([, v]) => v?.liveFrom);
    if (!entries.length) return null;
    const labels = { ozon: 'Ozon', wb: 'WB', ym: 'Я.Маркет' };
    return entries
      .map(([mp, v]) => `${labels[mp] || mp} — с ${parseYmd(v.liveFrom).toLocaleDateString('ru-RU')}`)
      .join(', ');
  })();

  const sourcesNote =
    'FBS и частные заказы — по дате оформления, без отменённых; сумма — цена продажи × количество. ' +
    (fboLiveNote
      ? `FBO — заказы со склада маркетплейса в реальном времени (обновление каждые 30 минут; ${fboLiveNote}); более ранние даты — из финансовых отчётов`
      : 'FBO — продажи со склада маркетплейса из финансовых отчётов (по дате продажи)') +
    (fboLastDate ? `, отчёты загружены по ${fboLastDate}` : ', отчёты ещё не загружались') +
    (fboLiveNote ? '.' : ': за последние дни FBO может быть неполным.') +
    ' Нажмите на пункт легенды, чтобы скрыть или показать ряд.';

  return (
    <div className="card mb-0 home-sales-dynamics">
      <div className="card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="card-header-title mb-0">
          <i className="header-icon pe-7s-graph1 icon-gradient bg-mean-fruit me-2" />
          Динамика продаж
          <i className="pe-7s-info home-sales-dynamics__info ms-2" title={sourcesNote} aria-label={sourcesNote} />
        </div>
        <div className="home-sales-dynamics__controls">
          <select
            className="form-select form-select-sm"
            value={periodDays}
            onChange={(e) => onPeriodChange(Number(e.target.value))}
            aria-label="Период"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="btn-group btn-group-sm" role="group" aria-label="Группировка">
            {GRANULARITIES.map((g) => (
              <button
                key={g.value}
                type="button"
                className={`btn btn-outline-secondary${granularity === g.value ? ' active' : ''}`}
                onClick={() => setGranularity(g.value)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="btn-group btn-group-sm" role="group" aria-label="Показатель">
            <button
              type="button"
              className={`btn btn-outline-primary${metric === 'qty' ? ' active' : ''}`}
              onClick={() => setMetric('qty')}
            >
              Штуки
            </button>
            <button
              type="button"
              className={`btn btn-outline-primary${metric === 'amount' ? ' active' : ''}`}
              onClick={() => setMetric('amount')}
            >
              Рубли
            </button>
          </div>
        </div>
      </div>
      <div className="card-body">
        {profileId == null ? (
          <div className="text-muted">Нет привязки к аккаунту — динамика продаж недоступна.</div>
        ) : (
          <>
            <div className="home-sales-dynamics__summary">
              <div>
                <div className="home-sales-dynamics__summary-label">Итого за период</div>
                <div className="home-sales-dynamics__summary-value">
                  {loading && !data ? '…' : `${qtyFmt.format(visibleTotal.qty)} шт.`}
                </div>
              </div>
              <div>
                <div className="home-sales-dynamics__summary-label">Сумма</div>
                <div className="home-sales-dynamics__summary-value">
                  {loading && !data ? '…' : rubFmt.format(visibleTotal.amount)}
                </div>
              </div>
              {loading && data && <div className="text-muted small align-self-end">Обновление…</div>}
            </div>

            {error && (
              <div className="alert alert-warning py-2 mb-3" role="alert">
                {error}
              </div>
            )}

            <div className="home-sales-dynamics__chart">
              <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(d) => formatTick(granularity, d)}
                    minTickGap={12}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    width={metric === 'amount' ? 70 : 50}
                    tickFormatter={(v) => formatAxis(metric, v)}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(0, 0, 0, 0.04)' }}
                    content={<ChartTooltip metric={metric} granularity={granularity} />}
                  />
                  <Legend
                    onClick={(e) => toggleSeries(e.dataKey)}
                    wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                    formatter={(value, entry) => (
                      <span style={{ opacity: hidden.has(entry.dataKey) ? 0.4 : 1 }}>{value}</span>
                    )}
                  />
                  {SERIES.map((s) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      name={s.label}
                      stackId="sales"
                      fill={s.color}
                      hide={hidden.has(s.key)}
                      maxBarSize={48}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
