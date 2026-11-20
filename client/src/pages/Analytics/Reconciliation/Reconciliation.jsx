/**
 * Сверка финансов с агрегатами финотчётов МП.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import {
  MARKETPLACE_OPTIONS,
  SCHEME_OPTIONS,
  SelectFilter,
  SummaryCards,
  errorMessage,
  formatRub,
  marketplaceLabel,
} from '../shared/analyticsKit';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

const METRICS = [
  { key: 'revenue', label: 'Выручка (реализ.)' },
  { key: 'commission', label: 'Комиссия' },
  { key: 'logistics', label: 'Логистика' },
  { key: 'storage', label: 'Хранение' },
  { key: 'penalty', label: 'Штрафы' },
  { key: 'acquiring', label: 'Эквайринг' },
  { key: 'other', label: 'Прочие удержания' },
  { key: 'payout', label: 'К оплате / перечислению' },
];

function deltaTone(v) {
  if (v == null || !Number.isFinite(Number(v))) return undefined;
  const n = Math.abs(Number(v));
  if (n < 0.5) return 'ok';
  return Number(v) === 0 ? 'ok' : 'warn';
}

export function Reconciliation() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [marketplace, setMarketplace] = useState('all');
  const [scheme, setScheme] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getReconciliation({
        dateFrom,
        dateTo,
        marketplace,
        scheme,
      });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось построить сверку'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, marketplace, scheme]);

  useEffect(() => {
    load();
  }, [load]);

  const summary = data?.summary;
  const rows = Array.isArray(data?.rows) ? data.rows : [];

  const cards = [
    { label: 'Выручка (наши)', value: formatRub(summary?.ours?.revenue) },
    { label: 'К оплате (наши)', value: formatRub(summary?.ours?.payout) },
    {
      label: 'Δ выручка',
      value: formatRub(summary?.delta?.revenue),
      tone: deltaTone(summary?.delta?.revenue),
    },
    {
      label: 'Δ к оплате',
      value: formatRub(summary?.delta?.payout),
      tone: deltaTone(summary?.delta?.payout),
    },
  ];

  return (
    <div className="sales-analytics">
      <PageTitle
        title="Сверка"
        subtitle="Агрегаты финотчётов FBO+FBS vs группировка по ID отчёта МП"
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
        <SelectFilter
          label="Маркетплейс"
          value={marketplace}
          onChange={setMarketplace}
          options={MARKETPLACE_OPTIONS}
        />
        <SelectFilter label="Схема" value={scheme} onChange={setScheme} options={SCHEME_OPTIONS} />
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Сверка…' : 'Обновить'}
        </Button>
      </div>

      {data?.mvpNote ? <p className="sales-analytics__hint">{data.mvpNote}</p> : null}
      {error ? <div className="sales-analytics__error">{error}</div> : null}

      <SummaryCards cards={cards} />

      {!rows.length && !loading ? (
        <div className="sales-analytics__empty" style={{ marginTop: 16 }}>
          Нет строк финотчётов за период. Загрузите отчёты в «Продажи FBS/FBO».
        </div>
      ) : null}

      {rows.map((row) => (
        <div key={row.marketplace} style={{ marginTop: 16 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
            {marketplaceLabel(row.marketplace)} · строк: {row.lineCount}
          </h3>
          <div className="sales-analytics__table-wrap">
            <table className="sales-analytics__table">
              <thead>
                <tr>
                  <th>Показатель</th>
                  <th className="sales-analytics__num">Наши</th>
                  <th className="sales-analytics__num">По отчётам</th>
                  <th className="sales-analytics__num">Δ</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => {
                  const d = Number(row.delta?.[m.key]) || 0;
                  return (
                    <tr key={m.key}>
                      <td>{m.label}</td>
                      <td className="sales-analytics__num">{formatRub(row.ours?.[m.key])}</td>
                      <td className="sales-analytics__num">{formatRub(row.report?.[m.key])}</td>
                      <td
                        className="sales-analytics__num"
                        style={{ color: Math.abs(d) < 0.5 ? undefined : '#b91c1c' }}
                      >
                        {formatRub(d)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {row.reportParts?.length > 1 ? (
            <p className="sales-analytics__hint" style={{ marginTop: 6 }}>
              Отчётов в периоде: {row.reportParts.map((p) => p.reportKey).join(', ')}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default Reconciliation;
