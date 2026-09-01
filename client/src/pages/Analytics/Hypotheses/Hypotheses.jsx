/**
 * Гипотезы по товарам: что меняли и как это сказалось на продажах и прибыли.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageTitle } from '../../../components/layout/PageTitle/PageTitle';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { ProductSearchInput } from '../../../components/common/ProductSearchInput/ProductSearchInput';
import { productHypothesesApi } from '../../../services/productHypotheses.api';
import { productCardPath } from '../../../utils/productCardPath';
import { SortableTh, sortRows, useTableSort } from '../shared/tableSort';
import {
  DEFAULT_ANALYTICS_PERIOD,
  defaultAnalyticsRange,
  formatAnalyticsYmd,
  previousPeriodOfSameLength,
} from '../shared/analyticsPeriod';
import '../SalesAnalytics/SalesAnalytics.css';
import './Hypotheses.css';

const MARKETPLACE_OPTIONS = [
  { value: 'all', label: 'Все маркетплейсы' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'wb', label: 'Wildberries' },
  { value: 'ym', label: 'Яндекс Маркет' },
];

const SCHEME_OPTIONS = [
  { value: 'all', label: 'FBO + FBS' },
  { value: 'fbo', label: 'Только FBO' },
  { value: 'fbs', label: 'Только FBS' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'Все статусы' },
  { value: 'active', label: 'Активные' },
  { value: 'completed', label: 'Завершённые' },
];

const SORT_GETTERS = {
  product: (r) => `${r.productSku || ''} ${r.productName || ''}`,
  title: (r) => r.title || '',
  dateFrom: (r) => r.dateFrom || '',
  soldQtyDelta: (r) => Number(r.comparison?.soldQtyDelta) || 0,
  netIncomeDelta: (r) => Number(r.comparison?.netIncomeDelta) || 0,
  status: (r) => r.status || '',
};

function emptyForm() {
  const range = defaultAnalyticsRange(DEFAULT_ANALYTICS_PERIOD);
  return {
    productId: null,
    productName: '',
    productSku: '',
    title: '',
    description: '',
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    marketplace: 'all',
    scheme: 'all',
    status: 'active',
    conclusion: '',
  };
}

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

function marketplaceLabel(v) {
  return MARKETPLACE_OPTIONS.find((o) => o.value === v)?.label || v;
}

function schemeLabel(v) {
  return SCHEME_OPTIONS.find((o) => o.value === v)?.label || v;
}

function formFromItem(item) {
  return {
    productId: item.productId,
    productName: item.productName || '',
    productSku: item.productSku || '',
    title: item.title || '',
    description: item.description || '',
    dateFrom: item.dateFrom,
    dateTo: item.dateTo,
    marketplace: item.marketplace || 'all',
    scheme: item.scheme || 'all',
    status: item.status || 'active',
    conclusion: item.conclusion || '',
  };
}

function DeltaCell({ current, previous, delta, deltaPct, formatValue }) {
  return (
    <td className="sales-analytics__num">
      <div className="hypotheses__metric">
        <span className="hypotheses__metric-now">{formatValue(current)}</span>
        <span className={deltaClass(delta)}>
          {Number(delta) > 0 ? '+' : ''}
          {formatValue(delta)}
          {' · '}
          {formatPct(deltaPct)}
        </span>
        <span className="hypotheses__metric-prev">было {formatValue(previous)}</span>
      </div>
    </td>
  );
}

export function Hypotheses() {
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [productQuery, setProductQuery] = useState('');
  const [formError, setFormError] = useState(null);
  const { sort, toggleSort } = useTableSort('dateFrom', 'desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await productHypothesesApi.list({ status: statusFilter });
      setData(res?.data ?? null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить гипотезы');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const items = useMemo(() => {
    const list = Array.isArray(data?.items) ? data.items : [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter((r) => {
          const hay = [r.title, r.description, r.productName, r.productSku, r.conclusion]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
      : list;
    return sortRows(filtered, sort, SORT_GETTERS);
  }, [data, query, sort]);

  const summary = data?.summary || {};
  const previewPrev = previousPeriodOfSameLength(form.dateFrom, form.dateTo);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setProductQuery('');
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (item) => {
    setEditingId(item.id);
    setForm(formFromItem(item));
    setProductQuery('');
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setFormError(null);
  };

  const patchForm = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSelectProduct = (product) => {
    patchForm({
      productId: product.id,
      productName: product.name || '',
      productSku: product.sku || '',
    });
    setProductQuery('');
  };

  const handleSave = async () => {
    if (!form.productId) {
      setFormError('Выберите товар');
      return;
    }
    if (!String(form.title || '').trim()) {
      setFormError('Опишите гипотезу');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        productId: form.productId,
        title: form.title.trim(),
        description: form.description,
        dateFrom: form.dateFrom,
        dateTo: form.dateTo,
        marketplace: form.marketplace,
        scheme: form.scheme,
        status: form.status,
        conclusion: form.conclusion,
      };
      if (editingId) {
        await productHypothesesApi.update(editingId, payload);
      } else {
        await productHypothesesApi.create(payload);
      }
      setModalOpen(false);
      await load();
    } catch (e) {
      setFormError(e?.response?.data?.message || e?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingId) return;
    if (!window.confirm('Удалить гипотезу? Сравнение пропадёт, восстановить нельзя.')) return;
    setSaving(true);
    setFormError(null);
    try {
      await productHypothesesApi.remove(editingId);
      setModalOpen(false);
      await load();
    } catch (e) {
      setFormError(e?.response?.data?.message || e?.message || 'Не удалось удалить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sales-analytics hypotheses">
      <PageTitle
        iconClass="pe-7s-light"
        iconBgClass="bg-mean-fruit"
        title="Гипотезы"
        subtitle="Что меняли по товару и как это повлияло на штуки и прибыль относительно предыдущего периода той же длины"
        actions={
          <Button variant="primary" size="small" onClick={openCreate}>
            Новая гипотеза
          </Button>
        }
      />

      <div className="sales-analytics__filters erp-filter-bar">
        <label className="sales-analytics__filter">
          <span>Статус</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sales-analytics__filter hypotheses__search">
          <span>Поиск</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Товар, артикул или формулировка"
          />
        </label>
        <Button variant="secondary" size="small" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
      </div>

      {error && <div className="sales-analytics__error">{error}</div>}

      <div className="sales-analytics__cards">
        <div className="sales-analytics__card">
          <div className="sales-analytics__card-label">Всего</div>
          <div className="sales-analytics__card-value">{formatQty(summary.total || 0)}</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--sold">
          <div className="sales-analytics__card-label">Активные</div>
          <div className="sales-analytics__card-value">{formatQty(summary.activeCount || 0)}</div>
        </div>
        <div className="sales-analytics__card">
          <div className="sales-analytics__card-label">Продажи выросли</div>
          <div className="sales-analytics__card-value">{formatQty(summary.withSalesUp || 0)}</div>
          <div className="sales-analytics__card-sub">гипотез со штуками выше прошлого периода</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--net">
          <div className="sales-analytics__card-label">Прибыль выросла</div>
          <div className="sales-analytics__card-value">{formatQty(summary.withProfitUp || 0)}</div>
          <div className="sales-analytics__card-sub">гипотез с прибылью выше прошлого периода</div>
        </div>
      </div>

      <div className="sales-analytics__table-wrap">
        <table className="sales-analytics__table">
          <thead>
            <tr>
              <SortableTh sortKey="product" sort={sort} onSort={toggleSort}>
                Товар
              </SortableTh>
              <SortableTh sortKey="title" sort={sort} onSort={toggleSort}>
                Гипотеза
              </SortableTh>
              <SortableTh sortKey="dateFrom" sort={sort} onSort={toggleSort}>
                Период
              </SortableTh>
              <SortableTh sortKey="soldQtyDelta" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Штуки
              </SortableTh>
              <SortableTh sortKey="netIncomeDelta" sort={sort} onSort={toggleSort} className="sales-analytics__num">
                Прибыль
              </SortableTh>
              <SortableTh sortKey="status" sort={sort} onSort={toggleSort}>
                Статус
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {loading && !data && (
              <tr>
                <td colSpan={6} className="sales-analytics__empty">
                  Загрузка…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="sales-analytics__empty">
                  Пока нет гипотез. Добавьте первую — укажите товар, что меняли и за какие даты сравнивать.
                </td>
              </tr>
            )}
            {items.map((row) => {
              const cmp = row.comparison || {};
              return (
                <tr
                  key={row.id}
                  className="hypotheses__row"
                  onClick={() => openEdit(row)}
                >
                  <td>
                    <Link
                      className="hypotheses__sku"
                      to={productCardPath(row.productId)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {row.productSku || '—'}
                    </Link>
                    <div className="hypotheses__name">{row.productName || '—'}</div>
                  </td>
                  <td>
                    <div className="hypotheses__title">{row.title}</div>
                    {row.description ? (
                      <div className="hypotheses__desc">{row.description}</div>
                    ) : null}
                  </td>
                  <td className="sales-analytics__date">
                    <div>
                      {formatYmdRu(row.dateFrom)} — {formatYmdRu(row.dateTo)}
                    </div>
                    <div className="hypotheses__period-note">
                      vs {formatYmdRu(cmp.previous?.dateFrom)} — {formatYmdRu(cmp.previous?.dateTo)}
                      {cmp.incomplete
                        ? ` · ${cmp.elapsedDays} из ${cmp.plannedDays} дн.`
                        : ''}
                    </div>
                  </td>
                  <DeltaCell
                    current={cmp.current?.soldQty}
                    previous={cmp.previous?.soldQty}
                    delta={cmp.soldQtyDelta}
                    deltaPct={cmp.soldQtyDeltaPct}
                    formatValue={formatQty}
                  />
                  <DeltaCell
                    current={cmp.current?.netIncome}
                    previous={cmp.previous?.netIncome}
                    delta={cmp.netIncomeDelta}
                    deltaPct={cmp.netIncomeDeltaPct}
                    formatValue={formatRub}
                  />
                  <td>
                    <span
                      className={`hypotheses__status hypotheses__status--${row.status}`}
                    >
                      {row.status === 'completed' ? 'Завершена' : 'Активна'}
                    </span>
                    {row.marketplace !== 'all' || row.scheme !== 'all' ? (
                      <div className="hypotheses__period-note">
                        {marketplaceLabel(row.marketplace)}
                        {row.scheme !== 'all' ? ` · ${schemeLabel(row.scheme)}` : ''}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="sales-analytics__hint">
        Сравнение идёт с предыдущим отрезком той же длины. Если период гипотезы ещё не закончился,
        берём уже прошедшие дни и столько же дней до старта. Цифры — из отчётов FBO/FBS.
      </p>

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editingId ? 'Гипотеза' : 'Новая гипотеза'}
        size="large"
        scrollable
      >
        <div className="hypotheses-form">
          {formError ? <div className="sales-analytics__error">{formError}</div> : null}

          <label className="hypotheses-form__field">
            <span>Товар</span>
            {form.productId ? (
              <div className="hypotheses-form__picked">
                <div>
                  <b>{form.productSku || '—'}</b>
                  <div>{form.productName || 'Без названия'}</div>
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() =>
                    patchForm({ productId: null, productName: '', productSku: '' })
                  }
                >
                  Сменить
                </Button>
              </div>
            ) : (
              <ProductSearchInput
                value={productQuery}
                onChange={setProductQuery}
                onSelect={handleSelectProduct}
                placeholder="Артикул или название"
                className="hypotheses-form__search-input"
                autoFocus
              />
            )}
          </label>

          <label className="hypotheses-form__field">
            <span>Гипотеза</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => patchForm({ title: e.target.value })}
              placeholder="Например: заменили главное фото и добавили видео"
              maxLength={500}
            />
          </label>

          <label className="hypotheses-form__field">
            <span>Что сделали</span>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => patchForm({ description: e.target.value })}
              placeholder="Кратко: какие изменения внесли в карточку, цену, поставку"
            />
          </label>

          <div className="hypotheses-form__row">
            <label className="hypotheses-form__field">
              <span>С</span>
              <input
                type="date"
                value={form.dateFrom}
                max={form.dateTo || undefined}
                onChange={(e) => patchForm({ dateFrom: e.target.value })}
              />
            </label>
            <label className="hypotheses-form__field">
              <span>По</span>
              <input
                type="date"
                value={form.dateTo}
                min={form.dateFrom || undefined}
                onChange={(e) => patchForm({ dateTo: e.target.value })}
              />
            </label>
          </div>
          <p className="hypotheses-form__hint">
            Предыдущий период для сравнения:{' '}
            {formatYmdRu(previewPrev.dateFrom)} — {formatYmdRu(previewPrev.dateTo)}. Сегодня{' '}
            {formatYmdRu(formatAnalyticsYmd(new Date()))}
            {form.dateTo > formatAnalyticsYmd(new Date())
              ? ' — пока сравним только прошедшие дни.'
              : '.'}
          </p>

          <div className="hypotheses-form__row">
            <label className="hypotheses-form__field">
              <span>Маркетплейс</span>
              <select
                value={form.marketplace}
                onChange={(e) => patchForm({ marketplace: e.target.value })}
              >
                {MARKETPLACE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="hypotheses-form__field">
              <span>Схема</span>
              <select
                value={form.scheme}
                onChange={(e) => patchForm({ scheme: e.target.value })}
              >
                {SCHEME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="hypotheses-form__field">
              <span>Статус</span>
              <select
                value={form.status}
                onChange={(e) => patchForm({ status: e.target.value })}
              >
                <option value="active">Активна</option>
                <option value="completed">Завершена</option>
              </select>
            </label>
          </div>

          <label className="hypotheses-form__field">
            <span>Вывод</span>
            <textarea
              rows={2}
              value={form.conclusion}
              onChange={(e) => patchForm({ conclusion: e.target.value })}
              placeholder="Сработало / не сработало и почему — по желанию"
            />
          </label>

          <div className="hypotheses-form__actions">
            {editingId ? (
              <Button variant="danger" size="small" onClick={handleDelete} disabled={saving}>
                Удалить
              </Button>
            ) : (
              <span />
            )}
            <div className="hypotheses-form__actions-right">
              <Button variant="secondary" size="small" onClick={closeModal} disabled={saving}>
                Отмена
              </Button>
              <Button variant="primary" size="small" onClick={handleSave} disabled={saving}>
                {saving ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
