/**
 * Прогнозирование поставок FBO — остатки WB по складам
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { Button } from '../../components/common/Button/Button';
import { FboSuppliesSubNav } from './FboSuppliesSubNav.jsx';
import './FboSupplies.css';
import './FboSuppliesSubNav.css';

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

function fmtQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('ru-RU');
}

function displaySku(row) {
  return row.productArticle || row.wbVendorCode || row.externalSku || '—';
}

const PLAN_DAYS_OPTIONS = [30, 60, 90];
const PLAN_DAYS_LS = 'fbo_forecast_plan_days';

function readPlanDays() {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PLAN_DAYS_LS) : null;
  const n = Number(raw);
  return PLAN_DAYS_OPTIONS.includes(n) ? n : 30;
}

function ForecastPlanPeriodPopover({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

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
  }, [open]);

  const handleSelect = (days) => {
    onChange(days);
    setOpen(false);
  };

  return (
    <div className="fbo-forecast-period" ref={rootRef}>
      <button
        type="button"
        className="fbo-forecast-period__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Период, на который планируем поставку"
      >
        <span className="fbo-forecast-period__label">Период планирования</span>
        <span className="fbo-forecast-period__value">{value} дн.</span>
        <span className="fbo-forecast-period__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="fbo-forecast-period__popover" role="listbox" aria-label="Период планирования поставки">
          <div className="fbo-forecast-period__popover-title">На какой период планируем поставку?</div>
          {PLAN_DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              role="option"
              aria-selected={d === value}
              className={`fbo-forecast-period__option${d === value ? ' is-active' : ''}`}
              onClick={() => handleSelect(d)}
            >
              {d} дней
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FboSupplyForecast() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [planDays, setPlanDays] = useState(readPlanDays);

  const handlePlanDaysChange = useCallback((days) => {
    setPlanDays(days);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PLAN_DAYS_LS, String(days));
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const payload = await fboSuppliesApi.getWbForecast({
        warehouseId: warehouseId || undefined,
        q: searchDebounced || undefined,
        unlinkedOnly: unlinkedOnly || undefined,
      });
      setData(payload);
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, [warehouseId, searchDebounced, unlinkedOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSync = async () => {
    setSyncing(true);
    setErr(null);
    try {
      await fboSuppliesApi.syncWbForecast();
      await load();
    } catch (e) {
      setErr(e.response?.data?.message || e.message || 'Не удалось обновить данные с WB');
    } finally {
      setSyncing(false);
    }
  };

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const warehouses = useMemo(() => (Array.isArray(data?.warehouses) ? data.warehouses : []), [data]);
  const totals = data?.totals || { quantity: 0, inWayToClient: 0, inWayFromClient: 0, rowCount: 0 };

  return (
    <div className="fbo-supplies-page">
      <FboSuppliesSubNav />

      <div className="fbo-supplies-toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Прогнозирование поставок (WB)</h2>
        <ForecastPlanPeriodPopover value={planDays} onChange={handlePlanDaysChange} />
        <Button variant="primary" disabled={syncing} onClick={handleSync}>
          {syncing ? 'Обновление…' : 'Обновить с WB'}
        </Button>
      </div>

      {err && (
        <div className="alert alert-danger" role="alert">
          {err}
        </div>
      )}

      <div className="fbo-forecast-meta">
        <span>
          Период планирования: <strong>{planDays} дн.</strong>
        </span>
        <span>
          Последнее обновление: <strong>{fmtDt(data?.syncedAt)}</strong>
        </span>
        <span>
          Строк: <strong>{fmtQty(totals.rowCount)}</strong>
        </span>
        <span>
          Остаток: <strong>{fmtQty(totals.quantity)}</strong>
        </span>
        <span>
          Резерв (к клиенту): <strong>{fmtQty(totals.inWayToClient)}</strong>
        </span>
      </div>

      <div className="fbo-forecast-filters">
        <label>
          Склад WB
          <select
            className="form-select form-select-sm"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            <option value="">Все склады</option>
            {warehouses.map((w) => (
              <option key={w.id} value={String(w.id)}>
                {w.name || `Склад #${w.id}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Поиск
          <input
            className="form-control form-control-sm"
            type="search"
            placeholder="Артикул, название, склад…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
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
      </div>

      {loading && !data ? (
        <p className="text-muted">Загрузка…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted">
          {data?.syncedAt
            ? 'Нет строк по выбранным фильтрам.'
            : 'Данных ещё нет. Нажмите «Обновить с WB».'}
        </p>
      ) : (
        <div className="fbo-forecast-table-wrap">
          <table className="fbo-forecast-table">
            <thead>
              <tr>
                <th>Артикул</th>
                <th>Название</th>
                <th>Склад WB</th>
                <th>Регион</th>
                <th className="num">Остаток</th>
                <th className="num">Резерв</th>
                <th className="num">Возврат</th>
                <th>WB SKU</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{displaySku(row)}</td>
                  <td>
                    {row.productId ? (
                      row.productName || row.productArticle || `Товар #${row.productId}`
                    ) : (
                      <span className="fbo-forecast-unlinked">не привязан</span>
                    )}
                  </td>
                  <td>{row.warehouseName || (row.warehouseId ? `#${row.warehouseId}` : '—')}</td>
                  <td>{row.regionName || '—'}</td>
                  <td className="num">{fmtQty(row.quantity)}</td>
                  <td className="num">{fmtQty(row.inWayToClient)}</td>
                  <td className="num">{fmtQty(row.inWayFromClient)}</td>
                  <td>{row.externalSku}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="fbo-forecast-note">{data?.apiNote}</p>
    </div>
  );
}
