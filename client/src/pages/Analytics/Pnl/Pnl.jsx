/**
 * ОПиУ по компании: выручка → расходы маркетплейса → себестоимость → постоянные расходы → налог → чистая прибыль.
 * Разрез по месяцам, маркетплейсам и организациям + справочник постоянных расходов.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { salesAnalyticsApi } from '../../../services/salesAnalytics.api';
import {
  MARKETPLACE_OPTIONS,
  SCHEME_OPTIONS,
  SelectFilter,
  SummaryCards,
  ToggleGroup,
  errorMessage,
  formatDateRu,
  formatPercent,
  formatRub,
  marketplaceLabel,
} from '../shared/analyticsKit';
import '../SalesAnalytics/SalesAnalytics.css';
import '../ProductDynamics/ProductDynamics.css';

const MONTH_NAMES = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function monthLabel(ym) {
  const [y, m] = String(ym || '').split('-');
  const idx = Number(m) - 1;
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

function ymShift(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Строки отчёта: sign — как показывать (расходы со знаком минус). */
const ROWS = [
  { key: 'soldAmount', label: 'Продажи' },
  { key: 'returnedAmount', label: 'Возвраты', sign: -1, muted: true },
  { key: 'revenue', label: 'Выручка', bold: true },
  { key: 'commission', label: 'Комиссия МП', sign: -1 },
  { key: 'logistics', label: 'Логистика', sign: -1 },
  { key: 'storage', label: 'Хранение', sign: -1 },
  { key: 'penalty', label: 'Штрафы', sign: -1 },
  { key: 'acquiring', label: 'Эквайринг', sign: -1 },
  { key: 'other', label: 'Прочие удержания МП', sign: -1 },
  { key: 'mpAdjustments', label: 'Корректировки и компенсации МП', sign: -1 },
  { key: 'mpTake', label: 'Итого расходы МП', sign: -1, muted: true },
  { key: 'netTransfer', label: 'К перечислению от МП', muted: true },
  { key: 'cost', label: 'Себестоимость', sign: -1 },
  { key: 'additional', label: 'Доп. расходы по товарам', sign: -1 },
  { key: 'grossProfit', label: 'Валовая прибыль', bold: true },
  { key: '__fixed__', label: 'Постоянные расходы' },
  { key: 'fixedTotal', label: 'Итого постоянные', sign: -1, muted: true },
  { key: 'operatingProfit', label: 'Операционная прибыль', bold: true },
  { key: 'tax', label: 'Налог', sign: -1 },
  { key: 'netProfit', label: 'Чистая прибыль', bold: true, total: true },
  { key: 'marginPercent', label: 'Рентабельность', percent: true },
];

const DIMENSIONS = [
  { value: 'month', label: 'По месяцам' },
  { value: 'marketplace', label: 'По маркетплейсам' },
  { value: 'organization', label: 'По организациям' },
];

