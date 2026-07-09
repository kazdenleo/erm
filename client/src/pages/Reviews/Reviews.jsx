/**
 * Отзывы покупателей с маркетплейсов (Ozon, Wildberries, Яндекс Маркет)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { normalizeMarketplaceForUI } from '../../utils/orderListGroupKey';
import { reviewsApi } from '../../services/reviews.api';
import { Button } from '../../components/common/Button/Button';
import './Reviews.css';

const HAS_TEXT_OPTIONS = [
  { value: 'all', label: 'Все' },
  { value: 'true', label: 'С текстом' },
  { value: 'false', label: 'Без текста' },
];

const STARS_OPTIONS = [
  { value: 'all', label: 'Все' },
  { value: '5', label: '5★' },
  { value: '4', label: '4★' },
  { value: '3', label: '3★' },
  { value: '2', label: '2★' },
  { value: '1', label: '1★' },
];

function bumpReviewsStats() {
  window.dispatchEvent(new Event('reviews-stats-refresh'));
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

function truncate(s, n = 220) {
  const t = s == null ? '' : String(s);
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

function starsLabel(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1 || x > 5) return '—';
  return `${Math.round(x)}★`;
}

const AUTO_REFRESH_MS = 60 * 60 * 1000;

export function Reviews() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [starsFilter, setStarsFilter] = useState('all');
  const [hasTextFilter, setHasTextFilter] = useState('all');
  const [sort, setSort] = useState('date_desc');

  const [filterCounts, setFilterCounts] = useState({ new: 0 });
  const [mpCounts, setMpCounts] = useState({ ozon: 0, wildberries: 0, yandex: 0 });
  const [drafts, setDrafts] = useState({});
  const [sendingId, setSendingId] = useState(null);

  const loadCounts = useCallback(async () => {
    try {
      const params = {};
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      const { counts, countsByMarketplace } = await reviewsApi.getStats(params);
      setFilterCounts({ new: counts?.new ?? 0 });
      setMpCounts(countsByMarketplace);
    } catch {
      setFilterCounts({ new: 0 });
      setMpCounts({ ozon: 0, wildberries: 0, yandex: 0 });
    }
  }, [marketplaceFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const params = { sort, answered: 'new' };
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      if (starsFilter !== 'all') params.stars = starsFilter;
      if (hasTextFilter !== 'all') params.hasText = hasTextFilter;
      const data = await reviewsApi.getAll(params);
      setItems(Array.isArray(data) ? data : []);
      bumpReviewsStats();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить отзывы');
      setItems([]);
    } finally {
      setLoading(false);
      loadCounts();
    }
  }, [marketplaceFilter, starsFilter, hasTextFilter, sort, loadCounts]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => loadRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const getDraft = (r) =>
    Object.prototype.hasOwnProperty.call(drafts, r.id) ? drafts[r.id] : '';

  const setDraft = (id, value) => {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const sendAnswer = async (r) => {
    const text = String(getDraft(r) ?? '').trim();
    if (!text) {
      setError('Введите текст ответа');
      return;
    }
    try {
      setSendingId(r.id);
      setError('');
      await reviewsApi.answer(r.id, text);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[r.id];
        return next;
      });
      await load();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось отправить ответ');
    } finally {
      setSendingId(null);
    }
  };

  const mpTotalAll = mpCounts.ozon + mpCounts.wildberries + mpCounts.yandex;

  return (
    <div className="card reviews-page">
      <h1 className="title">Отзывы</h1>
      <p className="subtitle">
        Новые отзывы без ответа. Отвеченные не хранятся — после ответа отзыв исчезает из списка. Данные
        обновляются на сервере раз в час.
      </p>

      <div className="reviews-toolbar">
        <div className="reviews-toolbar-left" />
        <div className="reviews-toolbar-right">
          <div className="reviews-filter">
            <span className="reviews-filter-label">Маркетплейс</span>
            <select value={marketplaceFilter} onChange={(e) => setMarketplaceFilter(e.target.value)}>
              <option value="all">Все ({mpTotalAll})</option>
              <option value="ozon">Ozon ({mpCounts.ozon})</option>
              <option value="wildberries">WB ({mpCounts.wildberries})</option>
              <option value="yandex">Яндекс ({mpCounts.yandex})</option>
            </select>
          </div>
          <div className="reviews-filter">
            <span className="reviews-filter-label">Звёзды</span>
            <select value={starsFilter} onChange={(e) => setStarsFilter(e.target.value)}>
              {STARS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="reviews-filter">
            <span className="reviews-filter-label">Текст</span>
            <select value={hasTextFilter} onChange={(e) => setHasTextFilter(e.target.value)}>
              {HAS_TEXT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="reviews-filter">
            <span className="reviews-filter-label">Сортировка</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="date_desc">Сначала новые</option>
              <option value="date_asc">Сначала старые</option>
              <option value="rating_desc">Сначала 5★</option>
              <option value="rating_asc">Сначала 1★</option>
            </select>
          </div>
        </div>
      </div>

      <div className="reviews-counts text-muted small">
        Новых отзывов: <strong>{filterCounts.new}</strong>
      </div>

      {error && <div className="alert alert-danger mt-2">{error}</div>}
      {loading && <div className="text-muted mt-3">Загрузка…</div>}

      {!loading && !error && items.length === 0 && (
        <div className="text-muted mt-3">Нет новых отзывов по выбранным фильтрам.</div>
      )}

      {!loading && items.length > 0 && (
        <div className="table-responsive mt-3">
          <table className="table table-striped table-hover align-middle reviews-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>МП</th>
                <th>Звёзды</th>
                <th>Артикул</th>
                <th>Отзыв</th>
                <th>Ответ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const mp = normalizeMarketplaceForUI(r.marketplace);
                const badge = MARKETPLACE_TABLE_BADGES[mp] || null;
                return (
                  <tr key={r.id}>
                    <td className="text-nowrap">{formatDt(r.sourceCreatedAt)}</td>
                    <td className="text-nowrap">
                      {badge ? <span className={`badge ${badge.className}`}>{badge.label}</span> : mp}
                    </td>
                    <td className="text-nowrap">{starsLabel(r.rating)}</td>
                    <td className="text-nowrap">{r.skuOrOffer || '—'}</td>
                    <td style={{ minWidth: 280 }}>
                      <div className="reviews-body">{truncate(r.body || '—')}</div>
                      {!r.hasText && <div className="text-muted small">Без текста (только оценка)</div>}
                    </td>
                    <td style={{ minWidth: 320 }}>
                      <div className="reviews-answer-form">
                        <textarea
                          className="form-control form-control-sm"
                          rows={3}
                          value={getDraft(r)}
                          onChange={(e) => setDraft(r.id, e.target.value)}
                          placeholder="Ответ продавца…"
                        />
                        <div className="d-flex gap-2 mt-2">
                          <Button
                            type="button"
                            variant="primary"
                            size="small"
                            onClick={() => sendAnswer(r)}
                            disabled={sendingId === r.id}
                          >
                            {sendingId === r.id ? 'Отправка…' : 'Ответить'}
                          </Button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

