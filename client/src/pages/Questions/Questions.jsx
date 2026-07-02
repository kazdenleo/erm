/**
 * Вопросы покупателей с маркетплейсов (Ozon, Wildberries, Яндекс Маркет)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { questionsApi } from '../../services/questions.api';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { normalizeMarketplaceForUI } from '../../utils/orderListGroupKey';
import { formatProductTheme, extractBuyerName } from './questionsDisplay';
import { applyQuestionTemplate } from './questionTemplateText';
import { QuestionTemplatesModal } from './QuestionTemplatesModal';
import { questionAnswerTemplatesApi } from '../../services/questionAnswerTemplates.api';
import { useAuth } from '../../context/AuthContext.jsx';
import { useOrganizations } from '../../hooks/useOrganizations';
import './Questions.css';

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

function questionBuyerLabel(q) {
  return extractBuyerName(q);
}

const AUTO_SYNC_MS = 10 * 60 * 1000;

export function Questions() {
  const { selectedOrganizationId: contextOrganizationId, setSelectedOrganizationId } = useAuth();
  const { organizations } = useOrganizations();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [mpCounts, setMpCounts] = useState({ ozon: 0, wildberries: 0, yandex: 0 });
  const [threadModalId, setThreadModalId] = useState(null);
  const [threadDetail, setThreadDetail] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [threadDraft, setThreadDraft] = useState('');
  const [threadSending, setThreadSending] = useState(false);
  const [answerTemplates, setAnswerTemplates] = useState([]);
  const [templatesModalOpen, setTemplatesModalOpen] = useState(false);

  const loadCounts = useCallback(async () => {
    try {
      const params = {};
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      const { countsByMarketplace } = await questionsApi.getStats(params);
      setMpCounts(countsByMarketplace);
    } catch {
      setMpCounts({ ozon: 0, wildberries: 0, yandex: 0 });
    }
  }, [marketplaceFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const params = {};
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
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
  }, [marketplaceFilter, loadCounts]);

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
    load();
  }, [load]);

  const loadAnswerTemplates = useCallback(async () => {
    try {
      const data = await questionAnswerTemplatesApi.getAll();
      setAnswerTemplates(Array.isArray(data) ? data : []);
    } catch {
      setAnswerTemplates([]);
    }
  }, []);

  useEffect(() => {
    if (!contextOrganizationId) return;
    void loadAnswerTemplates();
  }, [contextOrganizationId, loadAnswerTemplates]);

  useEffect(() => {
    if (!templatesModalOpen) {
      void loadAnswerTemplates();
    }
  }, [templatesModalOpen, loadAnswerTemplates]);

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
    if (!contextOrganizationId) return undefined;
    syncFromMarketplaces();
    const id = setInterval(syncFromMarketplaces, AUTO_SYNC_MS);
    return () => clearInterval(id);
  }, [syncFromMarketplaces, contextOrganizationId]);

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
          if (!data) {
            setThreadError('Вопрос уже закрыт на маркетплейсе (ответ дан) и убран из списка.');
            setThreadDetail(null);
            setItems((prev) => prev.filter((q) => String(q.id) !== String(threadModalId)));
          } else {
            setThreadDetail(data);
            setThreadDraft('');
          }
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
      const id = String(threadModalId);
      closeThread();
      setItems((prev) => prev.filter((q) => String(q.id) !== id));
      bumpQuestionsStats();
      await loadCounts();
    } catch (e) {
      setThreadError(e?.response?.data?.message || e?.message || 'Не удалось отправить ответ');
    } finally {
      setThreadSending(false);
    }
  };

  const applyTemplateToDraft = (template) => {
    if (!template) return;
    const buyerName = threadDetail ? questionBuyerLabel(threadDetail) : null;
    setThreadDraft(applyQuestionTemplate(template.body, { buyerName }));
    setThreadError('');
  };

  const threadNeedsReply =
    threadDetail &&
    (() => {
      const tm = threadDetail.threadMessages;
      if (Array.isArray(tm) && tm.length > 0) {
        return String(tm[tm.length - 1]?.role || '').toLowerCase() === 'buyer';
      }
      const t = threadDetail.answerText;
      return t == null || String(t).trim() === '';
    })();

  return (
    <div className="card questions-page">
      <h1 className="title">Вопросы</h1>
      <p className="subtitle">
        Показываются только вопросы, на которые ещё нужен ответ продавца. Если ответили на маркетплейсе вручную,
        вопрос исчезнет после синхронизации. После вашего ответа из приложения вопрос убирается из списка. Если
        покупатель напишет снова, при открытии карточки подгрузится полная ветка переписки.
      </p>

      <div className="questions-toolbar">
        <div className="questions-toolbar-row">
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
              aria-label={`${mp.name}, ${mpCounts[mp.code] ?? 0} новых вопросов`}
            >
              <span className={`mp-badge ${mp.badgeClass}`}>{mp.shortLabel}</span>
              <span className="erp-filter-btn__count">{mpCounts[mp.code] ?? 0}</span>
            </button>
          ))}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => setTemplatesModalOpen(true)}
            disabled={loading || syncing}
          >
            Шаблоны ответов
          </Button>
        </div>
        {syncing && (
          <p className="text-muted small questions-sync-hint" aria-live="polite">
            Синхронизация с маркетплейсами…
          </p>
        )}
      </div>

      {error && <div className="error questions-error">{error}</div>}

      {loading ? (
        <div className="loading">Загрузка…</div>
      ) : items.length === 0 ? (
        <p className="text-muted questions-empty">
          Новых вопросов нет. Они появятся после синхронизации, если на маркетплейсе есть неотвеченные обращения.
        </p>
      ) : (
        <div className="table-responsive questions-table-wrap">
          <table className="table questions-table">
            <colgroup>
              <col className="questions-col-date" />
              <col className="questions-col-mp" />
              <col className="questions-col-theme" />
              <col className="questions-col-question" />
              <col className="questions-col-thread" />
            </colgroup>
            <thead>
              <tr>
                <th className="questions-col-date">Дата</th>
                <th className="questions-col-mp">МП</th>
                <th className="questions-col-theme">Артикул</th>
                <th className="questions-col-question">Вопрос</th>
                <th className="questions-col-thread">Ответ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => {
                const mpNorm = normalizeMarketplaceForUI(q.marketplace);
                const mpMeta = MARKETPLACE_TABLE_BADGES.find((m) => m.code === mpNorm);
                const mpLabel = mpMeta?.name ?? String(q.marketplace ?? '—');
                const buyerLabel = questionBuyerLabel(q);
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
                    <td className="questions-col-theme" title={formatProductTheme(q, 200)}>
                      {formatProductTheme(q, 40)}
                    </td>
                    <td className="questions-col-question">
                      <div className="questions-question-cell">
                        {buyerLabel ? (
                          <span className="questions-question-author" title={buyerLabel}>
                            {buyerLabel}
                          </span>
                        ) : null}
                        <span className="questions-question-body">{q.body}</span>
                      </div>
                    </td>
                    <td className="questions-col-thread">
                      <Button
                        type="button"
                        variant="primary"
                        size="small"
                        onClick={() => openThread(q.id)}
                        disabled={loading || syncing}
                      >
                        Ответить
                      </Button>
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
        {threadLoading && <div className="loading">Загрузка ветки с маркетплейса…</div>}
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
                    <strong>
                      {m.role === 'seller'
                        ? 'Продавец'
                        : questionBuyerLabel(threadDetail) || 'Покупатель'}
                    </strong>
                    {m.at ? <span className="text-muted small">{formatDt(m.at)}</span> : null}
                  </div>
                  <div className="questions-thread-msg__body">{m.text}</div>
                </div>
              ))}
            </div>
            {threadNeedsReply ? (
              <div className="questions-thread-reply">
                {answerTemplates.length > 0 ? (
                  <div className="questions-template-pick">
                    <span className="questions-template-pick__label">Быстрый ответ:</span>
                    <div className="questions-template-pick__list" role="list">
                      {answerTemplates.map((tpl) => (
                        <button
                          key={tpl.id}
                          type="button"
                          className="questions-template-pick__btn"
                          title={tpl.body}
                          onClick={() => applyTemplateToDraft(tpl)}
                          disabled={threadSending}
                        >
                          {tpl.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
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
                Последнее сообщение — от продавца. Карточка будет закрыта.
              </p>
            )}
          </div>
        )}
      </Modal>

      <QuestionTemplatesModal
        isOpen={templatesModalOpen}
        onClose={() => setTemplatesModalOpen(false)}
      />
    </div>
  );
}
