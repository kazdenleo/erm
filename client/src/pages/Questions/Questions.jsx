/**
 * Вопросы покупателей с маркетплейсов (Ozon, Wildberries, Яндекс Маркет)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
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

/** Нужен ответ продавца: последнее в ветке — покупатель или ветки ещё нет и нет answerText */
function threadNeedsSellerReply(q) {
  const tm = q?.threadMessages;
  if (Array.isArray(tm) && tm.length > 0) {
    return String(tm[tm.length - 1]?.role || '').toLowerCase() === 'buyer';
  }
  const t = q?.answerText;
  return t == null || String(t).trim() === '';
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
  const [threadModalId, setThreadModalId] = useState(null);
  const [threadDetail, setThreadDetail] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [threadDraft, setThreadDraft] = useState('');
  const [threadSending, setThreadSending] = useState(false);

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

  const mpTotalAll = mpCounts.ozon + mpCounts.wildberries + mpCounts.yandex;

  const openThread = useCallback((id) => {
    setThreadModalId(String(id));
    setThreadDetail(null);
    setThreadError('');
    setThreadDraft('');
  }, []);

  const closeThread = useCallback(() => {
    setThreadModalId(null);
    setThreadDetail(null);
    setThreadLoading(false);
    setThreadError('');
    setThreadDraft('');
    setThreadSending(false);
  }, []);

  useEffect(() => {
    if (!threadModalId) return undefined;
    let cancelled = false;
    (async () => {
      setThreadLoading(true);
      setThreadError('');
      try {
        const data = await questionsApi.getOne(threadModalId);
        if (!cancelled) {
          setThreadDetail(data);
          setThreadDraft('');
        }
      } catch (e) {
        if (!cancelled) {
          setThreadError(e?.response?.data?.message || e?.message || 'Не удалось загрузить ветку');
          setThreadDetail(null);
        }
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadModalId]);

  const sendThreadAnswer = async () => {
    const text = String(threadDraft ?? '').trim();
    if (!threadModalId || !text) {
      setThreadError('Введите текст ответа');
      return;
    }
    try {
      setThreadSending(true);
      setThreadError('');
      setError('');
      await questionsApi.answer(threadModalId, text);
      setThreadDraft('');
      const data = await questionsApi.getOne(threadModalId);
      setThreadDetail(data);
      await load();
      bumpQuestionsStats();
    } catch (e) {
      setThreadError(e?.response?.data?.message || e?.message || 'Не удалось отправить ответ');
    } finally {
      setThreadSending(false);
    }
  };

  return (
    <div className="card questions-page">
      <h1 className="title">Вопросы</h1>
      <p className="subtitle">
        Вопросы о товарах из кабинетов маркетплейсов. Нужны настроенные интеграции: Ozon (Client ID + API Key; список
        вопросов через API доступен при подписке{' '}
        <strong>Premium Plus</strong> у Ozon), Wildberries (токен с правами «Вопросы и отзывы»), Яндекс.Маркет (Api-Key
        с доступом «Общение с покупателями» и Business ID). Синхронизация выполняется при открытии страницы и каждые 10
        минут. По каждому вопросу строится <strong>ветка переписки</strong> (покупатель / продавец); ответ отправляется
        из окна ветки на маркетплейс. «Новые» — пока последнее сообщение от покупателя или ответа ещё не было.
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
                <th className="questions-col-status">Статус</th>
                <th className="questions-col-thread">Ветка</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => {
                const mpNorm = normalizeMarketplaceForUI(q.marketplace);
                const mpMeta = MARKETPLACE_TABLE_BADGES.find((m) => m.code === mpNorm);
                const mpLabel = mpMeta?.name ?? String(q.marketplace ?? '—');
                const needs = threadNeedsSellerReply(q);
                const nMsg = Array.isArray(q.threadMessages) ? q.threadMessages.length : 0;
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
                    <td className="questions-col-status">
                      {needs ? (
                        <span className="questions-status-pending">Ждёт ответа</span>
                      ) : (
                        <span className="text-muted">В работе</span>
                      )}
                    </td>
                    <td className="questions-col-thread">
                      <div className="questions-thread-cell">
                        <span className="text-muted small">{nMsg > 0 ? `${nMsg} сообщ.` : '—'}</span>
                        <Button
                          type="button"
                          variant={needs ? 'primary' : 'secondary'}
                          size="small"
                          onClick={() => openThread(q.id)}
                          disabled={loading || syncing}
                        >
                          Открыть ветку
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={Boolean(threadModalId)}
        onClose={closeThread}
        title={threadDetail ? `Ветка · ${formatProductTheme(threadDetail, 48)}` : 'Ветка переписки'}
        size="large"
      >
        {threadLoading && <div className="loading">Загрузка ветки…</div>}
        {!threadLoading && threadError && <div className="error">{threadError}</div>}
        {!threadLoading && threadDetail && (
          <div className="questions-thread-modal">
            <p className="text-muted small questions-thread-meta">
              {formatDt(threadDetail.sourceCreatedAt)} ·{' '}
              {MARKETPLACE_TABLE_BADGES.find((m) => m.code === normalizeMarketplaceForUI(threadDetail.marketplace))
                ?.name ?? threadDetail.marketplace}
            </p>
            <div className="questions-thread-list" role="log" aria-label="Переписка">
              {(threadDetail.threadMessages || []).map((m, i) => (
                <div
                  key={`${m.at}-${i}-${m.role}`}
                  className={`questions-thread-msg questions-thread-msg--${m.role === 'seller' ? 'seller' : 'buyer'}`}
                >
                  <div className="questions-thread-msg__head">
                    <strong>{m.role === 'seller' ? 'Продавец' : 'Покупатель'}</strong>
                    {m.at ? <span className="text-muted small">{formatDt(m.at)}</span> : null}
                  </div>
                  <div className="questions-thread-msg__body">{m.text}</div>
                </div>
              ))}
            </div>
            {threadNeedsSellerReply(threadDetail) ? (
              <div className="questions-thread-reply">
                <label className="label" htmlFor="questions-thread-reply-input">
                  Ваш ответ
                </label>
                <textarea
                  id="questions-thread-reply-input"
                  className="form-control"
                  rows={4}
                  placeholder="Текст ответа покупателю…"
                  value={threadDraft}
                  onChange={(e) => setThreadDraft(e.target.value)}
                  disabled={threadSending}
                />
                <div className="questions-thread-reply-actions">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => void sendThreadAnswer()}
                    disabled={threadSending || !String(threadDraft).trim()}
                  >
                    {threadSending ? 'Отправка…' : 'Отправить на маркетплейс'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={closeThread} disabled={threadSending}>
                    Закрыть
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-muted small questions-thread-done">
                Последнее сообщение — от продавца. Если покупатель напишет снова, вопрос появится в «Новых» после
                синхронизации.
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
