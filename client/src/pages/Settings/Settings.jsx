/**
 * Settings Page
 * Страница настроек приложения
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { profilesApi } from '../../services/profiles.api.js';
import { Button } from '../../components/common/Button/Button';
import './Settings.css';

export function Settings() {
  const { isProfileAdmin, profileId, refreshUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    contact_email: '',
    contact_phone: '',
    allow_private_orders: false,
  });

  const loadAccount = useCallback(async () => {
    if (!isProfileAdmin || profileId == null) return;
    setLoading(true);
    setError('');
    try {
      const res = await profilesApi.getMe();
      const p = res?.data;
      if (p) {
        setForm({
          name: p.name ?? '',
          contact_email: p.contact_email ?? '',
          contact_phone: p.contact_phone ?? '',
          allow_private_orders: p.allow_private_orders === true,
        });
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось загрузить данные аккаунта');
    } finally {
      setLoading(false);
    }
  }, [isProfileAdmin, profileId]);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const saveAccount = async () => {
    const name = form.name.trim();
    if (!name) {
      alert('Укажите название аккаунта');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await profilesApi.updateMe({
        name,
        contact_email: form.contact_email.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        allow_private_orders: form.allow_private_orders,
      });
      await refreshUser();
      alert('Сохранено');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page card">
      <h1 className="title">Настройки</h1>
      <p className="subtitle">Общие настройки системы.</p>

      {isProfileAdmin && profileId != null && (
        <section className="settings-account-section">
          <h2 className="h5">Аккаунт</h2>
          <p className="text-muted small mb-3">
            Название аккаунта, контактная почта и телефон (для связи по аккаунту; не меняет email входа в систему).
          </p>
          {loading && <p className="text-muted">Загрузка...</p>}
          {error && <p className="text-danger">{error}</p>}
          {!loading && (
            <div className="settings-account-form">
              <label className="settings-account-label">
                Название аккаунта
                <input
                  type="text"
                  className="login-input"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoComplete="organization"
                />
              </label>
              <label className="settings-account-label">
                Контактный email
                <input
                  type="email"
                  className="login-input"
                  value={form.contact_email}
                  onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                  autoComplete="email"
                />
              </label>
              <label className="settings-account-label">
                Контактный телефон
                <input
                  type="tel"
                  className="login-input"
                  value={form.contact_phone}
                  onChange={(e) => setForm((f) => ({ ...f, contact_phone: e.target.value }))}
                  autoComplete="tel"
                />
              </label>
              <label className="settings-account-toggle">
                <input
                  type="checkbox"
                  checked={form.allow_private_orders}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, allow_private_orders: e.target.checked }))
                  }
                />
                <span>
                  <strong>Выполнять частные заказы</strong>
                  <span className="text-muted small" style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}>
                    Разрешить создание заказов вручную и фильтр «Ручной» в списке заказов. При выключении частные заказы
                    не отображаются в списке.
                  </span>
                </span>
              </label>
              <div className="settings-account-actions">
                <Button type="button" variant="primary" onClick={saveAccount} disabled={saving}>
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
