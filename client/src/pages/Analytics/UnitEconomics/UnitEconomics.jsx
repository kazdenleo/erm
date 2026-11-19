/**
 * Юнит-экономика по артикулу (MVP «как Раск»).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { AnalyticsPeriodFilters } from '../shared/AnalyticsPeriodFilters';
import { DEFAULT_ANALYTICS_PERIOD, defaultAnalyticsRange } from '../shared/analyticsPeriod';
import { unitEconomicsApi } from '../../../services/unitEconomics.api';
import '../SalesAnalytics/SalesAnalytics.css';
import './UnitEconomics.css';

function formatQty(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(Number(n)));
}

function formatRub(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number(n));
}

function formatPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(n))} %`;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[;"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS = [
  { key: 'marketplace', label: 'МП', group: 'id', sticky: true, format: (r) => String(r.marketplace || '').toUpperCase() },
  { key: 'sku', label: 'Артикул продавца', group: 'id', sticky2: true },
  { key: 'erpSku', label: 'Артикул ERP', group: 'id' },
  { key: 'productName', label: 'Название', group: 'id' },
  { key: 'soldQty', label: 'Продажи шт', group: 'qty', format: (r) => formatQty(r.soldQty), num: true },
  { key: 'returnQty', label: 'Возвраты шт', group: 'qty', format: (r) => formatQty(r.returnQty), num: true },
  { key: 'returnRatePct', label: '% возвратов', group: 'qty', format: (r) => formatPct(r.returnRatePct), num: true },
  { key: 'realizedQty', label: 'Итого реализ. шт', group: 'qty', format: (r) => formatQty(r.realizedQty), num: true },
  { key: 'salesBeforeSpp', label: 'Продажи до СПП', group: 'before', format: (r) => formatRub(r.salesBeforeSpp), num: true },
  { key: 'returnsBeforeSpp', label: 'Возвраты до СПП', group: 'before', format: (r) => formatRub(r.returnsBeforeSpp), num: true },
  {
    key: 'realizedBeforeSpp',
    label: 'Реализ. до СПП',
    group: 'before',
    format: (r) => formatRub(r.realizedBeforeSpp),
    num: true,
  },
  {
    key: 'avgCheckBeforeSpp',
    label: 'Сред. чек до СПП',
    group: 'before',
    format: (r) => formatRub(r.avgCheckBeforeSpp),
    num: true,
  },
  { key: 'salesAfterSpp', label: 'Продажи после СПП', group: 'after', format: (r) => formatRub(r.salesAfterSpp), num: true },
  {
    key: 'returnsAfterSpp',
    label: 'Возвраты после СПП',
    group: 'after',
    format: (r) => formatRub(r.returnsAfterSpp),
    num: true,
  },
  {
    key: 'realizedAfterSpp',
    label: 'Реализ. после СПП',
    group: 'after',
    format: (r) => formatRub(r.realizedAfterSpp),
    num: true,
  },
  { key: 'sppAmount', label: 'Сумма СПП', group: 'after', format: (r) => formatRub(r.sppAmount), num: true },
  { key: 'sppPct', label: '% СПП', group: 'after', format: (r) => formatPct(r.sppPct), num: true },
  { key: 'commissionAmount', label: 'Комиссия', group: 'services', format: (r) => formatRub(r.commissionAmount), num: true },
  { key: 'logisticsAmount', label: 'Логистика', group: 'services', format: (r) => formatRub(r.logisticsAmount), num: true },
  { key: 'storageAmount', label: 'Хранение', group: 'services', format: (r) => formatRub(r.storageAmount), num: true },
  { key: 'penaltyAmount', label: 'Штрафы', group: 'services', format: (r) => formatRub(r.penaltyAmount), num: true },
  { key: 'acquiringAmount', label: 'Эквайринг', group: 'services', format: (r) => formatRub(r.acquiringAmount), num: true },
  { key: 'otherDeductions', label: 'Прочие удержания', group: 'services', format: (r) => formatRub(r.otherDeductions), num: true },
  { key: 'servicesTotal', label: 'Итого услуги МП', group: 'services', format: (r) => formatRub(r.servicesTotal), num: true },
  { key: 'payoutAmount', label: 'Итого к оплате', group: 'payout', format: (r) => formatRub(r.payoutAmount), num: true },
  { key: 'payoutPerUnit', label: 'К оплате / шт', group: 'payout', format: (r) => formatRub(r.payoutPerUnit), num: true },
  { key: 'taxAmount', label: 'Налог', group: 'direct', format: (r) => formatRub(r.taxAmount), num: true },
  { key: 'payoutAfterTax', label: 'К оплате − налог', group: 'direct', format: (r) => formatRub(r.payoutAfterTax), num: true },
  {
    key: 'costAmount',
    label: 'Себестоимость',
    group: 'direct',
    format: (r) => (r.costMissing && !(Number(r.costAmount) > 0) ? 'нет данных' : formatRub(r.costAmount)),
    num: true,
  },
  { key: 'avgCostPerUnit', label: 'СС / шт', group: 'direct', format: (r) => formatRub(r.avgCostPerUnit), num: true },
  {
    key: 'operatingProfit',
    label: 'Опер. прибыль',
    group: 'totals',
    format: (r) => formatRub(r.operatingProfit),
    num: true,
    signed: true,
  },
  {
    key: 'operatingProfitPerUnit',
    label: 'Прибыль / шт',
    group: 'totals',
    format: (r) => formatRub(r.operatingProfitPerUnit),
    num: true,
    signed: true,
  },
  {
    key: 'profitPctBeforeSpp',
    label: '% прибыли от реализ. до СПП',
    group: 'totals',
    format: (r) => formatPct(r.profitPctBeforeSpp),
    num: true,
  },
  {
    key: 'profitPctOnCost',
    label: '% прибыли от СС',
    group: 'totals',
    format: (r) => formatPct(r.profitPctOnCost),
    num: true,
  },
];

const GROUP_LABELS = {
  id: 'Идентификация',
  qty: 'Движение шт',
  before: 'До СПП',
  after: 'После СПП',
  services: 'Услуги МП',
  payout: 'Перечисления',
  direct: 'Прямые расходы',
  totals: 'Итоги',
};

export function UnitEconomics() {
  const initial = useMemo(() => defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD), []);
  const [periodPreset, setPeriodPreset] = useState(DEFAULT_ANALYTICS_PERIOD);
  const [dateFrom, setDateFrom] = useState(initial.dateFrom);
  const [dateTo, setDateTo] = useState(initial.dateTo);
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await unitEconomicsApi.getReport({
        dateFrom,
        dateTo,
        marketplace: tab,
      });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить отчёт');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, tab]);

  useEffect(() => {
    load();
  }, [load]);

  const items = Array.isArray(data?.items) ? data.items : [];
  const summary = data?.summary || null;

  const exportCsv = () => {
    const header = COLUMNS.map((c) => csvEscape(c.label)).join(';');
    const lines = items.map((row) =>
      COLUMNS.map((c) => {
        const raw = c.format ? c.format(row) : row[c.key];
        return csvEscape(raw);
      }).join(';')
    );
    const bom = '\uFEFF';
    const blob = new Blob([bom + [header, ...lines].join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unit_economics_${dateFrom}_${dateTo}_${tab}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const groupRow = useMemo(() => {
    const cells = [];
    let i = 0;
    while (i < COLUMNS.length) {
      const g = COLUMNS[i].group;
      let span = 1;
      while (i + span < COLUMNS.length && COLUMNS[i + span].group === g) span += 1;
      cells.push({ group: g, span, label: GROUP_LABELS[g] || g });
      i += span;
    }
    return cells;
  }, []);

  return (
    <div className="sales-analytics">
      <PageTitle
        title="Юнит-экономика"
        subtitle="Свод по артикулу продавца (MVP как Раск): WB / Ozon, период, прибыль"
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
        <Button variant="secondary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
        <Button variant="secondary" size="small" onClick={exportCsv} disabled={!items.length}>
          Excel (CSV)
        </Button>
      </div>

      <div className="unit-econ__tabs">
        {[
          { id: 'all', label: 'Всего' },
          { id: 'wb', label: 'WB' },
          { id: 'ozon', label: 'Ozon' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            className={`unit-econ__tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {data?.summaryByMarketplace?.[t.id]?.rows != null
              ? ` · ${data.summaryByMarketplace[t.id].rows}`
              : t.id === 'all' && summary?.rows != null
                ? ` · ${summary.rows}`
                : ''}
          </button>
        ))}
      </div>

      {data?.mvpNote ? <p className="unit-econ__hint">{data.mvpNote}</p> : null}
      {error ? <div className="sales-analytics__error">{error}</div> : null}

      {summary ? (
        <div className="unit-econ__cards">
          <div className="unit-econ__card">
            <div className="unit-econ__card-label">Реализ. до СПП</div>
            <div className="unit-econ__card-value">{formatRub(summary.realizedBeforeSpp)}</div>
          </div>
          <div className="unit-econ__card">
            <div className="unit-econ__card-label">К оплате</div>
            <div className="unit-econ__card-value">{formatRub(summary.payoutAmount)}</div>
          </div>
          <div className="unit-econ__card">
            <div className="unit-econ__card-label">Себестоимость</div>
            <div className="unit-econ__card-value">{formatRub(summary.costAmount)}</div>
          </div>
          <div className="unit-econ__card">
            <div className="unit-econ__card-label">Опер. прибыль</div>
            <div className={`unit-econ__card-value${summary.operatingProfit < 0 ? ' unit-econ__neg' : ''}`}>
              {formatRub(summary.operatingProfit)}
            </div>
          </div>
          <div className="unit-econ__card">
            <div className="unit-econ__card-label">% прибыли от реализ.</div>
            <div className="unit-econ__card-value">{formatPct(summary.profitPctBeforeSpp)}</div>
          </div>
        </div>
      ) : null}

      <div className="unit-econ__wrap">
        {loading && !items.length ? (
          <div className="unit-econ__empty">Загрузка…</div>
        ) : !items.length ? (
          <div className="unit-econ__empty">Нет данных за период. Загрузите финотчёты в «Продажи FBO/FBS».</div>
        ) : (
          <table className="unit-econ__table">
            <thead>
              <tr>
                {groupRow.map((g) => (
                  <th key={g.group} className="unit-econ__group" colSpan={g.span}>
                    {g.label}
                  </th>
                ))}
              </tr>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={[
                      c.num ? 'unit-econ__num' : '',
                      c.sticky ? 'unit-econ__sticky' : '',
                      c.sticky2 ? 'unit-econ__sticky-2' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={`${row.marketplace}:${row.sku}`}>
                  {COLUMNS.map((c) => {
                    const text = c.format ? c.format(row) : row[c.key];
                    const neg =
                      c.signed && Number(row[c.key]) < 0
                        ? ' unit-econ__neg'
                        : c.key === 'costAmount' && row.costMissing && !(Number(row.costAmount) > 0)
                          ? ' unit-econ__muted'
                          : '';
                    return (
                      <td
                        key={c.key}
                        className={[
                          c.num ? 'unit-econ__num' : '',
                          c.sticky ? 'unit-econ__sticky' : '',
                          c.sticky2 ? 'unit-econ__sticky-2' : '',
                          neg,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        title={c.key === 'productName' || c.key === 'sku' ? String(text || '') : undefined}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default UnitEconomics;
