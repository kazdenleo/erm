/**
 * Вкладка «Заявки» — заявки покупателей на возврат с решением продавца (Ozon / WB / YM).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../common/Button/Button';
import { Modal } from '../common/Modal/Modal';
import { marketplaceReturnClaimsApi } from '../../services/marketplaceReturnClaims.api';
import { MARKETPLACE_TABLE_BADGES } from '../../constants/marketplaceUi';
import { normalizeMarketplaceForUI } from '../../utils/orderListGroupKey';
import '../../pages/Returns/Returns.css';

function bumpClaimsStats() {
  window.dispatchEvent(new Event('marketplace-return-claims-stats-refresh'));
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

function formatMoney(price, currency) {
  if (price == null || !Number.isFinite(Number(price))) return '—';
  const n = Number(price);
  if (currency === '643' || currency === 'RUB' || !currency) {
    return `${n.toLocaleString('ru-RU')} ₽`;
  }
  return `${n.toLocaleString('ru-RU')} ${currency}`;
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

function photoUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (s.startsWith('//')) return `https:${s}`;
  return s;
}

function selectedActionMeta(actions, actionId) {
  if (!actionId) return null;
  return (actions || []).find((a) => String(a.id) === String(actionId) || String(a.code) === String(actionId)) || null;
}

export function MarketplaceReturnClaimsPanel({ embedded = false }) {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [syncInfo, setSyncInfo] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [decisionFilter, setDecisionFilter] = useState('pending');
  const [stats, setStats] = useState({
    pendingCount: 0,
    counts: { all: 0, pending: 0, done: 0 },
    countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
  });

  const [modalId, setModalId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionId, setActionId] = useState('');
  const [comment, setComment] = useState('');
  const [rejectionReasonId, setRejectionReasonId] = useState('');
  const [decisionReasonType, setDecisionReasonType] = useState('');
  const [compensationAmount, setCompensationAmount] = useState('');
  const [returnForBackWay, setReturnForBackWay] = useState('');
  const [sending, setSending] = useState(false);
  const [decideError, setDecideError] = useState('');

  const loadStats = useCallback(async () => {
    try {
      const s = await marketplaceReturnClaimsApi.getStats({
        marketplace: marketplaceFilter !== 'all' ? marketplaceFilter : undefined,
      });
      setStats(s);
    } catch {
      setStats({
        pendingCount: 0,
        counts: { all: 0, pending: 0, done: 0 },
        countsByMarketplace: { ozon: 0, wildberries: 0, yandex: 0 },
      });
    }
  }, [marketplaceFilter]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const rows = await marketplaceReturnClaimsApi.getAll({
        marketplace: marketplaceFilter !== 'all' ? marketplaceFilter : undefined,
        decision: decisionFilter,
        limit: 200,
      });
      setItems(Array.isArray(rows) ? rows : []);
      bumpClaimsStats();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить заявки');
      setItems([]);
    } finally {
      setLoading(false);
      loadStats();
    }
  }, [marketplaceFilter, decisionFilter, loadStats]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load();
  }, [load]);

  const onSync = async () => {
    try {
      setSyncing(true);
      setSyncInfo('');
      setError('');
      const data = await marketplaceReturnClaimsApi.sync(
        marketplaceFilter !== 'all' ? { marketplace: marketplaceFilter } : {}
      );
      const results = Array.isArray(data?.results) ? data.results : [];
      const parts = results.map((r) => {
        const name = r.marketplace === 'wildberries' ? 'WB' : r.marketplace === 'yandex' ? 'ЯМ' : 'Ozon';
        return r.ok ? `${name}: ${r.imported}` : `${name}: ошибка`;
      });
      setSyncInfo(parts.length ? `Синхронизация: ${parts.join(', ')}` : 'Синхронизация завершена');
      await loadRef.current();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Ошибка синхронизации');
    } finally {
      setSyncing(false);
    }
  };

  const openDecide = async (row) => {
    setModalId(String(row.id));
    setDetail(null);
    setDetailLoading(true);
    setDecideError('');
    setActionId('');
    setComment('');
    setRejectionReasonId('');
    setDecisionReasonType('');
    setCompensationAmount('');
    setReturnForBackWay('');
    try {
      const fresh = await marketplaceReturnClaimsApi.getOne(row.id, { refresh: true });
      setDetail(fresh || row);
      const actions = fresh?.availableActions || row.availableActions || [];
      if (actions.length === 1) setActionId(String(actions[0].id));
    } catch (e) {
      setDetail(row);
      setDecideError(e?.response?.data?.message || e?.message || 'Не удалось обновить заявку');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeModal = (force = false) => {
    if (sending && !force) return;
    setModalId(null);
    setDetail(null);
    setDecideError('');
  };

  const active = detail;
  const actions = useMemo(() => (Array.isArray(active?.availableActions) ? active.availableActions : []), [active]);
  const rejectionReasons = useMemo(
    () => (Array.isArray(active?.rejectionReasons) ? active.rejectionReasons : []),
    [active]
  );
  const actionMeta = selectedActionMeta(actions, actionId);
  const reasonOptions = useMemo(() => {
    if (active?.marketplace === 'yandex') {
      return Array.isArray(actionMeta?.decisionReasonTypes) ? actionMeta.decisionReasonTypes : [];
    }
    return rejectionReasons;
  }, [active, actionMeta, rejectionReasons]);

  const submitDecision = async () => {
    if (!modalId || !actionId) {
      setDecideError('Выберите действие');
      return;
    }
    if (actionMeta?.commentRequired && String(comment || '').trim().length < 10) {
      setDecideError('Нужен комментарий (не короче 10 символов)');
      return;
    }
    if (
      (actionMeta?.requiresRejectionReason || String(actionId) === '-1' || String(actionId) === '-10') &&
      active?.marketplace === 'ozon' &&
      !rejectionReasonId
    ) {
      setDecideError('Выберите причину отклонения');
      return;
    }
    if (String(actionId).toUpperCase() === 'DECLINE_REFUND' && !decisionReasonType && reasonOptions.length > 0) {
      setDecideError('Выберите причину отказа');
      return;
    }

    try {
      setSending(true);
      setDecideError('');
      const body = { action: actionId };
      if (comment.trim()) body.comment = comment.trim();
      if (rejectionReasonId) body.rejectionReasonId = rejectionReasonId;
      if (decisionReasonType) body.decisionReasonType = decisionReasonType;
      if (compensationAmount.trim()) body.compensationAmount = compensationAmount.trim();
      if (returnForBackWay.trim()) body.returnForBackWay = returnForBackWay.trim();
      await marketplaceReturnClaimsApi.decide(modalId, body);
      setSending(false);
      closeModal(true);
      bumpClaimsStats();
      await loadRef.current();
    } catch (e) {
      setDecideError(e?.response?.data?.message || e?.message || 'Не удалось отправить решение');
    } finally {
      setSending(false);
    }
  };

  const mpCounts = stats.countsByMarketplace || { ozon: 0, wildberries: 0, yandex: 0 };
  const mpTotalPending = mpCounts.ozon + mpCounts.wildberries + mpCounts.yandex;

  return (
    <section className={`mp-returns-page mp-claims-page${embedded ? ' mp-returns-page--embedded' : ''}`}>
      <div className="mp-returns-embedded-toolbar">
        <p className="mp-returns-summary mp-claims-hint">
          Заявки покупателей на возврат — можно одобрить, отклонить или выбрать другое доступное решение
          маркетплейса.
        </p>
        <div className="mp-claims-toolbar-actions">
          <Button type="button" variant="secondary" size="small" onClick={() => loadRef.current()} disabled={loading || syncing}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </Button>
          <Button type="button" size="small" onClick={onSync} disabled={loading || syncing}>
            {syncing ? 'Синхронизация…' : 'Синхронизировать'}
          </Button>
        </div>
      </div>

      <div className="mp-returns-toolbar">
        <div className="erp-filter-row" role="group" aria-label="Фильтр по статусу">
          <button
            type="button"
            className={`erp-filter-btn${decisionFilter === 'pending' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setDecisionFilter('pending')}
            disabled={loading}
          >
            Ждут решения
            <span className="erp-filter-btn__count">{stats.counts?.pending ?? 0}</span>
          </button>
          <button
            type="button"
            className={`erp-filter-btn${decisionFilter === 'done' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setDecisionFilter('done')}
            disabled={loading}
          >
            Обработанные
            <span className="erp-filter-btn__count">{stats.counts?.done ?? 0}</span>
          </button>
          <button
            type="button"
            className={`erp-filter-btn${decisionFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setDecisionFilter('all')}
            disabled={loading}
          >
            Все
            <span className="erp-filter-btn__count">{stats.counts?.all ?? 0}</span>
          </button>
        </div>

        <div className="erp-filter-row" role="group" aria-label="Фильтр по маркетплейсу">
          <button
            type="button"
            className={`erp-filter-btn${marketplaceFilter === 'all' ? ' erp-filter-btn--active' : ''}`}
            onClick={() => setMarketplaceFilter('all')}
            disabled={loading}
          >
            Все МП
            <span className="erp-filter-btn__count">{mpTotalPending}</span>
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

        {syncInfo ? <p className="mp-returns-summary">{syncInfo}</p> : null}
      </div>

      {error ? <div className="alert alert-danger mp-returns-error">{error}</div> : null}

      {loading && items.length === 0 ? <p className="mp-returns-empty">Загрузка заявок…</p> : null}
      {!loading && !error && items.length === 0 ? (
        <p className="mp-returns-empty">
          {decisionFilter === 'pending'
            ? 'Нет заявок, ждущих решения. Нажмите «Синхронизировать», чтобы подтянуть с маркетплейсов.'
            : 'Нет заявок по выбранному фильтру.'}
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="table-responsive mp-returns-table-wrap">
          <table className="table mp-returns-table">
            <thead>
              <tr>
                <th>МП</th>
                <th>Статус</th>
                <th>Товар / SKU</th>
                <th>Комментарий покупателя</th>
                <th>Сумма</th>
                <th>Заказ</th>
                <th>Дата</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={`${row.marketplace}-${row.id}`}
                  className={row.needsDecision ? 'mp-returns-row-waiting' : ''}
                >
                  <td>{mpBadge(row.marketplace)}</td>
                  <td>
                    <span className={`mp-returns-status${row.needsDecision ? ' is-waiting' : ''}`}>
                      {row.status || (row.needsDecision ? 'Ждёт решения' : 'Обработана')}
                    </span>
                    {row.reason ? <div className="mp-returns-sub">{row.reason}</div> : null}
                  </td>
                  <td>
                    <div>{row.productName || '—'}</div>
                    <div className="mp-returns-sub">{row.skuOrOffer || '—'}</div>
                  </td>
                  <td>
                    <div className="mp-claims-comment">{row.buyerComment || '—'}</div>
                  </td>
                  <td>{formatMoney(row.price, row.currency)}</td>
                  <td>{row.orderId || '—'}</td>
                  <td>{formatDt(row.sourceCreatedAt)}</td>
                  <td className="mp-returns-actions-cell">
                    {row.needsDecision ? (
                      <Button type="button" size="small" onClick={() => openDecide(row)}>
                        Решить
                      </Button>
                    ) : (
                      <span className="mp-returns-sub">{row.sellerComment || '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal
        isOpen={Boolean(modalId)}
        onClose={() => closeModal(false)}
        title={
          active ? (
            <span className="questions-modal-title">
              {mpBadge(active.marketplace)}
              <span className="questions-modal-title__text">
                {active.productName || active.skuOrOffer || `Заявка ${active.externalId}`}
              </span>
            </span>
          ) : (
            'Решение по заявке'
          )
        }
      >
        {detailLoading && !active ? <p>Загрузка…</p> : null}
        {active ? (
          <div className="mp-claims-modal">
            <div className="mp-claims-modal__meta">
              <div>
                <strong>Заказ:</strong> {active.orderId || '—'}
              </div>
              <div>
                <strong>SKU:</strong> {active.skuOrOffer || '—'}
              </div>
              <div>
                <strong>Сумма:</strong> {formatMoney(active.price, active.currency)}
              </div>
              <div>
                <strong>Статус:</strong> {active.status || '—'}
              </div>
            </div>

            {active.buyerComment ? (
              <div className="mp-claims-modal__block">
                <div className="mp-claims-modal__label">Комментарий покупателя</div>
                <div>{active.buyerComment}</div>
              </div>
            ) : null}

            {active.reason ? (
              <div className="mp-claims-modal__block">
                <div className="mp-claims-modal__label">Причина</div>
                <div>{active.reason}</div>
              </div>
            ) : null}

            {Array.isArray(active.photos) && active.photos.length > 0 ? (
              <div className="mp-claims-modal__photos">
                {active.photos.map((p) => {
                  const src = photoUrl(p);
                  if (!src || !/^https?:/i.test(src)) return null;
                  return (
                    <a key={src} href={src} target="_blank" rel="noreferrer">
                      <img src={src} alt="" />
                    </a>
                  );
                })}
              </div>
            ) : null}

            <div className="mp-claims-modal__block">
              <div className="mp-claims-modal__label">Действие</div>
              {actions.length === 0 ? (
                <p className="mp-returns-sub">
                  Нет доступных действий от маркетплейса. Обновите заявку или проверьте статус в кабинете.
                </p>
              ) : (
                <select
                  className="warehouse-ops-select mp-claims-select"
                  value={actionId}
                  onChange={(e) => {
                    setActionId(e.target.value);
                    setDecisionReasonType('');
                  }}
                  disabled={sending}
                >
                  <option value="">— Выберите —</option>
                  {actions.map((a) => (
                    <option key={String(a.id)} value={String(a.id)}>
                      {a.label || a.code || a.id}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {reasonOptions.length > 0 ? (
              <div className="mp-claims-modal__block">
                <div className="mp-claims-modal__label">
                  {active.marketplace === 'yandex' ? 'Причина отказа' : 'Причина отклонения'}
                </div>
                <select
                  className="warehouse-ops-select mp-claims-select"
                  value={active.marketplace === 'yandex' ? decisionReasonType : rejectionReasonId}
                  onChange={(e) => {
                    if (active.marketplace === 'yandex') setDecisionReasonType(e.target.value);
                    else setRejectionReasonId(e.target.value);
                  }}
                  disabled={sending}
                >
                  <option value="">— Выберите —</option>
                  {reasonOptions.map((r) => (
                    <option key={String(r.id)} value={String(r.id)}>
                      {r.label || r.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {(actionMeta?.requiresCompensation ||
              String(actionId).toUpperCase() === 'PARTIAL_MONEY_REFUND' ||
              String(actionId) === '1020') && (
              <div className="mp-claims-modal__block">
                <div className="mp-claims-modal__label">Сумма компенсации</div>
                <input
                  type="number"
                  className="warehouse-ops-select mp-claims-select"
                  value={compensationAmount}
                  onChange={(e) => setCompensationAmount(e.target.value)}
                  disabled={sending}
                  min="0"
                  step="0.01"
                />
              </div>
            )}

            {active.marketplace === 'ozon' && (
              <div className="mp-claims-modal__block">
                <div className="mp-claims-modal__label">Возврат стоимости обратной доставки (опц.)</div>
                <input
                  type="number"
                  className="warehouse-ops-select mp-claims-select"
                  value={returnForBackWay}
                  onChange={(e) => setReturnForBackWay(e.target.value)}
                  disabled={sending}
                  min="0"
                  step="0.01"
                />
              </div>
            )}

            <div className="mp-claims-modal__block">
              <div className="mp-claims-modal__label">
                Комментарий
                {actionMeta?.commentRequired || actionMeta?.requiresComment ? ' *' : ' (если нужен)'}
              </div>
              <textarea
                className="mp-claims-textarea"
                rows={4}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={sending}
                placeholder="Текст для покупателя / причина решения"
              />
            </div>

            {decideError ? <div className="alert alert-danger">{decideError}</div> : null}

            <div className="mp-claims-modal__actions">
              <Button type="button" variant="secondary" onClick={() => closeModal(false)} disabled={sending}>
                Отмена
              </Button>
              <Button type="button" onClick={submitDecision} disabled={sending || !actionId || actions.length === 0}>
                {sending ? 'Отправка…' : 'Отправить решение'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
