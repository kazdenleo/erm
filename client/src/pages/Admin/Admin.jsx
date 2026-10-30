/**
 * Админка продукта: аккаунты
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { profilesApi } from '../../services/profiles.api.js';
import api from '../../services/api.js';
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
    subscription_status: 'trial',
    plan_code: 'business',
    trial_ends_at: '',
    subscription_ends_at: '',
    supplier_sync_enabled: true,
    product_enrichment_enabled: false,
  };
}

function subscriptionStatusRu(s) {
  if (s === 'trial') return 'Пробный';
  if (s === 'active') return 'Активен';
  if (s === 'past_due') return 'Нужна оплата';
  if (s === 'suspended') return 'Приостановлен';
  return s || '—';
}

function planCodeRu(c) {
  if (c === 'start') return 'Старт';
  if (c === 'business') return 'Бизнес';
  if (c === 'pro') return 'Про';
  return c || '—';
}

function inquiryStatusRu(s) {
  if (s === 'in_progress') return 'В работе';
  if (s === 'completed') return 'Завершён';
  return 'Новый';
}

function billingRequestStatusRu(s) {
  if (s === 'pending') return 'Ожидает';
  if (s === 'approved') return 'Одобрена';
  if (s === 'rejected') return 'Отклонена';
  if (s === 'cancelled') return 'Отменена';
  return s || '—';
}

function formatDt(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}

/** Человекочитаемый размер данных аккаунта (оценка по shared DB). */
function formatStorageSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function formatRows(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU');
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

  const [storageTarget, setStorageTarget] = useState(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [storageBreakdown, setStorageBreakdown] = useState(null);

  const [billingRequests, setBillingRequests] = useState([]);
  const [billingBusyId, setBillingBusyId] = useState(null);

  const loadBillingRequests = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await api.get('/billing/admin/requests', { params: { status: 'pending' } });
      setBillingRequests(res.data?.data || []);
    } catch {
      setBillingRequests([]);
    }
  }, [isAdmin]);

  const loadData = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError('');
    try {
      const pRes = await profilesApi.getAll();
      setProfiles(pRes?.data ?? []);
      await loadBillingRequests();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, loadBillingRequests]);

  const approveBillingRequest = async (id) => {
    if (!window.confirm('Активировать тариф по заявке? Срок подписки продлится на месяц или год.')) {
      return;
    }
    setBillingBusyId(id);
    try {
      await api.post(`/billing/admin/requests/${id}/approve`);
      await loadData();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка активации');
    } finally {
      setBillingBusyId(null);
    }
  };

  const rejectBillingRequest = async (id) => {
    const note = window.prompt('Причина отклонения (необязательно):') ?? '';
    setBillingBusyId(id);
    try {
      await api.post(`/billing/admin/requests/${id}/reject`, { adminNote: note });
      await loadBillingRequests();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка отклонения');
    } finally {
      setBillingBusyId(null);
    }
  };

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
      subscription_status: p.subscription_status || 'active',
      plan_code: p.plan_code || '',
      trial_ends_at: p.trial_ends_at ? String(p.trial_ends_at).slice(0, 16) : '',
      subscription_ends_at: p.subscription_ends_at
        ? String(p.subscription_ends_at).slice(0, 16)
        : '',
      supplier_sync_enabled: p.supplier_sync_enabled !== false,
      product_enrichment_enabled: p.product_enrichment_enabled === true,
    });
  }, [cabinetBundle]);

  useEffect(() => {
    if (!storageTarget?.id) {
      setStorageBreakdown(null);
      setStorageError('');
      return;
    }
    let cancelled = false;
    (async () => {
      setStorageLoading(true);
      setStorageError('');
      setStorageBreakdown(null);
      try {
        const res = await profilesApi.getStorageBreakdown(storageTarget.id);
        if (cancelled) return;
        if (!res?.ok) {
          setStorageError(res?.message || 'Не удалось загрузить разбивку');
          return;
        }
        setStorageBreakdown(res.data);
      } catch (err) {
        if (!cancelled) {
          setStorageError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
        }
      } finally {
        if (!cancelled) setStorageLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storageTarget]);

  const openStorageBreakdown = (profileId, profileName) => {
    if (profileId == null) return;
    setStorageTarget({ id: profileId, name: profileName || '' });
  };

  const openProfileForm = (profile = null) => {
    setEditingProfile(profile);
    if (profile) {
      setProfileForm({
        name: profile.name ?? '',
        contact_full_name: profile.contact_full_name ?? '',
        contact_email: profile.contact_email ?? '',
        contact_phone: profile.contact_phone ?? '',
        tariff: profile.tariff ?? '',
        subscription_status: profile.subscription_status || 'active',
        plan_code: profile.plan_code || '',
        trial_ends_at: profile.trial_ends_at
          ? String(profile.trial_ends_at).slice(0, 16)
          : '',
        subscription_ends_at: profile.subscription_ends_at
          ? String(profile.subscription_ends_at).slice(0, 16)
          : '',
        supplier_sync_enabled: profile.supplier_sync_enabled !== false,
        product_enrichment_enabled: profile.product_enrichment_enabled === true,
      });
    } else {
      setProfileForm(emptyProfileForm());
    }
    setProfileModal(true);
  };

  const buildSubscriptionPayload = (form) => ({
    subscription_status: form.subscription_status || 'active',
    plan_code: form.plan_code || null,
    trial_ends_at: form.trial_ends_at
      ? new Date(form.trial_ends_at).toISOString()
      : null,
    subscription_ends_at: form.subscription_ends_at
      ? new Date(form.subscription_ends_at).toISOString()
      : null,
  });

  const saveProfile = async () => {
    try {
      const payload = {
        name: profileForm.name.trim(),
        contact_full_name: profileForm.contact_full_name.trim() || null,
        contact_email: profileForm.contact_email.trim() || null,
        contact_phone: profileForm.contact_phone.trim() || null,
        tariff: profileForm.tariff.trim() || null,
        ...buildSubscriptionPayload(profileForm),
        supplier_sync_enabled: profileForm.supplier_sync_enabled === true,
        product_enrichment_enabled: profileForm.product_enrichment_enabled === true,
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
        ...buildSubscriptionPayload(cabinetForm),
        supplier_sync_enabled: cabinetForm.supplier_sync_enabled === true,
        product_enrichment_enabled: cabinetForm.product_enrichment_enabled === true,
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

  const toggleEnrichment = async (profile) => {
    const next = profile.product_enrichment_enabled !== true;
    try {
      await profilesApi.update(profile.id, { product_enrichment_enabled: next });
      setProfiles((list) =>
        list.map((p) =>
          p.id === profile.id ? { ...p, product_enrichment_enabled: next } : p
        )
      );
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Не удалось изменить обогащение');
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

      {billingRequests.length > 0 ? (
        <div className="admin-section mb-4">
          <div className="admin-section-header">
            <h2 className="h5 mb-0">Заявки на тариф ({billingRequests.length})</h2>
            <Button type="button" variant="secondary" onClick={loadBillingRequests}>
              Обновить
            </Button>
          </div>
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Аккаунт</th>
                  <th>Тариф</th>
                  <th>Сумма</th>
                  <th>Кто запросил</th>
                  <th>Сейчас</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {billingRequests.map((r) => (
                  <tr key={r.id}>
                    <td className="small text-nowrap">{formatDt(r.createdAt)}</td>
                    <td>
                      <strong>{r.profileName || r.profileId}</strong>
                      <div className="text-muted small">
                        {[r.profileContactEmail, r.profileContactPhone].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      {r.planName} / {r.period === 'year' ? 'год' : 'мес'}
                      <div className="text-muted small">{billingRequestStatusRu(r.status)}</div>
                    </td>
                    <td>
                      {r.amountRub != null
                        ? `${Number(r.amountRub).toLocaleString('ru-RU')} ₽`
                        : '—'}
                    </td>
                    <td className="small">
                      {r.requesterName || r.requesterEmail || r.requesterPhone || '—'}
                    </td>
                    <td className="small">
                      {subscriptionStatusRu(r.profileSubscriptionStatus)}
                      {' · '}
                      {planCodeRu(r.profilePlanCode)}
                    </td>
                    <td className="text-nowrap">
                      <Button
                        type="button"
                        variant="primary"
                        disabled={billingBusyId === r.id}
                        onClick={() => approveBillingRequest(r.id)}
                      >
                        Активировать
                      </Button>{' '}
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={billingBusyId === r.id}
                        onClick={() => rejectBillingRequest(r.id)}
                      >
                        Отклонить
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

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
                <th>Товаров</th>
                <th title="Оценка объёма данных аккаунта в общей БД">Размер данных</th>
                <th>Поставщики</th>
                <th>Обогащение</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.length === 0 ? (
                <tr>
                  <td colSpan={9} className="empty-state">
                    Нет аккаунтов
                  </td>
                </tr>
              ) : (
                profiles.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <div className="admin-muted small">
                        {subscriptionStatusRu(p.subscription_status)}
                        {' · '}
                        {planCodeRu(p.plan_code) || p.tariff || '—'}
                      </div>
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
                    <td>{p.products_count ?? p.productsCount ?? 0}</td>
                    <td>
                      <button
                        type="button"
                        className="admin-storage-link"
                        title="Подробная разбивка размера данных"
                        onClick={() => openStorageBreakdown(p.id, p.name)}
                      >
                        {formatStorageSize(p.storage_bytes ?? p.storageBytes)}
                      </button>
                    </td>
                    <td>
                      {p.supplier_sync_enabled !== false ? (
                        <span className="badge bg-success">вкл</span>
                      ) : (
                        <span className="badge bg-secondary">выкл</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`badge border-0 ${
                          p.product_enrichment_enabled === true ? 'bg-success' : 'bg-secondary'
                        }`}
                        style={{ cursor: 'pointer' }}
                        title="Нажмите, чтобы включить/выключить"
                        onClick={() => toggleEnrichment(p)}
                      >
                        {p.product_enrichment_enabled === true ? 'вкл' : 'выкл'}
                      </button>
                    </td>
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
            Статус подписки
            <select
              className="form-select form-select-sm mt-1"
              value={profileForm.subscription_status}
              onChange={(e) =>
                setProfileForm((f) => ({ ...f, subscription_status: e.target.value }))
              }
            >
              <option value="trial">Пробный</option>
              <option value="active">Активен</option>
              <option value="past_due">Нужна оплата</option>
              <option value="suspended">Приостановлен</option>
            </select>
          </label>
          <label>
            Тариф (план)
            <select
              className="form-select form-select-sm mt-1"
              value={profileForm.plan_code || ''}
              onChange={(e) => setProfileForm((f) => ({ ...f, plan_code: e.target.value }))}
            >
              <option value="">— не выбран —</option>
              <option value="start">Старт</option>
              <option value="business">Бизнес</option>
              <option value="pro">Про</option>
            </select>
          </label>
          <label>
            Конец trial
            <input
              type="datetime-local"
              value={profileForm.trial_ends_at}
              onChange={(e) => setProfileForm((f) => ({ ...f, trial_ends_at: e.target.value }))}
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <label>
            Конец оплаченного периода
            <input
              type="datetime-local"
              value={profileForm.subscription_ends_at}
              onChange={(e) =>
                setProfileForm((f) => ({ ...f, subscription_ends_at: e.target.value }))
              }
              className="login-input"
              style={{ width: '100%', marginTop: '4px' }}
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
          <label className="d-flex align-items-center gap-2 mt-2 mb-0" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={profileForm.supplier_sync_enabled === true}
              onChange={(e) =>
                setProfileForm((f) => ({ ...f, supplier_sync_enabled: e.target.checked }))
              }
            />
            <span>Интеграция с поставщиками</span>
          </label>
          <p className="text-muted small mb-0">
            Если выключено: в аккаунте скрывается вкладка «Поставщики» в «Интеграциях», колонка поставщиков в остатках
            и фоновая синхронизация остатков для этого аккаунта.
          </p>
          <label className="d-flex align-items-center gap-2 mt-2 mb-0" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={profileForm.product_enrichment_enabled === true}
              onChange={(e) =>
                setProfileForm((f) => ({ ...f, product_enrichment_enabled: e.target.checked }))
              }
            />
            <span>Обогащение карточек (PartsIndex)</span>
          </label>
          <p className="text-muted small mb-0">
            Если включено: на карточке товара появляется блок обогащения; ключ PartsIndex задаётся в настройках
            этого блока.
          </p>
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
                Статус подписки
                <select
                  className="form-select form-select-sm mt-1"
                  value={cabinetForm.subscription_status}
                  onChange={(e) =>
                    setCabinetForm((f) => ({ ...f, subscription_status: e.target.value }))
                  }
                >
                  <option value="trial">Пробный</option>
                  <option value="active">Активен</option>
                  <option value="past_due">Нужна оплата</option>
                  <option value="suspended">Приостановлен</option>
                </select>
              </label>
              <label>
                Тариф (план)
                <select
                  className="form-select form-select-sm mt-1"
                  value={cabinetForm.plan_code || ''}
                  onChange={(e) => setCabinetForm((f) => ({ ...f, plan_code: e.target.value }))}
                >
                  <option value="">— не выбран —</option>
                  <option value="start">Старт</option>
                  <option value="business">Бизнес</option>
                  <option value="pro">Про</option>
                </select>
              </label>
              <label>
                Конец trial
                <input
                  type="datetime-local"
                  value={cabinetForm.trial_ends_at}
                  onChange={(e) =>
                    setCabinetForm((f) => ({ ...f, trial_ends_at: e.target.value }))
                  }
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label>
                Конец оплаченного периода
                <input
                  type="datetime-local"
                  value={cabinetForm.subscription_ends_at}
                  onChange={(e) =>
                    setCabinetForm((f) => ({ ...f, subscription_ends_at: e.target.value }))
                  }
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
              <label className="d-flex align-items-center gap-2 mt-2 mb-0" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cabinetForm.supplier_sync_enabled === true}
                  onChange={(e) =>
                    setCabinetForm((f) => ({ ...f, supplier_sync_enabled: e.target.checked }))
                  }
                />
                <span>Интеграция с поставщиками</span>
              </label>
              <p className="text-muted small mb-0">
                Если выключено: вкладка «Поставщики» в «Интеграциях» скрыта, фоновая синхронизация для аккаунта не выполняется.
              </p>
              <label className="d-flex align-items-center gap-2 mt-2 mb-0" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cabinetForm.product_enrichment_enabled === true}
                  onChange={(e) =>
                    setCabinetForm((f) => ({ ...f, product_enrichment_enabled: e.target.checked }))
                  }
                />
                <span>Обогащение карточек (PartsIndex)</span>
              </label>
              <p className="text-muted small mb-0">
                Включает модуль обогащения для аккаунта: блок на карточке товара и ключи в его настройках.
              </p>
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
              <span className="badge bg-light text-dark me-2">
                Организаций: {cabinetBundle.organizationsCount ?? 0}
              </span>
              <span className="badge bg-light text-dark me-2">
                Товаров: {cabinetBundle.productsCount ?? 0}
              </span>
              <button
                type="button"
                className="badge bg-light text-dark border-0 admin-storage-link"
                title="Подробная разбивка размера данных"
                onClick={() =>
                  openStorageBreakdown(cabinetBundle.profile?.id, cabinetBundle.profile?.name)
                }
              >
                Размер данных: {formatStorageSize(cabinetBundle.storageBytes)}
              </button>
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
                      <th>Ответ</th>
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
                        <td style={{ maxWidth: 220 }}>
                          {q.admin_reply ? (
                            <span className="small" style={{ whiteSpace: 'pre-wrap' }} title={q.admin_reply}>
                              {(q.admin_reply || '').slice(0, 200)}
                              {(q.admin_reply || '').length > 200 ? '…' : ''}
                            </span>
                          ) : (
                            <span className="text-muted small">—</span>
                          )}
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

      <Modal
        isOpen={storageTarget != null}
        onClose={() => setStorageTarget(null)}
        title={
          storageTarget?.name
            ? `Размер данных: ${storageTarget.name}`
            : 'Размер данных аккаунта'
        }
        size="large"
      >
        {storageLoading && <p>Загрузка разбивки...</p>}
        {!storageLoading && storageError && <p className="text-danger">{storageError}</p>}
        {!storageLoading && !storageError && storageBreakdown && (
          <div className="admin-storage-breakdown">
            <p className="admin-muted mb-3">
              Оценка доли аккаунта в общей БД. Итого:{' '}
              <strong>{formatStorageSize(storageBreakdown.totalBytes)}</strong>
            </p>
            {(storageBreakdown.categories || []).length === 0 ? (
              <p className="text-muted">Данных по аккаунту пока нет.</p>
            ) : (
              (storageBreakdown.categories || []).map((cat) => (
                <div key={cat.key} className="admin-storage-category">
                  <div className="admin-storage-category-head">
                    <div>
                      <strong>{cat.label}</strong>
                      <span className="admin-muted ms-2">
                        {formatStorageSize(cat.bytes)} · {cat.percent}% · {formatRows(cat.rows)} стр.
                      </span>
                    </div>
                    <div className="admin-storage-bar" aria-hidden="true">
                      <div
                        className="admin-storage-bar-fill"
                        style={{ width: `${Math.min(100, Number(cat.percent) || 0)}%` }}
                      />
                    </div>
                  </div>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead>
                        <tr>
                          <th>Раздел</th>
                          <th className="text-end">Размер</th>
                          <th className="text-end">Доля</th>
                          <th className="text-end">Строк</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(cat.tables || []).map((t) => (
                          <tr key={t.table}>
                            <td>
                              {t.label}
                              <div className="admin-muted small">{t.table}</div>
                            </td>
                            <td className="text-end text-nowrap">{formatStorageSize(t.bytes)}</td>
                            <td className="text-end text-nowrap">{t.percent}%</td>
                            <td className="text-end text-nowrap">{formatRows(t.rows)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
            <div className="admin-form-actions">
              <Button variant="secondary" onClick={() => setStorageTarget(null)}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