export function Pnl() {
  const [monthTo, setMonthTo] = useState(currentYm());
  const [monthFrom, setMonthFrom] = useState(ymShift(currentYm(), -5));
  const [marketplace, setMarketplace] = useState('all');
  const [organizationId, setOrganizationId] = useState('');
  const [scheme, setScheme] = useState('all');
  const [dimension, setDimension] = useState('month');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [showExpenses, setShowExpenses] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await salesAnalyticsApi.getPnl({ monthFrom, monthTo, marketplace, organizationId, scheme });
      setData(res?.data ?? null);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось построить ОПиУ'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [monthFrom, monthTo, marketplace, organizationId, scheme]);

  useEffect(() => {
    load();
  }, [load]);

  const total = data?.total || null;
  const columns = useMemo(() => {
    if (!data) return [];
    if (dimension === 'marketplace')
      return (data.byMarketplace || []).map((c) => ({ ...c, label: c.label || marketplaceLabel(c.key) }));
    if (dimension === 'organization') return data.byOrganization || [];
    return (data.byMonth || []).map((c) => ({ ...c, label: monthLabel(c.key) }));
  }, [data, dimension]);

  const fixedCategories = Array.isArray(data?.expenseCategories) ? data.expenseCategories : [];
  const organizations = Array.isArray(data?.organizations) ? data.organizations : [];

  const chartData = useMemo(
    () =>
      (data?.byMonth || []).map((c) => ({
        label: monthLabel(c.key),
        revenue: c.revenue,
        netProfit: c.netProfit,
        marginPercent: c.marginPercent,
      })),
    [data]
  );

  const renderCell = (col, row) => {
    const raw = Number(col?.[row.key]);
    if (!Number.isFinite(raw)) return '—';
    if (row.percent) return formatPercent(raw);
    const v = row.sign === -1 ? -raw : raw;
    const cls = row.bold && v < 0 ? 'analytics-kit__neg' : '';
    return <span className={cls}>{formatRub(v)}</span>;
  };

  return (
    <div className="sales-analytics">
      <PageTitle
        iconClass="pe-7s-graph1"
        iconBgClass="bg-grow-early"
        title="ОПиУ"
        subtitle="Отчёт о прибылях и убытках компании: маркетплейсы, себестоимость, постоянные расходы и налог"
      />

      <div className="sales-analytics__filters erp-filter-bar">
        <label className="sales-analytics__filter">
          <span>С месяца</span>
          <input type="month" value={monthFrom} max={monthTo} onChange={(e) => setMonthFrom(e.target.value)} />
        </label>
        <label className="sales-analytics__filter">
          <span>По месяц</span>
          <input type="month" value={monthTo} min={monthFrom} onChange={(e) => setMonthTo(e.target.value)} />
        </label>
        <SelectFilter label="Маркетплейс" value={marketplace} onChange={setMarketplace} options={MARKETPLACE_OPTIONS} />
        <SelectFilter label="Схема" value={scheme} onChange={setScheme} options={SCHEME_OPTIONS} />
        {organizations.length > 1 || organizationId ? (
          <SelectFilter
            label="Организация"
            value={organizationId}
            onChange={setOrganizationId}
            options={[{ value: '', label: 'Все' }, ...organizations.map((o) => ({ value: String(o.id), label: o.name }))]}
          />
        ) : null}
        <Button variant="primary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Расчёт…' : 'Обновить'}
        </Button>
        <Button variant="secondary" size="small" onClick={() => setShowExpenses((v) => !v)}>
          {showExpenses ? 'Скрыть расходы' : 'Постоянные расходы'}
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      {showExpenses && (
        <ExpensesEditor organizations={organizations} onChanged={load} />
      )}

      {total && (
        <SummaryCards
          cards={[
            { label: 'Выручка', value: formatRub(total.revenue), sub: `возвраты ${formatRub(total.returnedAmount)}` },
            {
              label: 'Расходы МП',
              value: formatRub(total.mpTake),
              sub: total.revenue ? `${formatPercent((total.mpTake / total.revenue) * 100)} выручки` : null,
            },
            { label: 'Валовая прибыль', value: formatRub(total.grossProfit) },
            { label: 'Постоянные расходы', value: formatRub(total.fixedTotal) },
            {
              label: 'Чистая прибыль',
              value: formatRub(total.netProfit),
              tone: total.netProfit < 0 ? 'danger' : 'success',
              sub: `рентабельность ${formatPercent(total.marginPercent)} · налог ${formatRub(total.tax)}`,
            },
          ]}
        />
      )}

      {chartData.length > 1 && (
        <div className="product-dynamics__chart-wrap" style={{ minHeight: 0 }}>
          <h3 className="product-dynamics__chart-title">Выручка и чистая прибыль по месяцам</h3>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis yAxisId="rub" tick={{ fontSize: 12 }} tickFormatter={(v) => `${Math.round(v / 1000)}к`} />
              <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 12 }} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                formatter={(v, name) => [name === 'Рентабельность' ? formatPercent(v) : formatRub(v), name]}
              />
              <Legend />
              <Bar yAxisId="rub" dataKey="revenue" name="Выручка" fill="#93c5fd" />
              <Bar yAxisId="rub" dataKey="netProfit" name="Чистая прибыль" fill="#16a34a" />
              <Line yAxisId="pct" type="monotone" dataKey="marginPercent" name="Рентабельность" stroke="#ea580c" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="product-dynamics__controls-row">
        <ToggleGroup label="Разрез" value={dimension} onChange={setDimension} options={DIMENSIONS} disabled={!data} />
      </div>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <th>Статья</th>
              {columns.map((c) => (
                <th key={c.key} className="sales-analytics__num">
                  {c.label}
                </th>
              ))}
              {columns.length > 1 ? <th className="sales-analytics__num">Итого</th> : null}
            </tr>
          </thead>
          <tbody>
            {!loading && data != null && columns.length === 0 && (
              <tr>
                <td colSpan={2} className="sales-analytics__empty">
                  Нет данных за период
                </td>
              </tr>
            )}
            {columns.length > 0 &&
              ROWS.flatMap((row) => {
                if (row.key === '__fixed__') {
                  return fixedCategories.map((cat) => (
                    <tr key={`fixed-${cat}`}>
                      <td style={{ paddingLeft: 20 }}>{cat}</td>
                      {columns.map((c) => (
                        <td key={c.key} className="sales-analytics__num">
                          {formatRub(-(Number(c.fixedByCategory?.[cat]) || 0))}
                        </td>
                      ))}
                      {columns.length > 1 ? (
                        <td className="sales-analytics__num">
                          {formatRub(-(Number(total?.fixedByCategory?.[cat]) || 0))}
                        </td>
                      ) : null}
                    </tr>
                  ));
                }
                const cls = row.total
                  ? 'analytics-kit__row--total'
                  : row.bold
                    ? 'analytics-kit__row--section'
                    : row.muted
                      ? 'analytics-kit__row--muted'
                      : '';
                return [
                  <tr key={row.key} className={cls}>
                    <td>{row.label}</td>
                    {columns.map((c) => (
                      <td key={c.key} className="sales-analytics__num">
                        {renderCell(c, row)}
                      </td>
                    ))}
                    {columns.length > 1 ? <td className="sales-analytics__num">{renderCell(total, row)}</td> : null}
                  </tr>,
                ];
              })}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Выручка и расходы маркетплейсов — из финансовых отчётов (возвраты уменьшают выручку и комиссию). Себестоимость —
        по карточкам товаров. Постоянные расходы без привязки к маркетплейсу или организации распределяются пропорционально
        выручке месяца. Налог считается по ставкам организации с учётом постоянных расходов.
      </p>
    </div>
  );
}

