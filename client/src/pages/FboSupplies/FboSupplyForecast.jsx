/**
 * Прогнозирование поставок FBO — остатки WB по кластерам (регионам отгрузки)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { FboSuppliesSubNav } from './FboSuppliesSubNav.jsx';
import './FboSupplies.css';
import './FboSuppliesSubNav.css';

const CLUSTER_METRIC_COLS = [
  { key: 'availability', label: 'Наличие', title: 'Остаток на складах кластера (текущий снимок WB)' },
  { key: 'orders', label: 'Заказы', title: 'Заказано за выбранный период загрузки' },
  {
    key: 'avgOrdersPerDay',
    label: 'В ср./день',
    title: 'В среднем заказов в день за период загрузки',
    format: 'avg',
  },
  { key: 'reserve', label: 'Резерв', title: 'В пути к клиенту (текущий снимок WB)' },
  { key: 'return', label: 'Возврат', title: 'В пути от клиента (текущий снимок WB)' },
  { key: 'toSupply', label: 'К поставке', title: 'Рекомендуемое количество к поставке в кластер' },
];

const PLAN_DAYS_OPTIONS = [30, 60, 90];
const PLAN_DAYS_LS = 'fbo_forecast_plan_days';
const ORDERS_PERIOD_LS = 'fbo_forecast_orders_period';
const ZERO_STOCK_BOOST_LS = 'fbo_forecast_zero_stock_boost';

const ORDERS_PRESETS = [
  { id: 'week', label: '1 неделя', days: 7 },
  { id: 'month', label: '1 месяц', days: 30 },
  { id: 'quarter', label: '1 квартал', days: 90 },
  { id: 'custom', label: 'Свои даты', days: null },
];

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetRange(mode) {
  const end = new Date();
  const start = new Date(end);
  const preset = ORDERS_PRESETS.find((p) => p.id === mode);
  const span = preset?.days ?? 30;
  start.setDate(start.getDate() - (span - 1));
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

function readOrdersPeriod() {
  const fallback = { mode: 'month', start: presetRange('month').start, end: presetRange('month').end };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(ORDERS_PERIOD_LS);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const mode = ORDERS_PRESETS.some((p) => p.id === parsed?.mode) ? parsed.mode : 'month';
    if (mode === 'custom' && parsed?.start && parsed?.end) {
      return { mode, start: parsed.start, end: parsed.end };
    }
    const range = presetRange(mode);
    return { mode, start: range.start, end: range.end };
  } catch {
    return fallback;
  }
}

function ordersPeriodToApi(period) {
  if (!period) return {};
  if (period.mode === 'custom' && period.start && period.end) {
    return { ordersStart: period.start, ordersEnd: period.end };
  }
  const range = presetRange(period.mode || 'month');
  return { ordersStart: range.start, ordersEnd: range.end };
}

function readPlanDays() {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PLAN_DAYS_LS) : null;
  const n = Number(raw);
  return PLAN_DAYS_OPTIONS.includes(n) ? n : 30;
}

function readZeroStockBoost() {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ZERO_STOCK_BOOST_LS) : null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(200, Math.max(0, Math.round(n)));
}

function fmtDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtIsoRu(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
}

function fmtQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('ru-RU');
}

function fmtCellValue(col, value) {
  if (col.format === 'avg') {
    const v = Number(value);
    if (!Number.isFinite(v)) return '0';
    return v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  return fmtQty(value);
}

function displaySku(row) {
  return row.productArticle || row.wbVendorCode || row.externalSku || '—';
}

function rowHasSupplyInAnyCluster(row) {
  const metrics = row?.clusterMetrics;
  if (!metrics || typeof metrics !== 'object') return false;
  return Object.values(metrics).some((m) => Number(m?.toSupply) > 0);
}

function usePopoverDismiss(open, setOpen, rootRef) {
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen, rootRef]);
}

function ForecastSettingsPopover({ planDays, zeroStockBoost, onPlanDaysChange, onZeroStockBoostChange }) {
  const [open, setOpen] = useState(false);
  const [boostDraft, setBoostDraft] = useState(String(zeroStockBoost));
  const rootRef = useRef(null);
  usePopoverDismiss(open, setOpen, rootRef);

  useEffect(() => {
    if (!open) setBoostDraft(String(zeroStockBoost));
  }, [open, zeroStockBoost]);

  const commitBoost = () => {
    const n = Number(String(boostDraft).replace(',', '.'));
    const v = Number.isFinite(n) ? Math.min(200, Math.max(0, Math.round(n))) : 0;
    onZeroStockBoostChange(v);
    setBoostDraft(String(v));
  };

  return (
    <div className="fbo-forecast-settings" ref={rootRef}>
      <button
        type="button"
        className="fbo-forecast-settings__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Настройки прогноза"
      >
        Настройки
      </button>
      {open && (
        <div className="fbo-forecast-settings__popover" role="dialog" aria-label="Настройки прогноза">
          <div className="fbo-forecast-settings__title">Настройки прогноза</div>

          <label className="fbo-forecast-settings__field">
            <span className="fbo-forecast-settings__label">Период планирования</span>
            <select
              className="form-select form-select-sm"
              value={planDays}
              onChange={(e) => onPlanDaysChange(Number(e.target.value))}
            >
              {PLAN_DAYS_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d} дней
                </option>
              ))}
            </select>
            <span className="fbo-forecast-settings__hint">
              На этот срок рассчитывается «К поставке» (заказы масштабируются с периода загрузки).
            </span>
          </label>

          <label className="fbo-forecast-settings__field">
            <span className="fbo-forecast-settings__label">Увеличение поставки при нулевом остатке, %</span>
            <input
              className="form-control form-control-sm"
              type="number"
              min={0}
              max={200}
              step={1}
              value={boostDraft}
              onChange={(e) => setBoostDraft(e.target.value)}
              onBlur={commitBoost}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitBoost();
              }}
            />
            <span className="fbo-forecast-settings__hint">
              Если в кластере наличие = 0, к рекомендации «К поставке» добавляется указанный процент.
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function ForecastLoadReportModal({
  open,
  ordersPeriod,
  syncing,
  onOrdersPeriodChange,
  onClose,
  onConfirm,
}) {
  if (!open) return null;

  const setMode = (mode) => {
    if (mode === 'custom') {
      onOrdersPeriodChange({
        mode: 'custom',
        start: ordersPeriod.start || presetRange('month').start,
        end: ordersPeriod.end || presetRange('month').end,
      });
      return;
    }
    const range = presetRange(mode);
    onOrdersPeriodChange({ mode, start: range.start, end: range.end });
  };

  const customInvalid =
    ordersPeriod.mode === 'custom' &&
    ordersPeriod.start &&
    ordersPeriod.end &&
    ordersPeriod.start > ordersPeriod.end;

  return (
    <div className="fbo-forecast-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="fbo-forecast-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fbo-forecast-load-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id="fbo-forecast-load-title" className="fbo-forecast-modal__title">
          Загрузка отчёта
        </h3>
        <p className="fbo-forecast-modal__text">
          С WB загружаются <strong>текущие</strong> остатки, резерв и возвраты. Заказы подтягиваются за
          выбранный период.
        </p>

        <div className="fbo-forecast-settings__field">
          <span className="fbo-forecast-settings__label">Период заказов</span>
          <div className="fbo-forecast-period-chips">
            {ORDERS_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`fbo-forecast-period-chip${ordersPeriod.mode === p.id ? ' is-active' : ''}`}
                disabled={syncing}
                onClick={() => setMode(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {ordersPeriod.mode === 'custom' && (
          <div className="fbo-forecast-custom-dates">
            <label className="fbo-forecast-settings__field">
              <span className="fbo-forecast-settings__label">С</span>
              <input
                className="form-control"
                type="date"
                value={ordersPeriod.start || ''}
                max={ordersPeriod.end || undefined}
                disabled={syncing}
                onChange={(e) =>
                  onOrdersPeriodChange({ ...ordersPeriod, mode: 'custom', start: e.target.value })
                }
              />
            </label>
            <label className="fbo-forecast-settings__field">
              <span className="fbo-forecast-settings__label">По</span>
              <input
                className="form-control"
                type="date"
                value={ordersPeriod.end || ''}
                min={ordersPeriod.start || undefined}
                max={toIsoDate(new Date())}
                disabled={syncing}
                onChange={(e) =>
                  onOrdersPeriodChange({ ...ordersPeriod, mode: 'custom', end: e.target.value })
                }
              />
            </label>
          </div>
        )}

        {ordersPeriod.mode !== 'custom' && ordersPeriod.start && ordersPeriod.end && (
          <p className="fbo-forecast-modal__range">
            {fmtIsoRu(ordersPeriod.start)} — {fmtIsoRu(ordersPeriod.end)}
          </p>
        )}

        {customInvalid && (
          <p className="fbo-forecast-modal__error">Дата начала не может быть позже даты окончания.</p>
        )}

        <div className="fbo-forecast-modal__actions">
          <Button variant="secondary" disabled={syncing} onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" disabled={syncing || customInvalid} onClick={onConfirm}>
            {syncing ? 'Загрузка…' : 'Загрузить'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FboSupplyForecast() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState(null);
  const [clusterKey, setClusterKey] = useState('');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [hideZeroSupply, setHideZeroSupply] = useState(true);
  const [planDays, setPlanDays] = useState(readPlanDays);
  const [ordersPeriod, setOrdersPeriod] = useState(readOrdersPeriod);
  const [zeroStockBoost, setZeroStockBoost] = useState(readZeroStockBoost);
  const [loadModalOpen, setLoadModalOpen] = useState(false);
  const [loadModalPeriod, setLoadModalPeriod] = useState(readOrdersPeriod);

  const persistPlanDays = useCallback((days) => {
    setPlanDays(days);
    if (typeof localStorage !== 'undefined') localStorage.setItem(PLAN_DAYS_LS, String(days));
  }, []);

  const persistOrdersPeriod = useCallback((period) => {
    setOrdersPeriod(period);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ORDERS_PERIOD_LS, JSON.stringify(period));
    }
  }, []);

  const persistZeroStockBoost = useCallback((pct) => {
    setZeroStockBoost(pct);
    if (typeof localStorage !== 'undefined') localStorage.setItem(ZERO_STOCK_BOOST_LS, String(pct));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (overrides = {}) => {
      setLoading(true);
      setErr(null);
      const period = overrides.ordersPeriod ?? ordersPeriod;
      const apiPeriod = ordersPeriodToApi(period);
      try {
        const payload = await fboSuppliesApi.getWbForecast({
          cluster: clusterKey || undefined,
          q: searchDebounced || undefined,
          unlinkedOnly: unlinkedOnly || undefined,
          planDays,
          ...apiPeriod,
          zeroStockBoostPercent: zeroStockBoost,
        });
        setData(payload);
      } catch (e) {
        setErr(e.response?.data?.message || e.message || 'Не удалось загрузить данные');
      } finally {
        setLoading(false);
      }
    },
    [clusterKey, searchDebounced, unlinkedOnly, planDays, ordersPeriod, zeroStockBoost]
  );

  useEffect(() => {
    load();
  }, [load]);

  const openLoadModal = () => {
    setLoadModalPeriod(ordersPeriod);
    setLoadModalOpen(true);
  };

  const handleLoadReport = async () => {
    setSyncing(true);
    setErr(null);
    const selectedPeriod = loadModalPeriod;
    try {
      persistOrdersPeriod(selectedPeriod);
      await fboSuppliesApi.syncWbForecast();
      setLoadModalOpen(false);
      await load({ ordersPeriod: selectedPeriod });
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить отчёт с WB');
    } finally {
      setSyncing(false);
    }
  };

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const visibleRows = useMemo(() => {
    if (!hideZeroSupply) return rows;
    return rows.filter((row) => rowHasSupplyInAnyCluster(row));
  }, [rows, hideZeroSupply]);
  const allClusters = useMemo(() => (Array.isArray(data?.clusters) ? data.clusters : []), [data]);
  const displayClusters = useMemo(() => {
    if (Array.isArray(data?.displayClusters) && data.displayClusters.length > 0) {
      return data.displayClusters;
    }
    return allClusters;
  }, [data, allClusters]);
  const totals = data?.totals || {
    quantity: 0,
    inWayToClient: 0,
    inWayFromClient: 0,
    ordersCount: 0,
    toSupply: 0,
    rowCount: 0,
  };
  const ordersStart = data?.ordersStart ?? ordersPeriod.start;
  const ordersEnd = data?.ordersEnd ?? ordersPeriod.end;
  const ordersDaysCount = data?.ordersDays ?? null;
  const planningPeriod = data?.planDays ?? planDays;
  const boostPct = data?.zeroStockBoostPercent ?? zeroStockBoost;
  const hiddenRowsCount = rows.length - visibleRows.length;

  return (
    <div className="fbo-supplies-page">
      <FboSuppliesSubNav />

      <div className="fbo-supplies-toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Прогнозирование поставок (WB)</h2>
        <Button variant="primary" disabled={syncing || loading} onClick={openLoadModal}>
          {syncing ? 'Загрузка…' : 'Загрузить отчёт'}
        </Button>
      </div>

      <ForecastLoadReportModal
        open={loadModalOpen}
        ordersPeriod={loadModalPeriod}
        syncing={syncing}
        onOrdersPeriodChange={setLoadModalPeriod}
        onClose={() => {
          if (!syncing) setLoadModalOpen(false);
        }}
        onConfirm={handleLoadReport}
      />

      {err && (
        <div className="alert alert-danger" role="alert">
          {err}
        </div>
      )}

      <div className="fbo-forecast-meta">
        <span>
          Остатки на: <strong>{fmtDt(data?.syncedAt)}</strong>
        </span>
        <span>
          Заказы: <strong>{fmtIsoRu(ordersStart)} — {fmtIsoRu(ordersEnd)}</strong>
          {ordersDaysCount != null && (
            <>
              {' '}
              (<strong>{ordersDaysCount}</strong> дн.)
            </>
          )}
        </span>
        <span>
          Планирование: <strong>{planningPeriod} дн.</strong>
        </span>
        {boostPct > 0 && (
          <span>
            Нулевой остаток: <strong>+{boostPct}%</strong>
          </span>
        )}
        <span>
          Товаров: <strong>{fmtQty(visibleRows.length)}</strong>
          {hideZeroSupply && hiddenRowsCount > 0 && (
            <span className="fbo-forecast-meta__muted"> (скрыто {hiddenRowsCount})</span>
          )}
        </span>
        <span>
          К поставке: <strong>{fmtQty(totals.toSupply)}</strong>
        </span>
      </div>

      <div className="fbo-forecast-filters">
        <label>
          Кластер
          <select
            className="form-select form-select-sm"
            value={clusterKey}
            onChange={(e) => setClusterKey(e.target.value)}
          >
            <option value="">Все кластеры</option>
            {allClusters.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Поиск
          <input
            className="form-control form-control-sm"
            type="search"
            placeholder="Артикул, название…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="fbo-forecast-toggle">
          <span className="fbo-forecast-toggle__track">
            <input
              type="checkbox"
              className="fbo-forecast-toggle__input"
              checked={hideZeroSupply}
              onChange={(e) => setHideZeroSupply(e.target.checked)}
            />
            <span className="fbo-forecast-toggle__thumb" aria-hidden />
          </span>
          <span className="fbo-forecast-toggle__label">Скрыть без поставки</span>
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 18 }}>
          <input
            type="checkbox"
            className="form-check-input"
            checked={unlinkedOnly}
            onChange={(e) => setUnlinkedOnly(e.target.checked)}
          />
          Только без привязки к товару ERM
        </label>
        <ForecastSettingsPopover
          planDays={planDays}
          zeroStockBoost={zeroStockBoost}
          onPlanDaysChange={persistPlanDays}
          onZeroStockBoostChange={persistZeroStockBoost}
        />
      </div>

      {loading && !data ? (
        <p className="text-muted">Загрузка…</p>
      ) : visibleRows.length === 0 ? (
        <p className="text-muted">
          {data?.syncedAt
            ? hideZeroSupply && rows.length > 0
              ? 'Все строки скрыты фильтром «Скрыть без поставки».'
              : 'Нет строк по выбранным фильтрам.'
            : 'Данных ещё нет. Нажмите «Загрузить отчёт».'}
        </p>
      ) : (
        <div className="fbo-forecast-table-wrap">
          <table className="fbo-forecast-table fbo-forecast-table--clusters">
            <thead>
              <tr>
                <th rowSpan={2} className="fbo-forecast-sticky fbo-forecast-sticky--sku">
                  Артикул
                </th>
                <th rowSpan={2} className="fbo-forecast-sticky fbo-forecast-sticky--name fbo-forecast-col-name">
                  Название
                </th>
                {displayClusters.map((c) => (
                  <th
                    key={c.key}
                    colSpan={CLUSTER_METRIC_COLS.length}
                    className="fbo-forecast-cluster-head"
                  >
                    {c.name}
                  </th>
                ))}
              </tr>
              <tr>
                {displayClusters.map((c) =>
                  CLUSTER_METRIC_COLS.map((col) => (
                    <th
                      key={`${c.key}-${col.key}`}
                      className={`num fbo-forecast-metric-head${
                        col.key === 'toSupply' ? ' fbo-forecast-metric-head--supply' : ''
                      }${col.key === 'avgOrdersPerDay' ? ' fbo-forecast-metric-head--avg' : ''}`}
                      title={col.title}
                    >
                      {col.label}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const name = row.productId
                  ? row.productName || row.productArticle || `Товар #${row.productId}`
                  : null;
                return (
                  <tr key={row.id}>
                    <td className="fbo-forecast-sticky fbo-forecast-sticky--sku">{displaySku(row)}</td>
                    <td
                      className="fbo-forecast-sticky fbo-forecast-sticky--name fbo-forecast-col-name"
                      title={name || undefined}
                    >
                      {name ? (
                        <span className="fbo-forecast-name">{name}</span>
                      ) : (
                        <span className="fbo-forecast-unlinked">не привязан</span>
                      )}
                    </td>
                    {displayClusters.map((c) => {
                      const m = row.clusterMetrics?.[c.key] || {};
                      return CLUSTER_METRIC_COLS.map((col) => (
                        <td
                          key={`${row.id}-${c.key}-${col.key}`}
                          className={`num${
                            col.key === 'toSupply' ? ' fbo-forecast-supply-cell' : ''
                          }${col.key === 'avgOrdersPerDay' ? ' fbo-forecast-avg-cell' : ''}`}
                          title={col.title}
                        >
                          {fmtCellValue(col, m[col.key])}
                        </td>
                      ));
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="fbo-forecast-note">{data?.apiNote}</p>
    </div>
  );
}
