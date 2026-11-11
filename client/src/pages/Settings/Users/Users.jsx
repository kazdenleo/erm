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
import { AccessMultiSelect } from './AccessMultiSelect.jsx';
import { profilesApi } from '../../../services/profiles.api.js';
import {
  ACCOUNT_ROLE_LABELS,
  accountRoleLabel as roleLabelFromKey,
} from '../../../utils/userNavSections.js';
import './Users.css';

const TABS = [
  { id: 'list', label: 'Список' },
  { id: 'roles', label: 'Роли' },
];

function accountRoleLabel(u, assignable = []) {
  if (u.role === 'admin') return 'Администратор системы';
  const r = String(u.account_role ?? '').trim().toLowerCase();
  if (r === 'admin' || u.is_profile_admin) return 'Администратор';
  const fromList = assignable.find((x) => x.key === r);
  if (fromList?.label) return fromList.label;
  return roleLabelFromKey(r) || ACCOUNT_ROLE_LABELS.editor;
}

function emptyUserForm() {
  return {
    email: '',
    password: '',
    lastName: '',
    firstName: '',
    middleName: '',
    phone: '',
    birthDate: '',
    role: 'user',
    isProfileAdmin: false,
    accountRole: 'editor',
    organizationIds: [],
    warehouseIds: [],
  };
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
  const [savingUser, setSavingUser] = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState(emptyUserForm);
  const [organizations, setOrganizations] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [assignableRoles, setAssignableRoles] = useState([
    { key: 'admin', label: 'Администратор' },
    { key: 'picker', label: 'Сборщик' },
    { key: 'warehouse_manager', label: 'Руководитель склада' },
    { key: 'editor', label: 'Редактор' },
  ]);

  const canManage = isTenantAccountAdmin;
  const showSystemAdminRoleOption = false;

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
      const [orgRes, whRes, rolesRes] = await Promise.all([
        organizationsApi.getAll(),
        warehousesApi.getAll(),
        profilesApi.getRoleNavSections().catch(() => null),
      ]);
      const assignable = Array.isArray(rolesRes?.data?.assignable) ? rolesRes.data.assignable : null;
      if (assignable?.length) {
        setAssignableRoles(assignable);
      }
      setOrganizations(Array.isArray(orgRes?.data) ? orgRes.data : []);
      const whList = Array.isArray(whRes?.data) ? whRes.data : Array.isArray(whRes) ? whRes : [];
      // Показываем физические склады (type=warehouse); если type пустой — тоже включаем
      setWarehouses(
        whList.filter((w) => {
          const t = String(w.type || '').trim().toLowerCase();
          return !t || t === 'warehouse';
        })
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
    setFormError('');
    setForm(emptyUserForm());
    setModalOpen(true);
  };

  const openEdit = (u) => {
    setEditing(u);
    setFormError('');
    setForm({
      email: u.email ?? '',
      password: '',
      lastName: u.last_name ?? '',
      firstName: u.first_name ?? '',
      middleName: u.middle_name ?? '',
      phone: u.phone ?? '',
      birthDate: (u.birth_date || '').toString().slice(0, 10),
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

  const closeModal = () => {
    if (savingUser) return;
    setModalOpen(false);
    setFormError('');
  };

  const save = async () => {
    if (savingUser) return;
    const phone = String(form.phone ?? '').trim();
    // При создании телефон обязателен. При редактировании — только если задали;
    // иначе роль/доступ сохраняются и без телефона (у части пользователей phone=null).
    if (!editing && !phone) {
      setFormError('Введите телефон (логин)');
      return;
    }
    if (!editing && !form.password) {
      setFormError('Введите пароль для нового пользователя');
      return;
    }
    setSavingUser(true);
    setFormError('');
    try {
      const payload = {
        email: String(form.email ?? '').trim() || null,
        lastName: String(form.lastName ?? '').trim(),
        firstName: String(form.firstName ?? '').trim(),
        middleName: String(form.middleName ?? '').trim(),
        birthDate: String(form.birthDate ?? '').trim() || null,
        role: 'user',
      };
      if (!editing || phone) {
        payload.phone = phone;
      }
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
      setFormError('');
      load();
    } catch (err) {
      setFormError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSavingUser(false);
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
            Добавление пользователей аккаунта: телефон (логин), пароль, роль и доступ к организациям/складам.
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
                        <span className="settings-users-email">{u.phone || u.email || 'без логина'}</span>
                        {userDisplayName(u) && <span className="settings-users-name"> — {userDisplayName(u)}</span>}
                        <span className="settings-users-role">{accountRoleLabel(u, assignableRoles)}</span>
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

        </>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editing ? 'Редактировать пользователя' : 'Добавить пользователя'}
        size="large"
      >
        <form
          className="settings-users-modal"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="settings-users-modal__fields settings-users-form">
            {formError ? <p className="settings-users-form-error">{formError}</p> : null}
            <label>
              Телефон (логин) <span style={{ color: 'var(--error)' }}>*</span>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className="login-input"
                style={{ width: '100%', marginTop: '4px' }}
                autoComplete="tel"
                placeholder="+7 999 123-45-67"
                disabled={savingUser}
              />
            </label>
            <label>
              Почта
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className="login-input"
                style={{ width: '100%', marginTop: '4px' }}
                disabled={savingUser}
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
                disabled={savingUser}
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
                disabled={savingUser}
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
                disabled={savingUser}
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
                disabled={savingUser}
              />
            </label>
            <label>
              Дата рождения
              <input
                type="date"
                value={form.birthDate}
                onChange={(e) => setForm((f) => ({ ...f, birthDate: e.target.value }))}
                className="login-input"
                style={{ width: '100%', marginTop: '4px' }}
                autoComplete="bday"
                disabled={savingUser}
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
                disabled={savingUser}
              >
                <option value="admin">Администратор</option>
                {assignableRoles
                  .filter((r) => r.key !== 'admin')
                  .map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
              </select>
              <div className="text-muted small" style={{ marginTop: 8, lineHeight: 1.35 }}>
                {form.isProfileAdmin ? (
                  <div>Администратор аккаунта — полный доступ, управление пользователями и ролями.</div>
                ) : (
                  <div>Видимые разделы для этой роли настраиваются на вкладке «Роли».</div>
                )}
              </div>
            </label>

            <div className={`settings-users-access-block${form.isProfileAdmin ? ' settings-users-access-block--disabled' : ''}`}>
              <div className="settings-users-access-title">Доступ к организациям и складам</div>
              {form.isProfileAdmin ? (
                <p className="text-muted small settings-users-access-hint">
                  У администратора полный доступ ко всем организациям и складам. Ограничения не применяются.
                </p>
              ) : (
                <p className="text-muted small settings-users-access-hint">
                  Можно выбрать несколько. Если не выбрано — полный доступ ко всем.
                </p>
              )}

              <AccessMultiSelect
                label="Организации"
                emptyLabel="Все организации (полный доступ)"
                disabled={form.isProfileAdmin || savingUser}
                options={organizations.map((org) => ({
                  id: org.id,
                  label: org.name || `Организация #${org.id}`,
                }))}
                value={form.organizationIds}
                onChange={(organizationIds) => setForm((f) => ({ ...f, organizationIds }))}
              />

              <AccessMultiSelect
                label="Склады"
                emptyLabel="Все склады (полный доступ)"
                disabled={form.isProfileAdmin || savingUser}
                options={warehouses.map((wh) => ({
                  id: wh.id,
                  label: wh.address || wh.name || `Склад #${wh.id}`,
                }))}
                value={form.warehouseIds}
                onChange={(warehouseIds) => setForm((f) => ({ ...f, warehouseIds }))}
              />
            </div>

            {showSystemAdminRoleOption && (
              <label>
                Роль для входа
                <select
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  className="login-input"
                  style={{ width: '100%', marginTop: '4px' }}
                  disabled={savingUser}
                >
                  <option value="user">Пользователь</option>
                  <option value="admin">Администратор системы</option>
                </select>
              </label>
            )}
          </div>
          <div className="settings-users-modal__footer admin-form-actions">
            <Button variant="secondary" type="button" onClick={closeModal} disabled={savingUser}>
              Отмена
            </Button>
            <Button variant="primary" type="submit" disabled={savingUser}>
              {savingUser ? 'Сохранение…' : editing ? 'Сохранить' : 'Добавить'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
