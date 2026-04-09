/**
 * Админка продукта: аккаунты
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { profilesApi } from '../../services/profiles.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import './Admin.css';

function emptyProfileForm() {
  return {
    name: '',
    contact_full_name: '',
    contact_email: '',
    contact_phone: '',
    tariff: '',
  };
}

function inquiryStatusRu(s) {
  if (s === 'in_progress') return 'В работе';
  if (s === 'completed') return 'Завершён';
  return 'Новый';
}

function formatDt(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}

export function Admin() {
  const { isAdmin } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [profileModal, setProfileModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [profileForm, setProfileForm] = useState(emptyProfileForm());

  const [cabinetId, setCabinetId] = useState(null);
  const [cabinetLoading, setCabinetLoading] = useState(false);
  const [cabinetBundle, setCabinetBundle] = useState(null);
  const [cabinetForm, setCabinetForm] = useState(emptyProfileForm());

  const loadData = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError('');
    try {
      const pRes = await profilesApi.getAll();
      setProfiles(pRes?.data ?? []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!cabinetId) {
      setCabinetBundle(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setCabinetLoading(true);
      try {
        const res = await profilesApi.getCabinet(cabinetId);
        if (cancelled || !res?.ok) return;
        setCabinetBundle(res.data);
      } catch {
        if (!cancelled) setCabinetBundle(null);
      } finally {
        if (!cancelled) setCabinetLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cabinetId]);

  useEffect(() => {
    if (!cabinetBundle?.profile) return;
    const p = cabinetBundle.profile;
    setCabinetForm({
      name: p.name || '',
      contact_full_name: p.contact_full_name || '',
      contact_email: p.contact_email || '',
      contact_phone: p.contact_phone || '',
      tariff: p.tariff || '',
    });
  }, [cabinetBundle]);

  const openProfileForm = (profile = null) => {
    setEditingProfile(profile);
    if (profile) {
      setProfileForm({
        name: profile.name ?? '',
        contact_full_name: profile.contact_full_name ?? '',
        contact_email: profile.contact_email ?? '',
        contact_phone: profile.contact_phone ?? '',
        tariff: profile.tariff ?? '',
      });
    } else {
      setProfileForm(emptyProfileForm());
    }
    setProfileModal(true);
  };

  const saveProfile = async () => {
    try {
      const payload = {
        name: profileForm.name.trim(),
        contact_full_name: profileForm.contact_full_name.trim() || null,
        contact_email: profileForm.contact_email.trim() || null,
        contact_phone: profileForm.contact_phone.trim() || null,
        tariff: profileForm.tariff.trim() || null,
      };
      if (!payload.name) {
        alert('Укажите название аккаунта');
        return;
      }
      if (editingProfile) {
        await profilesApi.update(editingProfile.id, payload);
      } else {
        await profilesApi.create(payload);
      }
      setProfileModal(false);
      loadData();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    }
  };

  const saveCabinetCard = async () => {
    try {
      const payload = {
        name: cabinetForm.name.trim(),
        contact_full_name: cabinetForm.contact_full_name.trim() || null,
        contact_email: cabinetForm.contact_email.trim() || null,
        contact_phone: cabinetForm.contact_phone.trim() || null,
        tariff: cabinetForm.tariff.trim() || null,
      };
      if (!payload.name) {
        alert('Укажите название');
        return;
      }
      await profilesApi.update(cabinetId, payload);
      setCabinetId(null);
      loadData();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    }
  };

  const deleteProfile = async (id) => {
    if (!window.confirm('Удалить аккаунт? Организации и пользователи останутся без привязки.')) return;
    try {
      await profilesApi.delete(id);
      loadData();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка удаления');
    }
  };

  if (!isAdmin) {
    return (
      <div className="card">
        <p>Доступ только для администратора.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="admin-loading">Загрузка...</div>;
  }
  if (error) {
    return <div className="admin-error">Ошибка: {error}</div>;
  }

  return (
    <div className="admin-page card">
      <h1 className="title">Аккаунты</h1>
      <p className="subtitle">Все зарегистрированные аккаунты (профили клиентов)</p>

      <div className="admin-section">
        <div className="admin-section-header">
          <h2 className="h5 mb-0">Список</h2>
          <Button variant="primary" onClick={() => openProfileForm()}>
            Добавить аккаунт
          </Button>
        </div>
        <div className="table-responsive">
          <table className="table table-sm align-middle admin-accounts-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Контакт</th>
                <th>Пользователей</th>
                <th>Организаций</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-state">
                    Нет аккаунтов
                  </td>
                </tr>
              ) : (
                profiles.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.tariff && <div className="admin-muted small">Тариф: {p.tariff}</div>}
                    </td>
                    <td className="small">
                      {p.contact_full_name || '—'}
                      {(p.contact_email || p.contact_phone) && (
                        <div className="text-muted">
                          {[p.contact_email, p.contact_phone].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td>{p.users_count ?? p.usersCount ?? 0}</td>
                    <td>{p.organizations_count ?? p.organizationsCount ?? 0}</td>
                    <td className="text-nowrap">
                      <Button type="button" variant="primary" size="small" onClick={() => setCabinetId(p.id)}>
                        Открыть
                      </Button>{' '}
                      <Button type="button" variant="secondary" size="small" onClick={() => openProfileForm(p)}>
                        Быстро
                      </Button>{' '}
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        className="btn-danger"
                        onClick={() => deleteProfile(p.id)}
                      >
                        Удалить
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={profileModal}
        onClose={() => setProfileModal(false)}
        title={editingProfile ? 'Редактировать аккаунт' : 'Новый аккаунт'}
        size="medium"
      >
        <div className="admin-form">
          <label>
            Название аккаунта
            <input
              type="text"
              value={profileForm.name}
              onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))}
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <label>
            Контактное лицо
            <input
              type="text"
              value={profileForm.contact_full_name}
              onChange={(e) => setProfileForm((f) => ({ ...f, contact_full_name: e.target.value }))}
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <label>
            Тариф
            <input
              type="text"
              value={profileForm.tariff}
              onChange={(e) => setProfileForm((f) => ({ ...f, tariff: e.target.value }))}
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
              placeholder="Например: Базовый"
            />
          </label>
          <label>
            Телефон
            <input
              type="text"
              value={profileForm.contact_phone}
              onChange={(e) => setProfileForm((f) => ({ ...f, contact_phone: e.target.value }))}
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <label>
            Электронная почта
            <input
              type="text"
              value={profileForm.contact_email}
              onChange={(e) => setProfileForm((f) => ({ ...f, contact_email: e.target.value }))}
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <div className="admin-form-actions">
            <Button variant="secondary" onClick={() => setProfileModal(false)}>
              Отмена
            </Button>
            <Button variant="primary" onClick={saveProfile}>
              Сохранить
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={cabinetId != null}
        onClose={() => setCabinetId(null)}
        title={cabinetBundle?.profile?.name ? `Аккаунт: ${cabinetBundle.profile.name}` : 'Аккаунт'}
        size="large"
      >
        {cabinetLoading && <p>Загрузка...</p>}
        {!cabinetLoading && cabinetBundle && (
          <div className="admin-cabinet-detail">
            <h3 className="h6 text-muted mb-3">Реквизиты и тариф</h3>
            <div className="admin-form" style={{ marginBottom: '1.25rem' }}>
              <label>
                Название
                <input
                  type="text"
                  value={cabinetForm.name}
                  onChange={(e) => setCabinetForm((f) => ({ ...f, name: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label>
                Контактное лицо
                <input
                  type="text"
                  value={cabinetForm.contact_full_name}
                  onChange={(e) => setCabinetForm((f) => ({ ...f, contact_full_name: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label>
                Тариф
                <input
                  type="text"
                  value={cabinetForm.tariff}
                  onChange={(e) => setCabinetForm((f) => ({ ...f, tariff: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label>
                Телефон
                <input
                  type="text"
                  value={cabinetForm.contact_phone}
                  onChange={(e) => setCabinetForm((f) => ({ ...f, contact_phone: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label>
                Электронная почта
                <input
                  type="text"
                  value={cabinetForm.contact_email}
                  onChange={(e) => setCabinetForm((f) => ({ ...f, contact_email: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <div className="admin-form-actions">
                <Button variant="secondary" onClick={() => setCabinetId(null)}>
                  Закрыть
                </Button>
                <Button variant="primary" onClick={saveCabinetCard}>
                  Сохранить
                </Button>
              </div>
            </div>

            <div className="admin-cabinet-stats mb-3">
              <span className="badge bg-light text-dark me-2">
                Пользователей: {cabinetBundle.usersCount ?? 0}
              </span>
              <span className="badge bg-light text-dark">
                Организаций: {cabinetBundle.organizationsCount ?? 0}
              </span>
            </div>

            <h3 className="h6 text-muted mb-2">История обращений</h3>
            {(cabinetBundle.inquiries || []).length === 0 ? (
              <p className="text-muted small">Обращений пока нет.</p>
            ) : (
              <div className="table-responsive">
                <table className="table table-sm table-bordered">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Статус</th>
                      <th>Автор</th>
                      <th>Текст</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cabinetBundle.inquiries.map((q) => (
                      <tr key={q.id}>
                        <td className="text-nowrap small">{formatDt(q.created_at)}</td>
                        <td>{inquiryStatusRu(q.status)}</td>
                        <td className="small">
                          {q.author_email}
                          {q.author_full_name && <span className="text-muted"> — {q.author_full_name}</span>}
                        </td>
                        <td style={{ maxWidth: 280 }}>
                          <span className="small" style={{ whiteSpace: 'pre-wrap' }}>
                            {(q.body_text || '').slice(0, 400)}
                            {(q.body_text || '').length > 400 ? '…' : ''}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
