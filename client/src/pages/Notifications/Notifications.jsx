/**
 * Notifications Page
 * Уведомления по интеграциям (токены и т.д.)
 */

import React, { useEffect, useState } from 'react';
import { integrationsApi } from '../../services/integrations.api';
import { Button } from '../../components/common/Button/Button';

export function Notifications() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await integrationsApi.getNotifications({ warn_days: 10 });
      setItems(Array.isArray(data) ? data : (data?.data || []));
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

  return (
    <div className="card">
      <h1 className="title">Уведомления</h1>
      <p className="subtitle">Важные события по интеграциям и системе</p>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <Button type="button" variant="secondary" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
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
          {items.map((n) => (
            <div
              key={n.id}
              style={{
                padding: '12px',
                borderRadius: '10px',
                border: '1px solid var(--border, #e5e7eb)',
                background: n.severity === 'error'
                  ? 'rgba(239, 68, 68, 0.06)'
                  : n.severity === 'warn'
                    ? 'rgba(245, 158, 11, 0.08)'
                    : 'rgba(59, 130, 246, 0.06)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{n.title || 'Уведомление'}</div>
                {n.marketplace && (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{String(n.marketplace)}</div>
                )}
              </div>
              <div style={{ marginTop: '6px', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                {n.message}
              </div>
              {(n.expires_at || n.checked_at) && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--muted)' }}>
                  {n.expires_at && <span>expires_at: {String(n.expires_at).slice(0, 19).replace('T', ' ')}</span>}
                  {n.expires_at && n.checked_at && <span style={{ margin: '0 8px' }}>•</span>}
                  {n.checked_at && <span>checked_at: {String(n.checked_at).slice(0, 19).replace('T', ' ')}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

