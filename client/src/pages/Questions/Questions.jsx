/**
 * Вопросы покупателей с маркетплейсов (Ozon, Wildberries, Яндекс Маркет)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { questionsApi } from '../../services/questions.api';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { normalizeMarketplaceForUI } from '../../utils/orderListGroupKey';
import {
  formatProductTheme,
  extractBuyerName,
  formatProductArticleWithName,
  questionNeedsReply,
} from './questionsDisplay';
import { applyQuestionTemplate } from './questionTemplateText';
import { QuestionTemplatesModal } from './QuestionTemplatesModal';
import { QuestionTextInsertToolbar } from './QuestionTextInsertToolbar';
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

const ANSWERED_FILTERS = [
  { id: 'new', label: 'Новые' },
  { id: 'answered', label: 'Архив' },
  { id: 'all', label: 'Все' },
];

export function Questions() {
  const { selectedOrganizationId: contextOrganizationId, setSelectedOrganizationId } = useAuth();
  const { organizations } = useOrganizations();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [answeredFilter, setAnsweredFilter] = useState('new');
  const [listCounts, setListCounts] = useState({ all: 0, new: 0, answered: 0 });
  const [mpCounts, setMpCounts] = useState({ ozon: 0, wildberries: 0, yandex: 0 });
  const [threadModalId, setThreadModalId] = useState(null);
  const [threadDetail, setThreadDetail] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [threadDraft, setThreadDraft] = useState('');
  const [threadSending, setThreadSending] = useState(false);
  const [answerTemplates, setAnswerTemplates] = useState([]);
  const [templatesModalOpen, setTemplatesModalOpen] = useState(false);
  const replyTextareaRef = useRef(null);

  const loadCounts = useCallback(async () => {
    try {
      const params = {};
      if (marketplaceFilter !== 'all') params.marketplace = marketplaceFilter;
      const { counts, countsByMarketplace } = await questionsApi.getStats(params);
      setListCounts(counts);
      setMpCounts(countsByMarketplace);
    } catch {
      setListCounts({ all: 0, new: 0, answered: 0 });
      setMpCounts({ ozon: 0, wildberries: 0, yandex: 0 });
    }
  }, [marketplaceFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const params = { answered: answeredFilter };
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
  }, [marketplaceFilter, answeredFilter, loadCounts]);

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

  const mpTotalNew = mpCounts.ozon + mpCounts.wildberries + mpCounts.yandex;

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
            setThreadError('Вопрос не найден.');
            setThreadDetail(null);
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
      closeThread();
      await loadRef.current();
    } catch (e) {
      setThreadError(e?.response?.data?.message || e?.message || 'Не удалось отправить ответ');
    } finally {
      setThreadSending(false);
    }
  };

  const applyTemplateToDraft = (template) => {
    if (!template || !threadDetail) return;
    setThreadDraft(
      applyQuestionTemplate(template.body, {
        buyerName: questionBuyerLabel(threadDetail),
      })
    );
    setThreadError('');
  };

  const threadNeedsReply = threadDetail ? questionNeedsReply(threadDetail) : false;

  const emptyMessage =
    answeredFilter === 'new'
      ? 'Новых вопросов нет. Они появятся после синхронизации, если на маркетплейсе есть неотвеченные обращения.'
      : answeredFilter === 'answered'
        ? 'В архиве пока нет закрытых переписок. После ответа вопрос сохранится здесь.'
        : 'Вопросов пока нет.';

  return (
    <div className="card questions-page">
      <h1 className="title">Вопросы</h1>
      <p className="subtitle">
        <strong>Новые</strong> — ждут ответа. <strong>Архив</strong> — закрытые переписки с полной историей. Если
        покупатель напишет снова, вопрос вернётся в «Новые», а в модалке будет вся цепочка сообщений.
      </p>

      <div className="questions-toolbar">
        <div className="questions-filter-answered-wrap">
          <div className="questions-filter-answered-heading">
            <span className="questions-filter-answered-title">Статус</span>
          </div>
          <div className="erp-filter-row questions-filter-answered-row" role="group" aria-label="Фильтр по статусу">
            {ANSWERED_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`erp-filter-btn${answeredFilter === f.id ? ' erp-filter-btn--active' : ''}`}
                onClick={() => setAnsweredFilter(f.id)}
                disabled={loading || syncing}
              >
                {f.label}
                <span className="erp-filter-btn__count">{listCounts[f.id] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="questions-toolbar-row">
          <div className="erp-filter-row" role="group" aria-label="Фильтр по маркетплейсу">
            <button
              type="button"
              className={`erp-filter-btn${marketplaceFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
              onClick={() => setMarketplaceFilter('all')}
              disabled={loading || syncing}
            >
              Все МП
              <span className="erp-filter-btn__count">{mpTotalNew}</span>
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
        <p className="text-muted questions-empty">{emptyMessage}</p>
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
                <th className="questions-col-thread">{answeredFilter === 'answered' ? 'Переписка' : 'Ответ'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => {
                const mpNorm = normalizeMarketplaceForUI(q.marketplace);
                const mpMeta = MARKETPLACE_TABLE_BADGES.find((m) => m.code === mpNorm);
                const mpLabel = mpMeta?.name ?? String(q.marketplace ?? '—');
                const buyerLabel = questionBuyerLabel(q);
                const needsReply = questionNeedsReply(q);
                return (
                  <tr key={q.id} className={needsReply ? '' : 'questions-row--archived'}>
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
                    <td className="questions-col-theme" title={formatProductArticleWithName(q)}>
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
                        variant={needsReply ? 'primary' : 'secondary'}
                        size="small"
                        onClick={() => openThread(q.id)}
                        disabled={loading || syncing}
                      >
                        {needsReply ? 'Ответить' : 'Переписка'}
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
        title={threadDetail ? `Ветка · ${formatProductArticleWithName(threadDetail)}` : 'Ветка переписки'}
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
              {!threadNeedsReply ? ' · закрыто' : ''}
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
                <QuestionTextInsertToolbar
                  textareaRef={replyTextareaRef}
                  value={threadDraft}
                  onChange={setThreadDraft}
                  disabled={threadSending}
                  mode="reply"
                  showProduct
                  organizationId={contextOrganizationId}
                  buyerNameLabel={questionBuyerLabel(threadDetail)}
                  questionProductLabel={formatProductArticleWithName(threadDetail)}
                />
                <textarea
                  ref={replyTextareaRef}
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
              <div className="questions-thread-done-wrap">
                <p className="text-muted small questions-thread-done">
                  Переписка закрыта. История сохранена в архиве.
                </p>
                <Button type="button" variant="secondary" onClick={closeThread}>
                  Закрыть
                </Button>
              </div>
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
