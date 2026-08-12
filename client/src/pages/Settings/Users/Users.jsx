/**
 * Settings → Пользователи
 * Список пользователей и настройка ролей (только администратор аккаунта).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { organizationsApi } from '../../../services/organizations.api.js';
import { warehousesApi } from '../../../services/warehouses.api.js';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { buildFullName } from '../../../utils/userName.js';
import { UsersRolesTab } from './UsersRolesTab.jsx';
import './Users.css';

const TABS = [
  { id: 'list', label: 'Список' },
  { id: 'roles', label: 'Роли' },
];

function accountRoleLabel(u) {
  if (u.role === 'admin') return 'Администратор системы';
  const r = String(u.account_role ?? '').trim().toLowerCase();
  if (r === 'admin' || u.is_profile_admin) return 'Администратор';
  if (r === 'picker') return 'Сборщик';
  if (r === 'warehouse_manager') return 'Руководитель склада';
  if (r === 'editor') return 'Редактор';
  return 'Редактор';
}

function emptyUserForm() {
  return {
    email: '',
    password: '',
    lastName: '',
    firstName: '',
    middleName: '',
    role: 'user',
    isProfileAdmin: false,
    accountRole: 'editor',
    organizationIds: [],
    warehouseIds: [],
  };
}

function toggleId(list, id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return list;
  if (list.includes(n)) return list.filter((x) => x !== n);
  return [...list, n];
}

export function SettingsUsers() {
  const { isTenantAccountAdmin, profileId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'roles' ? 'roles' : 'list';

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyUserForm);
  const [organizations, setOrganizations] = useState([]);
  const [warehouses, setWarehouses] = useState([]);

  const canManage = isTenantAccountAdmin;
  const showSystemAdminRoleOption = false;
  const accessRestricted = !form.isProfileAdmin;

  const setTab = (nextTab) => {
    if (nextTab === 'list') {
      setSearchParams({});
    } else {
      setSearchParams({ tab: nextTab });
    }
  };

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    setError('');
    try {
      const res = await usersApi.getAll(profileId);
      const rows = res?.data ?? [];
      setList(rows.filter((u) => u.role !== 'admin'));
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [canManage, profileId]);

  const loadAccessOptions = useCallback(async () => {
    if (!canManage) return;
    try {
      const [orgRes, whRes] = await Promise.all([
        organizationsApi.getAll(),
        warehousesApi.getAll(),
      ]);
      setOrganizations(Array.isArray(orgRes?.data) ? orgRes.data : []);
      const whList = Array.isArray(whRes?.data) ? whRes.data : [];
      setWarehouses(
        whList.filter((w) => String(w.type || '').toLowerCase() === 'warehouse' || !w.type)
      );
    } catch {
      setOrganizations([]);
      setWarehouses([]);
    }
  }, [canManage]);

  useEffect(() => {
    if (tab === 'list') {
      load();
      loadAccessOptions();
    }
  }, [load, loadAccessOptions, tab]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyUserForm());
    setModalOpen(true);
  };

  const openEdit = (u) => {
    setEditing(u);
    setForm({
      email: u.email,
      password: '',
      lastName: u.last_name ?? '',
      firstName: u.first_name ?? '',
      middleName: u.middle_name ?? '',
      role: u.role ?? 'user',
      isProfileAdmin: !!u.is_profile_admin,
      accountRole: String(u.account_role ?? (u.is_profile_admin ? 'admin' : 'editor')).trim().toLowerCase() || 'editor',
      organizationIds: Array.isArray(u.organization_ids)
        ? u.organization_ids.map(Number).filter((n) => Number.isFinite(n))
        : [],
      warehouseIds: Array.isArray(u.warehouse_ids)
        ? u.warehouse_ids.map(Number).filter((n) => Number.isFinite(n))
        : [],
    });
    setModalOpen(true);
  };

  const save = async () => {
    if (!form.email.trim()) {
      alert('Введите email (логин)');
      return;
    }
    if (!editing && !form.password) {
      alert('Введите пароль для нового пользователя');
      return;
    }
    try {
      const payload = {
        email: form.email.trim(),
        lastName: form.lastName.trim(),
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        role: 'user',
      };
      if (form.password) payload.password = form.password;
      payload.isProfileAdmin = !!form.isProfileAdmin;
      payload.accountRole = form.isProfileAdmin ? 'admin' : form.accountRole;
      if (form.isProfileAdmin) {
        payload.organizationIds = [];
        payload.warehouseIds = [];
      } else {
        payload.organizationIds = form.organizationIds;
        payload.warehouseIds = form.warehouseIds;
      }
      if (editing) {
        await usersApi.update(editing.id, payload);
      } else {
        await usersApi.create(payload);
      }
      setModalOpen(false);
      load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Удалить этого пользователя?')) return;
    try {
      await usersApi.delete(id);
      load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка удаления');
    }
  };

  if (!canManage) {
    return (
      <div className="card">
        <h1 className="title">Пользователи</h1>
        <p>Управление пользователями и ролями доступно только администратору аккаунта.</p>
      </div>
    );
  }

  const userDisplayName = (u) =>
    buildFullName({
      lastName: u.last_name ?? '',
      firstName: u.first_name ?? '',
      middleName: u.middle_name ?? '',
    }) || u.full_name || '';

  const accessSummary = (u) => {
    if (u.is_profile_admin || String(u.account_role || '').toLowerCase() === 'admin') {
      return 'полный доступ';
    }
    const orgN = Array.isArray(u.organization_ids) ? u.organization_ids.length : 0;
    const whN = Array.isArray(u.warehouse_ids) ? u.warehouse_ids.length : 0;
    if (orgN === 0 && whN === 0) return 'все орг. и склады';
    const parts = [];
    if (orgN > 0) parts.push(`орг.: ${orgN}`);
    else parts.push('все орг.');
    if (whN > 0) parts.push(`склады: ${whN}`);
    else parts.push('все склады');
    return parts.join(', ');
  };

  return (
    <div className="card settings-users-page">
      <h1 className="title">Пользователи</h1>

      <nav className="settings-users-tabs" aria-label="Разделы пользователей">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'roles' ? (
        <UsersRolesTab />
      ) : (
        <>
          <p className="subtitle">
            Добавление пользователей аккаунта: логин (email), пароль, роль и доступ к организациям/складам.
            Видимые разделы — на вкладке «Роли».
          </p>
          {loading && <div className="settings-users-loading">Загрузка...</div>}
          {error && <div className="settings-users-error">Ошибка: {error}</div>}
          {!loading && !error && (
            <>
              <div className="settings-users-list">
                {list.length === 0 ? (
                  <div className="empty-state">
                    <p>Пользователей пока нет</p>
                    <Button onClick={openCreate}>Добавить пользователя</Button>
                  </div>
                ) : (
                  list.map((u) => (
                    <div key={u.id} className="settings-users-item">
                      <div>
                        <span className="settings-users-email">{u.email}</span>
                        {userDisplayName(u) && <span className="settings-users-name"> — {userDisplayName(u)}</span>}
                        <span className="settings-users-role">{accountRoleLabel(u)}</span>
                        <span className="settings-users-access">{accessSummary(u)}</span>
                      </div>
                      <div className="settings-users-actions">
                        <Button variant="secondary" size="small" onClick={() => openEdit(u)}>Изменить</Button>
                        <Button variant="secondary" size="small" onClick={() => remove(u.id)} className="btn-danger">Удалить</Button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="settings-users-footer">
                <Button variant="primary" onClick={openCreate}>Добавить пользователя</Button>
              </div>
            </>
          )}

          <Modal
            isOpen={modalOpen}
            onClose={() => setModalOpen(false)}
            title={editing ? 'Редактировать пользователя' : 'Добавить пользователя'}
            size="medium"
          >
            <div className="settings-users-form">
              <label>
                Логин (email) <span style={{ color: 'var(--error)' }}>*</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                  disabled={!!editing}
                />
              </label>
              <label>
                {editing ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'}{' '}
                {!editing && <span style={{ color: 'var(--error)' }}>*</span>}
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                />
              </label>
              <label>
                Фамилия
                <input
                  type="text"
                  value={form.lastName}
                  onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                  autoComplete="family-name"
                />
              </label>
              <label>
                Имя
                <input
                  type="text"
                  value={form.firstName}
                  onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                  autoComplete="given-name"
                />
              </label>
              <label>
                Отчество
                <input
                  type="text"
                  value={form.middleName}
                  onChange={(e) => setForm((f) => ({ ...f, middleName: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                  autoComplete="additional-name"
                />
              </label>
              <label>
                Роль
                <select
                  value={form.isProfileAdmin ? 'admin' : form.accountRole}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      isProfileAdmin: e.target.value === 'admin',
                      accountRole: e.target.value === 'admin' ? 'admin' : e.target.value,
                      ...(e.target.value === 'admin'
                        ? { organizationIds: [], warehouseIds: [] }
                        : null),
                    }))
                  }
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                >
                  <option value="admin">Администратор</option>
                  <option value="picker">Сборщик</option>
                  <option value="warehouse_manager">Руководитель склада</option>
                  <option value="editor">Редактор</option>
                </select>
                <div className="text-muted small" style={{ marginTop: 8, lineHeight: 1.35 }}>
                  {form.isProfileAdmin ? (
                    <div>Администратор аккаунта — полный доступ, управление пользователями и ролями.</div>
                  ) : (
                    <div>Видимые разделы для этой роли настраиваются на вкладке «Роли».</div>
                  )}
                </div>
              </label>

              {accessRestricted && (
                <div className="settings-users-access-block">
                  <div className="settings-users-access-title">Доступ к данным</div>
                  <p className="text-muted small settings-users-access-hint">
                    Если ничего не отмечено — доступ ко всем организациям и складам аккаунта.
                    Отметьте нужные, чтобы ограничить видимость данных.
                  </p>

                  <div className="settings-users-access-group">
                    <div className="settings-users-access-group-title">Организации</div>
                    {organizations.length === 0 ? (
                      <div className="text-muted small">Организаций пока нет</div>
                    ) : (
                      <div className="settings-users-access-toggles">
                        {organizations.map((org) => {
                          const id = Number(org.id);
                          const checked = form.organizationIds.includes(id);
                          return (
                            <label key={org.id} className="settings-users-nav-toggle">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                checked={checked}
                                onChange={() =>
                                  setForm((f) => ({
                                    ...f,
                                    organizationIds: toggleId(f.organizationIds, id),
                                  }))
                                }
                              />
                              <span className="form-check-label">{org.name || `Организация #${org.id}`}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="settings-users-access-group">
                    <div className="settings-users-access-group-title">Склады</div>
                    {warehouses.length === 0 ? (
                      <div className="text-muted small">Складов пока нет</div>
                    ) : (
                      <div className="settings-users-access-toggles">
                        {warehouses.map((wh) => {
                          const id = Number(wh.id);
                          const checked = form.warehouseIds.includes(id);
                          const label = wh.address || wh.name || `Склад #${wh.id}`;
                          return (
                            <label key={wh.id} className="settings-users-nav-toggle">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                checked={checked}
                                onChange={() =>
                                  setForm((f) => ({
                                    ...f,
                                    warehouseIds: toggleId(f.warehouseIds, id),
                                  }))
                                }
                              />
                              <span className="form-check-label">{label}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showSystemAdminRoleOption && (
                <label>
                  Роль для входа
                  <select
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                    className="login-input"
                    style={{ width: '100%', marginTop: '4px' }}
                  >
                    <option value="user">Пользователь</option>
                    <option value="admin">Администратор системы</option>
                  </select>
                </label>
              )}
              <div className="admin-form-actions">
                <Button variant="secondary" onClick={() => setModalOpen(false)}>Отмена</Button>
                <Button variant="primary" onClick={save}>{editing ? 'Сохранить' : 'Добавить'}</Button>
              </div>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
