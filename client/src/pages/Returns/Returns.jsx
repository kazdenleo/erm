/**
 * Возвраты с маркетплейсов — товары, ожидающие забора продавцом.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { marketplaceReturnsApi } from '../../services/marketplaceReturns.api';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { normalizeMarketplaceForUI } from '../../utils/orderListGroupKey';
import { useAuth } from '../../context/AuthContext.jsx';
import { useOrganizations } from '../../hooks/useOrganizations';
import './Returns.css';

const FILTER_OPTIONS = [
  { value: 'waiting', label: 'Готовы к выдаче' },
  { value: 'all', label: 'Все за период' },
  { value: 'completed', label: 'Завершённые' },
];

const DAYS_OPTIONS = [
  { value: 31, label: '31 день' },
  { value: 62, label: '62 дня' },
  { value: 93, label: '93 дня' },
];

function bumpReturnsStats() {
  window.dispatchEvent(new Event('marketplace-returns-stats-refresh'));
}

function formatDt(iso) {
  if (iso == null || iso === '') return '—';
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '—';
  }
}

function formatDateOnly(iso) {
  if (iso == null || iso === '') return '—';
  try {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('ru-RU');
  } catch {
    return String(iso);
  }
}

function isExpiredSoon(expiredDt) {
  if (!expiredDt) return false;
  const d = new Date(expiredDt);
  if (Number.isNaN(d.getTime())) return false;
  const diff = d.getTime() - Date.now();
  return diff >= 0 && diff <= 3 * 24 * 60 * 60 * 1000;
}

function isExpired(expiredDt) {
  if (!expiredDt) return false;
  const d = new Date(expiredDt);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

function mpBadge(code) {
  const norm = normalizeMarketplaceForUI(code);
  const b = MARKETPLACE_TABLE_BADGES.find((x) => x.code === norm);
  if (!b) return null;
  return (
    <span className={`mp-badge ${b.badgeClass}`} title={b.name}>
      {b.shortLabel}
    </span>
  );
}

function normalizeMarketplaceQuery(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'wb') return 'wildberries';
  if (s === 'ym') return 'yandex';
  if (['ozon', 'wildberries', 'yandex', 'all'].includes(s)) return s;
  return 'all';
}

export function Returns() {
  const [searchParams] = useSearchParams();
  const { selectedOrganizationId: contextOrganizationId, setSelectedOrganizationId } = useAuth();
  const { organizations } = useOrganizations();

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({});
  const [stats, setStats] = useState({
    waitingCount: 0,
    totalCount: 0,
    completedCount: 0,
    countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
  });
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  const [marketplaceFilter, setMarketplaceFilter] = useState(() =>
    normalizeMarketplaceQuery(searchParams.get('marketplace'))
  );
  const [filter, setFilter] = useState('waiting');
  const [days, setDays] = useState(31);

  useEffect(() => {
    const mp = normalizeMarketplaceQuery(searchParams.get('marketplace'));
    setMarketplaceFilter(mp);
  }, [searchParams]);

  const loadStats = useCallback(async () => {
    try {
      const s = await marketplaceReturnsApi.getStats({ days, marketplace: marketplaceFilter });
      setStats(s);
    } catch {
      setStats({
        waitingCount: 0,
        totalCount: 0,
        completedCount: 0,
        countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
      });
    }
  }, [days, marketplaceFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      setWarnings([]);
      const { items: rows, meta: m } = await marketplaceReturnsApi.getAll({
        filter,
        days,
        marketplace: marketplaceFilter,
      });
      setItems(Array.isArray(rows) ? rows : []);
      setMeta(m || {});
      const errs = m?.errors;
      if (errs && typeof errs === 'object') {
        const labels = { ozon: 'Ozon', wildberries: 'WB', yandex: 'Яндекс' };
        setWarnings(
          Object.entries(errs).map(([k, msg]) => `${labels[k] || k}: ${msg}`)
        );
      }
      bumpReturnsStats();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить возвраты');
      setItems([]);
      setMeta({});
    } finally {
      setLoading(false);
      loadStats();
    }
  }, [filter, days, marketplaceFilter, loadStats]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (contextOrganizationId) return;
    const first = (organizations || [])[0];
    if (first?.id != null) {
      setSelectedOrganizationId(String(first.id));
    }
  }, [contextOrganizationId, organizations, setSelectedOrganizationId]);

  useEffect(() => {
    if (!contextOrganizationId) return;
    load();
  }, [load, contextOrganizationId]);

  const onRefresh = () => loadRef.current();

  const mpCounts = stats.countsByMarketplace || { ozon: 0, wildberries: 0, yandex: 0 };
  const mpTotalWaiting = mpCounts.ozon + mpCounts.wildberries + mpCounts.yandex;
  const shownCount = items.length;
  const waitingInView = filter === 'waiting' ? shownCount : stats.waitingCount;

  return (
    <div className="page mp-returns-page">
      <header className="page-header mp-returns-header">
        <div>
          <h1>Возвраты</h1>
          <p className="subtitle">
            Возвраты и невыкупы, которые уже лежат в точке выдачи и их можно забрать. По умолчанию — не «в пути»,
            а готовые к выдаче продавцу.
          </p>
        </div>
        <Button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
      </header>

      <div className="mp-returns-toolbar">
        <div className="erp-filter-row" role="group" aria-label="Фильтр по маркетплейсу">
          <button
            type="button"
            className={`erp-filter-btn${marketplaceFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setMarketplaceFilter('all')}
            disabled={loading}
          >
            Все
            <span className="erp-filter-btn__count">{mpTotalWaiting}</span>
          </button>
          {MARKETPLACE_TABLE_BADGES.map((b) => {
            const key = b.code;
            const cnt = mpCounts[key] ?? 0;
            return (
              <button
                key={key}
                type="button"
                className={`erp-filter-btn${marketplaceFilter === key ? ' erp-filter-btn--active' : ''}`}
                onClick={() => setMarketplaceFilter(key)}
                disabled={loading}
                title={b.name}
              >
                <span className={`mp-badge ${b.badgeClass}`}>{b.shortLabel}</span>
                <span className="erp-filter-btn__count">{cnt}</span>
              </button>
            );
          })}
        </div>

        <div className="mp-returns-filter-row">
          <span className="mp-returns-filter-label">Показать:</span>
          <div className="mp-returns-filter-buttons">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mp-returns-filter-btn${filter === opt.value ? ' is-active' : ''}`}
                onClick={() => setFilter(opt.value)}
              >
                {opt.label}
                {opt.value === 'waiting' && stats.waitingCount > 0 ? ` (${stats.waitingCount})` : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="mp-returns-filter-row">
          <span className="mp-returns-filter-label">Период:</span>
          <div className="mp-returns-filter-buttons">
            {DAYS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mp-returns-filter-btn${days === opt.value ? ' is-active' : ''}`}
                onClick={() => setDays(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {!loading && !error && (
          <p className="mp-returns-summary">
            {filter === 'waiting' && (
              <>
                Готовы к выдаче: <strong>{waitingInView}</strong>
                {meta.totalFetched != null ? ` · всего в отчёте: ${meta.totalFetched}` : ''}
              </>
            )}
            {filter === 'all' && (
              <>
                Всего: <strong>{shownCount}</strong>
                {stats.waitingCount > 0 ? ` · ждут забора: ${stats.waitingCount}` : ''}
              </>
            )}
            {filter === 'completed' && (
              <>
                Завершённые: <strong>{shownCount}</strong>
              </>
            )}
          </p>
        )}
      </div>

      {error && <div className="alert alert-danger mp-returns-error">{error}</div>}
      {warnings.length > 0 && (
        <div className="alert alert-warning mp-returns-warn">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="mp-returns-empty">Загрузка данных с маркетплейсов…</p>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <p className="mp-returns-empty">
          {filter === 'waiting'
            ? 'Нет возвратов, готовых к выдаче за выбранный период.'
            : 'Нет возвратов за выбранный период.'}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="table-responsive mp-returns-table-wrap">
          <table className="table mp-returns-table">
            <thead>
              <tr>
                <th>МП</th>
                <th>Статус</th>
                <th>SKU / штрихкод</th>
                <th>Товар</th>
                <th>ПВЗ / точка</th>
                <th>Готов с</th>
                <th>Срок забора</th>
                <th>Причина</th>
                <th>Заказ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const expired = isExpired(row.expiredDt);
                const soon = !expired && isExpiredSoon(row.expiredDt);
                return (
                  <tr
                    key={`${row.marketplace}-${row.id}`}
                    className={[
                      row.waitingPickup ? 'mp-returns-row-waiting' : '',
                      expired ? 'mp-returns-row-expired' : '',
                      soon ? 'mp-returns-row-soon' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td>{mpBadge(row.marketplace)}</td>
                    <td>
                      <span className={`mp-returns-status${row.waitingPickup ? ' is-waiting' : ''}`}>
                        {row.status || '—'}
                      </span>
                      {row.statusDetail ? (
                        <div className="mp-returns-sub">{row.statusDetail}</div>
                      ) : null}
                    </td>
                    <td>
                      <div>{row.sku ?? '—'}</div>
                      <div className="mp-returns-sub">{row.barcode || '—'}</div>
                    </td>
                    <td>
                      <div>{row.productName || '—'}</div>
                      {row.productExtra ? (
                        <div className="mp-returns-sub">{row.productExtra}</div>
                      ) : null}
                    </td>
                    <td>
                      <div>{row.pickupAddress || '—'}</div>
                      {row.pickupPointId ? (
                        <div className="mp-returns-sub">ID: {row.pickupPointId}</div>
                      ) : null}
                    </td>
                    <td>{formatDt(row.readyFromDt)}</td>
                    <td>
                      {formatDt(row.expiredDt)}
                      {expired ? <div className="mp-returns-tag expired">Просрочен</div> : null}
                      {soon ? <div className="mp-returns-tag soon">Скоро истечёт</div> : null}
                    </td>
                    <td>{row.reason || '—'}</td>
                    <td>
                      <div>{row.orderId ?? '—'}</div>
                      <div className="mp-returns-sub">{formatDateOnly(row.orderDt)}</div>
                    </td>
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

/** @deprecated используйте Returns */
export { Returns as WbReturns };
