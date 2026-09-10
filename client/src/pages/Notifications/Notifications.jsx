/**
 * Notifications Page
 * Уведомления по интеграциям (токены и т.д.)
 */

import React, { useEffect, useMemo, useState } from 'react';
import { integrationsApi } from '../../services/integrations.api';
import { Button } from '../../components/common/Button/Button';
import { useNavigate } from 'react-router-dom';
import { rewriteLegacyProductCardUrl } from '../../utils/productCardPath.js';
import { notifyNotificationsChanged } from '../../hooks/useNotificationsCount';

function notificationOpenUrl(n) {
  const direct = String(n?.meta?.url || n?.meta?.link || '').trim();
  const sid = n?.meta?.session_id ?? n?.meta?.sessionId ?? null;
  if (n?.type === 'inventory_session_invite' && sid != null && String(sid).trim() !== '') {
    return `/stock-levels/warehouse?op=inventory&inv_session=${encodeURIComponent(String(sid).trim())}`;
  }
  if (n?.type === 'receipt_session_invite' && sid != null && String(sid).trim() !== '') {
    return `/stock-levels/warehouse?op=receipts_list&session=${encodeURIComponent(String(sid).trim())}`;
  }
  const receiptId = n?.meta?.receipt_id ?? n?.meta?.receiptId ?? null;
  if (n?.type === 'purchase_receipt_invite' && receiptId != null && String(receiptId).trim() !== '') {
    return `/stock-levels/purchases?purchase_receipt=${encodeURIComponent(String(receiptId).trim())}`;
  }
  if (n?.type === 'employee_birthday_soon') {
    return '/settings/users';
  }
  if (direct) return rewriteLegacyProductCardUrl(direct);
  if (sid != null && String(sid).trim() !== '') {
    return `/stock-levels/warehouse?op=receipts_list&session=${encodeURIComponent(String(sid).trim())}`;
  }
  return '';
}

function notificationOpenLabel(n) {
  if (n?.type === 'inventory_session_invite') return 'Открыть инвентаризацию';
  if (n?.type === 'receipt_session_invite') return 'Открыть приёмку';
  if (n?.type === 'purchase_receipt_invite') return 'Открыть приёмку';
  if (n?.type === 'competitor_price_below_cost') return 'Открыть товар';
  if (n?.type === 'mp_card_field_changed') return 'Открыть товар';
  if (n?.type === 'supplier_order_submit_failed') return 'Открыть заказы';
  if (n?.type === 'employee_birthday_soon') return 'Пользователи';
  return 'Открыть';
}

function formatNotificationDate(v) {
  if (v == null || v === '') return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function notificationCreatedAt(n) {
  return n?.created_at || n?.createdAt || n?.checked_at || null;
}

export function Notifications() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [marking, setMarking] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await integrationsApi.getNotifications({ warn_days: 10 });
      const list = Array.isArray(data) ? data : data?.data || [];
      setItems(list);
      setSelected(new Set());
      notifyNotificationsChanged();
    } catch (e) {
      setError(e?.message || 'Ошибка загрузки уведомлений');
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const itemIds = useMemo(
    () => items.map((n) => String(n?.id || '')).filter(Boolean),
    [items]
  );
  const allSelected = itemIds.length > 0 && itemIds.every((id) => selected.has(id));
  const selectedCount = itemIds.filter((id) => selected.has(id)).length;

  const toggleOne = (id) => {
    const key = String(id || '');
    if (!key) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(itemIds));
  };

  const markSelectedViewed = async () => {
    const ids = itemIds.filter((id) => selected.has(id));
    if (!ids.length) return;
    try {
      setMarking(true);
      setError('');
      await integrationsApi.dismissNotifications(ids);
      setItems((prev) => prev.filter((n) => !ids.includes(String(n?.id || ''))));
      setSelected(new Set());
      notifyNotificationsChanged();
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось отметить просмотренными');
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="card">
      <h1 className="title">Уведомления</h1>
      <p className="subtitle">Важные события по интеграциям и системе</p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <Button type="button" variant="secondary" onClick={load} disabled={loading || marking}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
        {!loading && items.length > 0 ? (
          <>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={marking} />
              Выбрать все
            </label>
            <Button
              type="button"
              onClick={markSelectedViewed}
              disabled={marking || selectedCount === 0}
              title="Просмотренные уведомления удаляются из списка"
            >
              {marking
                ? 'Сохранение…'
                : selectedCount > 0
                  ? `Отметить просмотренными (${selectedCount})`
                  : 'Отметить просмотренными'}
            </Button>
          </>
        ) : null}
      </div>

      {error && (
        <div className="error" style={{ marginBottom: '12px' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="loading">Загрузка уведомлений...</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--muted)' }}>Уведомлений нет.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.map((n) => {
            const id = String(n?.id || '');
            const checked = id ? selected.has(id) : false;
            const openUrl = notificationOpenUrl(n);
            const createdLabel = formatNotificationDate(notificationCreatedAt(n));
            return (
              <div
                key={id || `${n.type}_${n.title}`}
                style={{
                  padding: '12px',
                  borderRadius: '10px',
                  border: '1px solid var(--border, #e5e7eb)',
                  background:
                    n.severity === 'error'
                      ? 'rgba(239, 68, 68, 0.06)'
                      : n.severity === 'warn'
                        ? 'rgba(245, 158, 11, 0.08)'
                        : 'rgba(59, 130, 246, 0.06)',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!id || marking}
                  onChange={() => toggleOne(id)}
                  aria-label="Выбрать уведомление"
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '12px',
                      flexWrap: 'wrap',
                      alignItems: 'baseline',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{n.title || 'Уведомление'}</div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'baseline',
                        fontSize: '12px',
                        color: 'var(--muted)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {n.marketplace ? <span>{String(n.marketplace)}</span> : null}
                      {createdLabel ? <span title="Время создания">Создано: {createdLabel}</span> : null}
                    </div>
                  </div>
                  <div style={{ marginTop: '6px', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{n.message}</div>
                  {openUrl ? (
                    <div style={{ marginTop: '10px' }}>
                      <Button type="button" onClick={() => navigate(openUrl)}>
                        {notificationOpenLabel(n)}
                      </Button>
                    </div>
                  ) : null}
                  {(n.expires_at || n.checked_at) && (
                    <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--muted)' }}>
                      {n.expires_at && (
                        <span>expires_at: {String(n.expires_at).slice(0, 19).replace('T', ' ')}</span>
                      )}
                      {n.expires_at && n.checked_at && <span style={{ margin: '0 8px' }}>•</span>}
                      {n.checked_at && (
                        <span>checked_at: {String(n.checked_at).slice(0, 19).replace('T', ' ')}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
