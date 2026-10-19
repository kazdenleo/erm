import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { procurementForecastApi } from '../../services/procurementForecast.api';
import { warehouseDisplayLabel } from '../../utils/stockDestinationDefaults.js';

export const LOW_STOCK_URGENCY = {
  out: { label: 'Закончился', className: 'low-stock-badge--out' },
  critical: { label: 'Критично', className: 'low-stock-badge--critical' },
  soon: { label: 'Скоро', className: 'low-stock-badge--soon' },
};

const PERIOD_OPTIONS = [14, 30, 60, 90];
const ALERT_OPTIONS = [5, 7, 10, 14, 21, 30, 45];
const COVER_OPTIONS = [5, 7, 10, 14, 30, 45, 60, 90];

function fmtQty(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function fmtDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
}

export function daysLeftLabel(item) {
  if (item.urgency === 'out') return 'нет в наличии';
  const d = Number(item.daysLeft) || 0;
  if (d < 1) return 'меньше дня';
  return `${Math.floor(d)} дн.`;
}

function downloadCsv(rows) {
  const head = ['Артикул', 'Товар', 'Поставщик', 'Срочность', 'Расход в день', 'Свободно', 'В пути', 'Хватит, дней', 'Закончится', 'Заказать'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  for (const it of rows) {
    lines.push(
      [
        it.productSku,
        it.productName,
        it.supplierName,
        LOW_STOCK_URGENCY[it.urgency]?.label || it.urgency,
        String(it.dailyRate).replace('.', ','),
        it.available,
        it.incoming,
        String(it.daysLeft).replace('.', ','),
        fmtDate(it.runOutDate),
        it.toOrder,
      ]
        .map(esc)
        .join(';')
    );
  }
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `skoro-zakonchitsya-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function LowStockPanel({ ownWarehouses = [] }) {
  const [warehouseId, setWarehouseId] = useState('');
  const [periodDays, setPeriodDays] = useState(30);
  const [alertDays, setAlertDays] = useState(14);
  const [coverDays, setCoverDays] = useState(30);
  const [urgency, setUrgency] = useState('all');
  const [supplier, setSupplier] = useState('');
  const [search, setSearch] = useState('');
  const [hideCovered, setHideCovered] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await procurementForecastApi.getLowStock({ warehouseId, periodDays, alertDays, coverDays });
      setData(res || null);
    } catch (e) {
      setError(e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Не удалось загрузить');
    } finally {
      setLoading(false);
    }
  }, [warehouseId, periodDays, alertDays, coverDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => data?.items || [], [data]);

  const suppliers = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const key = it.supplierId != null ? String(it.supplierId) : 'none';
      if (!m.has(key)) m.set(key, it.supplierName || 'Без поставщика');
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (urgency !== 'all' && it.urgency !== urgency) return false;
      if (hideCovered && it.coveredByIncoming) return false;
      if (supplier) {
        const key = it.supplierId != null ? String(it.supplierId) : 'none';
        if (key !== supplier) return false;
      }
      if (q && !`${it.productSku} ${it.productName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, urgency, hideCovered, supplier, search]);

  const summary = data?.summary || {};
  const sources = data?.sources || {};
  const urgencyTabs = [
    { key: 'all', label: 'Все', count: data?.totalItems ?? 0 },
    { key: 'out', label: 'Закончились', count: summary.out ?? 0 },
    { key: 'critical', label: `Критично (≤ ${data?.params?.criticalDays ?? 3} дн.)`, count: summary.critical ?? 0 },
    { key: 'soon', label: `Скоро (≤ ${data?.params?.alertDays ?? alertDays} дн.)`, count: summary.soon ?? 0 },
  ];

  return (
    <div className="low-stock-panel">
      <p className="text-muted small mb-2">
        Расход считается по{' '}
        {[sources.orders && 'заказам FBS и частным', sources.fboSupplies && 'поставкам FBO'].filter(Boolean).join(' и ') ||
          'заказам'}{' '}
        за последние {data?.params?.periodDays ?? periodDays} дн. (комплекты раскладываются на комплектующие). «Свободно» —
        остаток на наших складах без резерва плюс комплектующие в собранных комплектах.
      </p>

      <div className="stock-levels-filters">
        <label className="stock-levels-filter-label">
          <span>Склад:</span>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="stock-levels-filter-select">
            <option value="">Все наши склады</option>
            {ownWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {warehouseDisplayLabel(w)}
              </option>
            ))}
          </select>
        </label>
        <label className="stock-levels-filter-label">
          <span>Расход за:</span>
          <select value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} className="stock-levels-filter-select">
            {PERIOD_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} дн.
              </option>
            ))}
          </select>
        </label>
        <label className="stock-levels-filter-label" title="Товар попадает в список, если запаса хватит меньше чем на столько дней">
          <span>Предупреждать за:</span>
          <select value={alertDays} onChange={(e) => setAlertDays(Number(e.target.value))} className="stock-levels-filter-select">
            {ALERT_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} дн.
              </option>
            ))}
          </select>
        </label>
        <label className="stock-levels-filter-label" title="Колонка «Заказать»: сколько докупить, чтобы хватило на столько дней (с учётом товара в пути)">
          <span>Заказать на:</span>
          <select value={coverDays} onChange={(e) => setCoverDays(Number(e.target.value))} className="stock-levels-filter-select">
            {COVER_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} дн.
              </option>
            ))}
          </select>
        </label>
        <label className="stock-levels-filter-label">
          <span>Поставщик:</span>
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="stock-levels-filter-select">
            <option value="">Все</option>
            {suppliers.map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="stock-levels-filter-label">
          <span>Поиск:</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Артикул или название"
            className="stock-levels-filter-select"
          />
        </label>
        <label className="stock-levels-filter-label low-stock-check">
          <input type="checkbox" checked={hideCovered} onChange={(e) => setHideCovered(e.target.checked)} />
          <span>Скрыть закрытые поставкой в пути</span>
        </label>
      </div>

      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <div className="erp-filter-row" role="tablist" style={{ marginBottom: 0 }}>
          {urgencyTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={urgency === t.key}
              className={`erp-filter-btn${urgency === t.key ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setUrgency(t.key)}
            >
              {t.label} · {t.count}
            </button>
          ))}
        </div>
        <div className="ms-auto d-flex gap-2">
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline-primary"
            onClick={() => downloadCsv(filtered)}
            disabled={!filtered.length}
          >
            Скачать CSV
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger py-2" role="alert">
          {error}
        </div>
      ) : null}

      {!loading && !error && data && !filtered.length ? (
        <div className="text-muted py-4 text-center">
          {items.length ? 'Под фильтры ничего не подходит.' : 'Запасов хватает — ничего пополнять не нужно.'}
        </div>
      ) : null}

      {filtered.length ? (
        <div className="table-responsive">
          <table className="table table-sm table-hover align-middle low-stock-table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>Поставщик</th>
                <th>Срочность</th>
                <th className="text-end" title="Средний расход в день за период">
                  Расход/день
                </th>
                <th className="text-end">Свободно</th>
                <th className="text-end">В пути</th>
                <th className="text-end">Хватит на</th>
                <th className="text-end" title={`Сколько докупить, чтобы хватило на ${data?.params?.coverDays ?? coverDays} дн.`}>
                  Заказать
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const u = LOW_STOCK_URGENCY[it.urgency] || {};
                return (
                  <tr key={it.productId}>
                    <td>
                      <Link to={`/products/${it.productId}`} className="low-stock-name">
                        {it.productName || `Товар #${it.productId}`}
                      </Link>
                      {it.productSku ? <div className="text-muted small">{it.productSku}</div> : null}
                    </td>
                    <td className="small">
                      {it.supplierName || <span className="text-muted">—</span>}
                    </td>
                    <td>
                      <span className={`low-stock-badge ${u.className || ''}`}>{u.label || it.urgency}</span>
                      {it.coveredByIncoming ? (
                        <div className="small text-success" title="С учётом товара в пути запаса хватит дольше порога">
                          закрыто поставкой
                        </div>
                      ) : null}
                    </td>
                    <td className="text-end" title={`Заказы: ${fmtQty(it.ordersQty)}, поставки FBO: ${fmtQty(it.fboQty)} шт.`}>
                      {fmtQty(it.dailyRate)}
                    </td>
                    <td
                      className="text-end"
                      title={`На складе: ${it.onHand}, в резерве: ${it.reserved}${it.inKits ? `, в комплектах: ${it.inKits}` : ''}`}
                    >
                      {fmtQty(it.available)}
                    </td>
                    <td className="text-end">{it.incoming ? fmtQty(it.incoming) : <span className="text-muted">—</span>}</td>
                    <td className="text-end">
                      <div>{daysLeftLabel(it)}</div>
                      {it.runOutDate ? <div className="text-muted small">до {fmtDate(it.runOutDate)}</div> : null}
                    </td>
                    <td className="text-end fw-semibold">{it.toOrder ? fmtQty(it.toOrder) : <span className="text-muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default LowStockPanel;