const EMPTY_FORM = {
  category: '',
  description: '',
  amount: '',
  recurrence: 'monthly',
  startDate: `${currentYm()}-01`,
  endDate: '',
  marketplace: '',
  organizationId: '',
};

function ExpensesEditor({ organizations, onChanged }) {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const loadList = useCallback(async () => {
    try {
      const res = await salesAnalyticsApi.listExpenses();
      setItems(res?.data?.items || []);
      setCategories(res?.data?.categories || []);
    } catch (e) {
      setError(errorMessage(e, 'Не удалось загрузить расходы'));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      ...form,
      amount: Number(String(form.amount).replace(',', '.')),
      endDate: form.recurrence === 'monthly' ? form.endDate || null : null,
      marketplace: form.marketplace || null,
      organizationId: form.organizationId ? Number(form.organizationId) : null,
    };
    try {
      if (editingId) await salesAnalyticsApi.updateExpense(editingId, body);
      else await salesAnalyticsApi.createExpense(body);
      setForm(EMPTY_FORM);
      setEditingId(null);
      await loadList();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err, 'Не удалось сохранить расход'));
    } finally {
      setSaving(false);
    }
  };

  const edit = (it) => {
    setEditingId(it.id);
    setForm({
      category: it.category,
      description: it.description || '',
      amount: String(it.amount),
      recurrence: it.recurrence,
      startDate: it.startDate,
      endDate: it.endDate || '',
      marketplace: it.marketplace || '',
      organizationId: it.organizationId ? String(it.organizationId) : '',
    });
  };

  const remove = async (it) => {
    if (!window.confirm(`Удалить расход «${it.category}${it.description ? `: ${it.description}` : ''}»?`)) return;
    try {
      await salesAnalyticsApi.deleteExpense(it.id);
      await loadList();
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err, 'Не удалось удалить расход'));
    }
  };

  return (
    <div className="analytics-kit__section analytics-kit__panel">
      <h3 className="analytics-kit__section-title">Постоянные расходы</h3>
      {error && <div className="sales-analytics__error">{error}</div>}

      <form className="analytics-kit__form" onSubmit={submit}>
        <label className="sales-analytics__filter">
          <span>Категория</span>
          <input
            type="text"
            list="pnl-expense-categories"
            value={form.category}
            onChange={(e) => setField('category', e.target.value)}
            placeholder="Аренда, Зарплата…"
            required
          />
          <datalist id="pnl-expense-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="sales-analytics__filter">
          <span>Описание</span>
          <input type="text" value={form.description} onChange={(e) => setField('description', e.target.value)} />
        </label>
        <label className="sales-analytics__filter">
          <span>Сумма, ₽</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => setField('amount', e.target.value)}
            style={{ width: 110 }}
            required
          />
        </label>
        <SelectFilter
          label="Периодичность"
          value={form.recurrence}
          onChange={(v) => setField('recurrence', v)}
          options={[
            { value: 'monthly', label: 'Каждый месяц' },
            { value: 'once', label: 'Разово' },
          ]}
        />
        <label className="sales-analytics__filter">
          <span>{form.recurrence === 'monthly' ? 'С даты' : 'Дата'}</span>
          <input type="date" value={form.startDate} onChange={(e) => setField('startDate', e.target.value)} required />
        </label>
        {form.recurrence === 'monthly' ? (
          <label className="sales-analytics__filter">
            <span>По дату</span>
            <input type="date" value={form.endDate} onChange={(e) => setField('endDate', e.target.value)} />
          </label>
        ) : null}
        <SelectFilter
          label="Маркетплейс"
          value={form.marketplace}
          onChange={(v) => setField('marketplace', v)}
          options={[{ value: '', label: 'Общий' }, ...MARKETPLACE_OPTIONS.filter((o) => o.value !== 'all')]}
        />
        {organizations.length > 1 ? (
          <SelectFilter
            label="Организация"
            value={form.organizationId}
            onChange={(v) => setField('organizationId', v)}
            options={[{ value: '', label: 'Общий' }, ...organizations.map((o) => ({ value: String(o.id), label: o.name }))]}
          />
        ) : null}
        <Button type="submit" variant="primary" size="small" disabled={saving}>
          {editingId ? 'Сохранить' : 'Добавить'}
        </Button>
        {editingId ? (
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => {
              setEditingId(null);
              setForm(EMPTY_FORM);
            }}
          >
            Отмена
          </Button>
        ) : null}
      </form>

      <div className="sales-analytics__table-wrap" style={{ marginTop: 12 }}>
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <th>Категория</th>
              <th>Описание</th>
              <th className="sales-analytics__num">Сумма</th>
              <th>Период</th>
              <th>Маркетплейс</th>
              <th>Организация</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="sales-analytics__empty">
                  Расходов пока нет. Добавьте аренду, зарплаты, подписки — они попадут в ОПиУ.
                </td>
              </tr>
            )}
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.category}</td>
                <td>{it.description || '—'}</td>
                <td className="sales-analytics__num">
                  {formatRub(it.amount)}
                  {it.recurrence === 'monthly' ? '/мес' : ''}
                </td>
                <td>
                  {it.recurrence === 'monthly'
                    ? `с ${formatDateRu(it.startDate)}${it.endDate ? ` по ${formatDateRu(it.endDate)}` : ''}`
                    : formatDateRu(it.startDate)}
                </td>
                <td>{it.marketplace ? marketplaceLabel(it.marketplace) : 'Общий'}</td>
                <td>{it.organizationName || 'Общий'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="analytics-kit__link-btn" onClick={() => edit(it)}>
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="analytics-kit__link-btn analytics-kit__link-btn--danger"
                    onClick={() => remove(it)}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
