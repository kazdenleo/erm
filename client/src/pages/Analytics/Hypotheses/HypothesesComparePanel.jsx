/**
 * Сводка и график: период до старта vs период действия гипотезы.
 */

import React, { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const METRICS = [
  { value: 'soldQty', label: 'Штуки' },
  { value: 'netIncome', label: 'Прибыль' },
  { value: 'soldAmount', label: 'Выручка' },
];

function formatQty(n) {
  if (!Number.isFinite(Number(n))) return '0';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(n));
}

function formatRub(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number(n));
}

function formatYmdRu(ymd) {
  const s = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}

function formatPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const pct = Number(n) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

function deltaClass(n) {
  const v = Number(n) || 0;
  if (v > 0) return 'hypotheses__delta hypotheses__delta--up';
  if (v < 0) return 'hypotheses__delta hypotheses__delta--down';
  return 'hypotheses__delta';
}

function formatMetric(metric, value) {
  return metric === 'soldQty' ? formatQty(value) : formatRub(value);
}

function ChartTooltip({ active, payload, label, metric }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((entry) => entry.value != null);
  if (!rows.length) return null;
  return (
    <div className="hypotheses-compare__tip">
      <b>День {label}</b>
      {rows.map((entry) => (
        <span key={entry.dataKey} className="hypotheses-compare__tip-row">
          <span>
            {entry.name}
            {entry.payload?.[`${entry.dataKey}Date`]
              ? ` · ${formatYmdRu(entry.payload[`${entry.dataKey}Date`])}`
              : ''}
          </span>
          <span>{formatMetric(metric, entry.value)}</span>
        </span>
      ))}
    </div>
  );
}

function seriesPointValue(point, metric) {
  if (!point || point.isFuture || point[metric] == null) return null;
  return Number(point[metric]) || 0;
}

function formatAxis(metric, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (metric === 'soldQty') return formatQty(n);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн`;
  if (abs >= 1000) return `${Math.round(n / 1000)} тыс`;
  return formatQty(n);
}

function PeriodCard({ title, period, note, tone }) {
  if (!period) return null;
  return (
    <div className={`hypotheses-compare__card hypotheses-compare__card--${tone}`}>
      <div className="hypotheses-compare__card-title">{title}</div>
      <div className="hypotheses-compare__card-dates">
        {formatYmdRu(period.dateFrom)} — {formatYmdRu(period.dateTo)}
      </div>
      {note ? <div className="hypotheses-compare__card-note">{note}</div> : null}
      <div className="hypotheses-compare__stats">
        <div>
          <span>Штуки</span>
          <b>{formatQty(period.soldQty)}</b>
        </div>
        <div>
          <span>Выручка</span>
          <b>{formatRub(period.soldAmount)}</b>
        </div>
        <div>
          <span>Прибыль</span>
          <b>{formatRub(period.netIncome)}</b>
        </div>
      </div>
    </div>
  );
}

function DeltaRow({ label, current, previous, formatValue }) {
  const delta = (Number(current) || 0) - (Number(previous) || 0);
  const prev = Number(previous) || 0;
  const pct = prev === 0 ? (Number(current) || 0) === 0 ? 0 : null : delta / Math.abs(prev);
  return (
    <div className="hypotheses-compare__delta-row">
      <span>{label}</span>
      <span className={deltaClass(delta)}>
        {delta > 0 ? '+' : ''}
        {formatValue(delta)} · {formatPct(pct)}
      </span>
    </div>
  );
}

export function HypothesesComparePanel({ comparison }) {
  const [metric, setMetric] = useState('soldQty');
  const previous = comparison?.previousFull || comparison?.previous;
  const current = comparison?.current;
  const deltaBase = comparison?.previous || previous;

  const chart = useMemo(() => {
    const prevSeries = Array.isArray(previous?.series) ? previous.series : [];
    const currSeries = Array.isArray(current?.series) ? current.series : [];
    const len = Math.max(prevSeries.length, currSeries.length, Number(comparison?.plannedDays) || 0);
    if (!len) return [];
    const rows = [];
    for (let i = 0; i < len; i += 1) {
      const prev = prevSeries[i];
      const curr = currSeries[i];
      rows.push({
        day: i + 1,
        label: String(i + 1),
        previous: seriesPointValue(prev, metric),
        previousDate: prev?.date || null,
        current: seriesPointValue(curr, metric),
        currentDate: curr?.date || null,
      });
    }
    return rows;
  }, [previous, current, comparison?.plannedDays, metric]);

  if (!comparison || !current) return null;

  const hasChart = chart.some((r) => r.previous != null || r.current != null);

  return (
    <div className="hypotheses-compare">
      <h3 className="hypotheses-compare__title">Сравнение периодов</h3>
      <div className="hypotheses-compare__cards">
        <PeriodCard
          title="Предыдущий период"
          period={previous}
          tone="prev"
          note={`${comparison.plannedDays || previous?.series?.length || 0} дн. до даты создания`}
        />
        <PeriodCard
          title="Наблюдение"
          period={current}
          tone="now"
          note={
            comparison.incomplete
              ? `${comparison.elapsedDays} из ${comparison.plannedDays} дн. уже прошло`
              : `${comparison.plannedDays} дн. наблюдения`
          }
        />
      </div>

      <div className="hypotheses-compare__deltas">
        <DeltaRow
          label="Штуки"
          current={current.soldQty}
          previous={deltaBase?.soldQty}
          formatValue={formatQty}
        />
        <DeltaRow
          label="Выручка"
          current={current.soldAmount}
          previous={deltaBase?.soldAmount}
          formatValue={formatRub}
        />
        <DeltaRow
          label="Прибыль"
          current={current.netIncome}
          previous={deltaBase?.netIncome}
          formatValue={formatRub}
        />
      </div>
      {comparison.incomplete ? (
        <p className="hypotheses-compare__warn">
          Дельта считается по прошедшим дням наблюдения и тем же порядковым дням предыдущего периода.
          На графике серая линия — предыдущий период целиком, синяя — уже прошедшие дни наблюдения.
        </p>
      ) : null}

      <div className="hypotheses-compare__metric-toggle" role="group" aria-label="Метрика графика">
        {METRICS.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`hypotheses-form__preset${metric === m.value ? ' is-active' : ''}`}
            onClick={() => setMetric(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="hypotheses-compare__chart">
        {!hasChart ? (
          <div className="hypotheses-compare__empty">Нет продаж в отчётах FBO/FBS за эти дни.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chart} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} interval="preserveStartEnd" />
              <YAxis
                tick={{ fontSize: 12 }}
                tickFormatter={(v) => formatAxis(metric, v)}
                width={metric === 'soldQty' ? 40 : 64}
              />
              <Tooltip content={<ChartTooltip metric={metric} />} />
              <Legend />
              <Line
                type="monotone"
                dataKey="previous"
                name="Предыдущий"
                stroke="#64748b"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="current"
                name="Наблюдение"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
