/**
 * Виджет «Взаиморасчёты с поставщиками»: общий долг, переплаты и поставщики с ненулевым балансом.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { suppliersApi } from '../../../services/suppliers.api';
import { describeBalance, formatSignedBalance } from '../../Suppliers/settlementFormat';
import { KpiCard } from './AnalyticsWidgets';
import { errorMessage, formatQty, formatRubShort } from './widgetUtils';

export const SETTLEMENT_FILTERS = [
  { value: 'all', label: 'Долги и переплаты' },
  { value: 'debt', label: 'Только наши долги' },
];

const LIST_LIMITS = [5, 10, 20];

export function SupplierSettlementsWidget({ settings }) {
  const filter = settings?.filter === 'debt' ? 'debt' : 'all';
  const limit = LIST_LIMITS.includes(Number(settings?.limit)) ? Number(settings.limit) : 5;
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    suppliersApi
      .getSettlementBalances()
      .then((data) => setRows(data))
      .catch((e) => {
        setError(errorMessage(e, 'Не удалось загрузить взаиморасчёты'));
        setRows(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const withBalance = (rows || [])
    .map((r) => ({ ...r, view: describeBalance(r.balance) }))
    .filter((r) => r.view.tone !== 'neutral');
  const debts = withBalance.filter((r) => r.view.tone === 'debt');
  const credits = withBalance.filter((r) => r.view.tone === 'credit');
  const debtTotal = debts.reduce((s, r) => s + r.view.amount, 0);
  const creditTotal = credits.reduce((s, r) => s + r.view.amount, 0);

  const byAmount = (a, b) => b.view.amount - a.view.amount;
  const candidates = filter === 'debt' ? [...debts].sort(byAmount) : [...debts.sort(byAmount), ...credits.sort(byAmount)];
  const list = candidates.slice(0, limit);

  return (
    <KpiCard
      icon="pe-7s-cash"
      title="Взаиморасчёты с поставщиками"
      to="/suppliers"
      loading={loading}
      error={error}
      onReload={load}
      metrics={[
        { label: `Наш долг (${formatQty(debts.length)})`, value: formatRubShort(debtTotal), tone: debtTotal > 0 ? 'bad' : undefined },
        { label: `Переплата (${formatQty(credits.length)})`, value: formatRubShort(creditTotal), tone: creditTotal > 0 ? 'good' : undefined },
        { label: 'Сальдо', value: formatRubShort(creditTotal - debtTotal), tone: creditTotal - debtTotal < 0 ? 'bad' : undefined },
      ]}
    >
      {list.length === 0 ? (
        <div className="text-muted small mt-3">
          {filter === 'debt' ? 'Долгов перед поставщиками нет.' : 'Расчёты со всеми поставщиками закрыты.'}
        </div>
      ) : (
        <div className="home-kpi-top">
          <div className="home-kpi-top__title">{filter === 'debt' ? 'Кому должны больше всего' : 'Поставщики с открытым балансом'}</div>
          {list.map((r) => (
            <div key={r.supplierId} className="home-kpi-top__row">
              <Link
                to={`/suppliers/${r.supplierId}/settlements`}
                className="home-kpi-top__name"
                title={`${r.supplierName}: ${r.view.label.toLowerCase()} — открыть взаиморасчёты`}
              >
                {r.supplierName}
                {!r.isActive && <span className="text-muted"> (неактивен)</span>}
              </Link>
              <span className={`home-kpi-top__val home-kpi__value--${r.view.tone === 'debt' ? 'bad' : 'good'}`}>
                {formatSignedBalance(r.balance)}
              </span>
            </div>
          ))}
          {candidates.length > list.length && (
            <Link to="/suppliers" className="small">
              Ещё {formatQty(candidates.length - list.length)} →
            </Link>
          )}
        </div>
      )}
    </KpiCard>
  );
}

export function SupplierSettlementsSettings({ settings, onChange }) {
  return (
    <div className="d-flex flex-wrap gap-2">
      <select
        className="form-select form-select-sm w-auto"
        value={settings?.filter === 'debt' ? 'debt' : 'all'}
        onChange={(e) => onChange({ ...settings, filter: e.target.value })}
        aria-label="Что показывать"
      >
        {SETTLEMENT_FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="form-select form-select-sm w-auto"
        value={LIST_LIMITS.includes(Number(settings?.limit)) ? Number(settings.limit) : 5}
        onChange={(e) => onChange({ ...settings, limit: Number(e.target.value) })}
        aria-label="Сколько поставщиков в списке"
      >
        {LIST_LIMITS.map((n) => (
          <option key={n} value={n}>
            {`Список: ${n}`}
          </option>
        ))}
      </select>
    </div>
  );
}
