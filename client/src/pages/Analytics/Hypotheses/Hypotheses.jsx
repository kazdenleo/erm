/**
 * Гипотезы по товарам: N дней до старта vs N дней действия, затем вывод.
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
  formatAnalyticsYmd,
  periodLengthDays,
  previousPeriodOfSameLength,
  rangeFromStartDays,
} from '../shared/analyticsPeriod';
import { HypothesesComparePanel } from './HypothesesComparePanel';
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

const DURATION_PRESETS = [
  { value: 7, label: '7 дней' },
  { value: 14, label: '14 дней' },
  { value: 28, label: '28 дней' },
  { value: 'custom', label: 'Свои даты' },
];

const SORT_GETTERS = {
  product: (r) => `${r.productSku || ''} ${r.productName || ''}`,
  title: (r) => r.title || '',
  dateFrom: (r) => r.dateFrom || '',
  soldQtyDelta: (r) => Number(r.comparison?.soldQtyDelta) || 0,
  netIncomeDelta: (r) => Number(r.comparison?.netIncomeDelta) || 0,
  status: (r) => {
    if (r.status === 'completed') return 2;
    if (r.comparison?.readyForConclusion && !r.conclusion) return 0;
    return 1;
  },
};

function detectDurationPreset(dateFrom, dateTo) {
  const len = periodLengthDays(dateFrom, dateTo);
  if (len === 7 || len === 14 || len === 28) return len;
  return 'custom';
}

function emptyForm() {
  const today = formatAnalyticsYmd(new Date());
  const range = rangeFromStartDays(today, 7);
  return {
    productId: null,
    productName: '',
    productSku: '',
    title: '',
    description: '',
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    durationPreset: 7,
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

function needsConclusion(item) {
  return item?.status === 'active' && item?.comparison?.readyForConclusion && !item?.conclusion;
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
    durationPreset: detectDurationPreset(item.dateFrom, item.dateTo),
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
        <span className="hypotheses__metric-prev">до старта {formatValue(previous)}</span>
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
  const [openedItem, setOpenedItem] = useState(null);
  const { sort, toggleSort } = useTableSort('status', 'asc');

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

  useEffect(() => {
    if (!editingId) {
      setOpenedItem(null);
      return;
    }
    const found = (data?.items || []).find((i) => Number(i.id) === Number(editingId));
    if (found) setOpenedItem(found);
  }, [data, editingId]);

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
  const today = formatAnalyticsYmd(new Date());
  const previewPrev = previousPeriodOfSameLength(form.dateFrom, form.dateTo);
  const plannedDays = periodLengthDays(form.dateFrom, form.dateTo);
  const formIncomplete = form.dateTo > today;

  const openCreate = () => {
    setEditingId(null);
    setOpenedItem(null);
    setForm(emptyForm());
    setProductQuery('');
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (item) => {
    setEditingId(item.id);
    setOpenedItem(item);
    setForm(formFromItem(item));
    setProductQuery('');
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setOpenedItem(null);
    setFormError(null);
  };

  const patchForm = (patch) => setForm((prev) => ({ ...prev, ...patch }));

  const setDurationPreset = (preset) => {
    if (preset === 'custom') {
      patchForm({ durationPreset: 'custom' });
      return;
    }
    const days = Number(preset);
    const range = rangeFromStartDays(form.dateFrom || today, days);
    patchForm({ durationPreset: days, dateFrom: range.dateFrom, dateTo: range.dateTo });
  };

  const setStartDate = (dateFrom) => {
    if (form.durationPreset === 'custom') {
      const dateTo = form.dateTo && form.dateTo < dateFrom ? dateFrom : form.dateTo;
      patchForm({ dateFrom, dateTo, durationPreset: detectDurationPreset(dateFrom, dateTo) });
      return;
    }
    const range = rangeFromStartDays(dateFrom, Number(form.durationPreset) || 7);
    patchForm({ dateFrom: range.dateFrom, dateTo: range.dateTo });
  };

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
        durationDays: plannedDays,
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
        subtitle="Старт сегодня — сравниваем те же N дней до изменений с N днями действия. Когда срок выйдет, записываем вывод"
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
        <div className="sales-analytics__card hypotheses__card--await">
          <div className="sales-analytics__card-label">Нужен вывод</div>
          <div className="sales-analytics__card-value">{formatQty(summary.awaitingConclusion || 0)}</div>
          <div className="sales-analytics__card-sub">срок действия уже прошёл</div>
        </div>
        <div className="sales-analytics__card sales-analytics__card--net">
          <div className="sales-analytics__card-label">Прибыль выросла</div>
          <div className="sales-analytics__card-value">{formatQty(summary.withProfitUp || 0)}</div>
          <div className="sales-analytics__card-sub">по прошедшим дням действия vs до старта</div>
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
                До старта → действие
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
                  Пока нет гипотез. Создайте: товар, что меняете, старт и срок (например 7 дней вперёд).
                </td>
              </tr>
            )}
            {items.map((row) => {
              const cmp = row.comparison || {};
              const actionFrom = cmp.action?.dateFrom || row.dateFrom;
              const actionTo = cmp.action?.dateTo || row.dateTo;
              const prevFrom = cmp.previousFull?.dateFrom || cmp.previous?.dateFrom;
              const prevTo = cmp.previousFull?.dateTo || cmp.previous?.dateTo;
              const awaiting = needsConclusion(row);
              return (
                <tr
                  key={row.id}
                  className={`hypotheses__row${awaiting ? ' hypotheses__row--await' : ''}`}
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
                    {row.conclusion ? (
                      <div className="hypotheses__conclusion-preview">{row.conclusion}</div>
                    ) : null}
                  </td>
                  <td className="sales-analytics__date">
                    <div>
                      {formatYmdRu(prevFrom)} — {formatYmdRu(prevTo)}
                    </div>
                    <div>
                      → {formatYmdRu(actionFrom)} — {formatYmdRu(actionTo)}
                    </div>
                    <div className="hypotheses__period-note">
                      {cmp.incomplete
                        ? `сравниваем ${cmp.elapsedDays} из ${cmp.plannedDays} дн. действия`
                        : `${cmp.plannedDays} дн. vs ${cmp.plannedDays} дн.`}
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
                    {row.status === 'completed' ? (
                      <span className="hypotheses__status hypotheses__status--completed">Завершена</span>
                    ) : awaiting ? (
                      <span className="hypotheses__status hypotheses__status--await">Нужен вывод</span>
                    ) : (
                      <span className="hypotheses__status hypotheses__status--active">Идёт</span>
                    )}
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
        Если сегодня старт на 7 дней — сравниваем предыдущие 7 дней с этими семью. Пока срок не вышел,
        цифры считаются по уже прошедшим дням действия и такому же числу дней до старта. Полный вывод —
        после окончания периода.
      </p>

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editingId ? 'Гипотеза' : 'Новая гипотеза'}
        size={editingId ? 'xl' : 'large'}
        scrollable
      >
        <div className="hypotheses-form">
          {formError ? <div className="sales-analytics__error">{formError}</div> : null}
          {editingId && openedItem?.comparison ? (
            <HypothesesComparePanel comparison={openedItem.comparison} />
          ) : null}

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

          <div className="hypotheses-form__field">
            <span>Срок действия</span>
            <div className="hypotheses-form__presets" role="group" aria-label="Срок действия">
              {DURATION_PRESETS.map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  className={`hypotheses-form__preset${form.durationPreset === opt.value ? ' is-active' : ''}`}
                  onClick={() => setDurationPreset(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="hypotheses-form__row">
            <label className="hypotheses-form__field">
              <span>Старт действия</span>
              <input
                type="date"
                value={form.dateFrom}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            {form.durationPreset === 'custom' ? (
              <label className="hypotheses-form__field">
                <span>Конец действия</span>
                <input
                  type="date"
                  value={form.dateTo}
                  min={form.dateFrom || undefined}
                  onChange={(e) => {
                    const dateTo = e.target.value;
                    patchForm({
                      dateTo,
                      durationPreset: detectDurationPreset(form.dateFrom, dateTo),
                    });
                  }}
                />
              </label>
            ) : (
              <label className="hypotheses-form__field">
                <span>Конец действия</span>
                <input type="date" value={form.dateTo} readOnly />
              </label>
            )}
          </div>

          <div className="hypotheses-form__windows">
            <div>
              <b>До старта</b>
              <div>
                {formatYmdRu(previewPrev.dateFrom)} — {formatYmdRu(previewPrev.dateTo)}
              </div>
              <span>{plannedDays} дн. до изменений</span>
            </div>
            <div>
              <b>Действие гипотезы</b>
              <div>
                {formatYmdRu(form.dateFrom)} — {formatYmdRu(form.dateTo)}
              </div>
              <span>
                {formIncomplete
                  ? `ещё идёт, полный вывод после ${formatYmdRu(form.dateTo)}`
                  : 'срок вышел — можно записать вывод'}
              </span>
            </div>
          </div>

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
                <option value="active">Идёт</option>
                <option value="completed">Завершена</option>
              </select>
            </label>
          </div>

          <label className="hypotheses-form__field">
            <span>Вывод{formIncomplete ? ' (после окончания срока)' : ''}</span>
            <textarea
              rows={2}
              value={form.conclusion}
              onChange={(e) => patchForm({ conclusion: e.target.value })}
              placeholder={
                formIncomplete
                  ? `Заполните после ${formatYmdRu(form.dateTo)}, когда наберётся полный период действия`
                  : 'Сработало / не сработало и почему'
              }
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
