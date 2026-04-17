/**
 * Вопросы покупателей с маркетплейсов (Ozon, Wildberries, Яндекс Маркет)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { questionsApi } from '../../services/questions.api';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { normalizeMarketplaceForUI } from '../../utils/orderListGroupKey';
import { formatProductTheme } from './questionsDisplay';
import './Questions.css';

const ANSWERED_OPTIONS = [
  { value: 'all', label: 'Все' },
  { value: 'new', label: 'Новые' },
  { value: 'answered', label: 'Отвеченные' },
];

function bumpQuestionsStats() {
  window.dispatchEvent(new Event('questions-stats-refresh'));
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

function truncate(s, n = 200) {
  const t = s == null ? '' : String(s);
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

/** Есть сохранённый ответ продавца — форма ответа не показывается */
function hasSellerAnswer(q) {
  const t = q?.answerText;
  return t != null && String(t).trim() !== '';
}

const AUTO_SYNC_MS = 10 * 60 * 1000;

export function Questions() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [answeredFilter, setAnsweredFilter] = useState('new');
  const [filterCounts, setFilterCounts] = useState({ all: 0, new: 0, answered: 0 });
  const [mpCounts, setMpCounts] = useState({ ozon: 0, wildberries: 0, yandex: 0 });
  const [drafts, setDrafts] = useState({});
  const [sendingId, setSendingId] = useState(null);

  const loadCounts = useCallback(async () => {
    try {
      const params = {};
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      const { counts, countsByMarketplace } = await questionsApi.getStats(params);
      setFilterCounts(counts);
      setMpCounts(countsByMarketplace);
    } catch {
      setFilterCounts({ all: 0, new: 0, answered: 0 });
      setMpCounts({ ozon: 0, wildberries: 0, yandex: 0 });
    }
  }, [marketplaceFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const params = {};
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      if (answeredFilter !== 'all') params.answered = answeredFilter;
      const data = await questionsApi.getAll(params);
      setItems(Array.isArray(data) ? data : []);
      bumpQuestionsStats();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить вопросы');
      setItems([]);
    } finally {
      setLoading(false);
      loadCounts();
    }
  }, [marketplaceFilter, answeredFilter, loadCounts]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load();
  }, [load]);

  const syncFromMarketplaces = useCallback(async () => {
    try {
      setSyncing(true);
      setError('');
      await questionsApi.sync({});
      await loadRef.current();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Ошибка синхронизации с маркетплейсами');
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    syncFromMarketplaces();
    const id = setInterval(syncFromMarketplaces, AUTO_SYNC_MS);
    return () => clearInterval(id);
  }, [syncFromMarketplaces]);

  const getDraft = (q) =>
    Object.prototype.hasOwnProperty.call(drafts, q.id) ? drafts[q.id] : (q.answerText || '');

  const setDraft = (id, value) => {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  };

  const mpTotalAll = mpCounts.ozon + mpCounts.wildberries + mpCounts.yandex;

  const sendAnswer = async (q) => {
    const text = String(getDraft(q) ?? '').trim();
    if (!text) {
      setError('Введите текст ответа');
      return;
    }
    try {
      setSendingId(q.id);
      setError('');
      await questionsApi.answer(q.id, text);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      await load();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось отправить ответ');
    } finally {
      setSendingId(null);
    }
  };

  return (
    <div className="card questions-page">
      <h1 className="title">Вопросы</h1>
      <p className="subtitle">
        Вопросы о товарах из кабинетов маркетплейсов. Нужны настроенные интеграции: Ozon (Client ID + API Key; список
        вопросов через API доступен при подписке{' '}
        <strong>Premium Plus</strong> у Ozon), Wildberries (токен с правами «Вопросы и отзывы»), Яндекс.Маркет (Api-Key
        с доступом «Общение с покупателями» и Business ID). Синхронизация с маркетплейсами выполняется автоматически при
        открытии страницы и каждые 10 минут. Ответ на неотвеченный вопрос можно отправить из таблицы — он уйдёт в API
        соответствующего МП. «Новые» — без сохранённого ответа продавца; после отправки ответ вопрос попадает в
        «Отвеченные».
      </p>

      <div className="questions-toolbar">
        <div className="erp-filter-row" role="group" aria-label="Фильтр по маркетплейсу">
          <button
            type="button"
            className={`erp-filter-btn${marketplaceFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setMarketplaceFilter('all')}
            disabled={loading || syncing}
          >
            Все
            <span className="erp-filter-btn__count">{mpTotalAll}</span>
          </button>
          {MARKETPLACE_TABLE_BADGES.map((mp) => (
            <button
              key={mp.code}
              type="button"
              className={`erp-filter-btn${marketplaceFilter === mp.code ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setMarketplaceFilter(mp.code)}
              disabled={loading || syncing}
              title={mp.name}
              aria-label={`${mp.name}, ${mpCounts[mp.code] ?? 0} вопросов`}
            >
              <span className={`mp-badge ${mp.badgeClass}`}>{mp.shortLabel}</span>
              <span className="erp-filter-btn__count">{mpCounts[mp.code] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="questions-filter-answered-wrap">
          <div className="questions-filter-answered-heading">
            <span className="text-muted small questions-filter-answered-title">Новые и отвеченные</span>
            <span className="text-muted small questions-filter-answered-hint">
              числа — по выбранному маркетплейсу
            </span>
          </div>
          <div className="erp-filter-row questions-filter-answered-row" role="group" aria-label="Новые или отвеченные">
            {ANSWERED_OPTIONS.map((o) => {
              const n =
                o.value === 'all'
                  ? filterCounts.all
                  : o.value === 'new'
                    ? filterCounts.new
                    : filterCounts.answered;
              return (
                <button
                  key={o.value}
                  type="button"
                  className={`erp-filter-btn${answeredFilter === o.value ? ' erp-filter-btn--active' : ''}`}
                  onClick={() => setAnsweredFilter(o.value)}
                  disabled={loading || syncing}
                >
                  <span className="erp-filter-btn__label">{o.label}</span>
                  <span className="erp-filter-btn__count">{n}</span>
                </button>
              );
            })}
          </div>
        </div>
        {syncing && (
          <p className="text-muted small questions-sync-hint" aria-live="polite">
            Загрузка вопросов из маркетплейсов…
          </p>
        )}
      </div>

      {error && <div className="error questions-error">{error}</div>}

      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : items.length === 0 ? (
        <p className="text-muted questions-empty">
          Пока нет вопросов в базе. После настройки интеграций они подтянутся при синхронизации (при открытии страницы и
          каждые 10 минут).
        </p>
      ) : (
        <div className="table-responsive questions-table-wrap">
          <table className="table questions-table">
            <thead>
              <tr>
                <th className="questions-col-date">Дата</th>
                <th className="questions-col-mp">МП</th>
                <th className="questions-col-theme">Артикул</th>
                <th className="questions-col-question">Вопрос</th>
                <th className="questions-col-answer">Ответ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => {
                const mpNorm = normalizeMarketplaceForUI(q.marketplace);
                const mpMeta = MARKETPLACE_TABLE_BADGES.find((m) => m.code === mpNorm);
                const mpLabel = mpMeta?.name ?? String(q.marketplace ?? '—');
                const answered = hasSellerAnswer(q);
                return (
                  <tr key={q.id}>
                    <td className="questions-col-date">{formatDt(q.sourceCreatedAt)}</td>
                    <td className="questions-col-mp">
                      {mpMeta?.badgeClass && mpMeta.shortLabel ? (
                        <span
                          className={`mp-badge ${mpMeta.badgeClass}`}
                          title={mpLabel}
                          aria-label={mpLabel}
                        >
                          {mpMeta.shortLabel}
                        </span>
                      ) : (
                        <span className="mp-badge mp-unknown" title={mpLabel} aria-label={mpLabel}>
                          ?
                        </span>
                      )}
                    </td>
                    <td className="questions-col-theme">{formatProductTheme(q, 40)}</td>
                    <td className="questions-col-question">{truncate(q.body, 160)}</td>
                    <td className="questions-col-answer">
                      {answered ? (
                        <div className="questions-answer-existing text-muted">{truncate(q.answerText, 400)}</div>
                      ) : (
                        <div className="questions-answer-row">
                          <textarea
                            className="form-control questions-answer-input"
                            rows={3}
                            placeholder="Текст ответа покупателю…"
                            value={getDraft(q)}
                            onChange={(e) => setDraft(q.id, e.target.value)}
                            disabled={sendingId != null || syncing}
                          />
                          <Button
                            type="button"
                            variant="primary"
                            size="small"
                            className="questions-answer-send"
                            onClick={() => sendAnswer(q)}
                            disabled={loading || syncing || sendingId != null}
                          >
                            {sendingId === q.id ? 'Отправка…' : 'Ответить'}
                          </Button>
                        </div>
                      )}
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
