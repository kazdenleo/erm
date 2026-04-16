/**
 * Settings → Users
 * Управление пользователями профиля (логин, пароль, роль). Видно только администратору профиля и системе.
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { buildFullName } from '../../../utils/userName.js';
import './Users.css';

/** Подпись роли в списке: админ аккаунта — по флагу is_profile_admin, не по role */
function accountRoleLabel(u) {
  if (u.role === 'admin') return 'Администратор системы';
  if (u.is_profile_admin) return 'Администратор';
  return 'Пользователь';
}

export function SettingsUsers() {
  const { user, isAdmin, isProfileAdmin } = useAuth();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    email: '',
    password: '',
    lastName: '',
    firstName: '',
    middleName: '',
    role: 'user',
    isProfileAdmin: false,
  });

  const canManage = isAdmin || isProfileAdmin;
  /** Роли в этом разделе — только у администратора аккаунта (не у админа продукта) */
  const canSeeRoles = isProfileAdmin;
  /** Администраторов системы создают вне привязки к аккаунту; в списке «пользователей профиля» эту роль не задаём */
  const showSystemAdminRoleOption = false;

  const load = async () => {
    if (!canManage) return;
    setLoading(true);
    setError('');
    try {
      // Только пользователи аккаунта: по profile_id. Админ продукта без аккаунта — тоже только «участники профилей», без глобальных admin.
      const scopeProfileId =
        user?.profileId != null ? user.profileId : isAdmin ? undefined : user?.profileId;
      const res = await usersApi.getAll(scopeProfileId);
      const rows = res?.data ?? [];
      setList(rows.filter((u) => u.role !== 'admin'));
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [canManage, isAdmin, user?.profileId]);

  const openCreate = () => {
    setEditing(null);
    setForm({ email: '', password: '', lastName: '', firstName: '', middleName: '', role: 'user', isProfileAdmin: false });
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
      const role = user?.profileId != null ? 'user' : form.role;
      const payload = {
        email: form.email.trim(),
        lastName: form.lastName.trim(),
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        role,
      };
      if (user?.profileId != null) {
        payload.profileId = user.profileId;
      }
      if (form.password) payload.password = form.password;
      if (!editing && user?.profileId != null) {
        payload.isProfileAdmin = !!form.isProfileAdmin;
      }
      if (editing && user?.profileId != null) {
        payload.isProfileAdmin = !!form.isProfileAdmin;
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
        <p>Управление пользователями доступно только администратору профиля.</p>
      </div>
    );
  }

  if (loading) return <div className="settings-users-loading">Загрузка...</div>;
  if (error) return <div className="settings-users-error">Ошибка: {error}</div>;

  const userDisplayName = (u) =>
    buildFullName({
      lastName: u.last_name ?? '',
      firstName: u.first_name ?? '',
      middleName: u.middle_name ?? '',
    }) || u.full_name || '';

  return (
    <div className="card settings-users-page">
      <h1 className="title">Пользователи</h1>
      <p className="subtitle">Добавление пользователей профиля: логин (email), пароль и роль для входа. Роли видны только администратору профиля.</p>

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
                {canSeeRoles && (
                  <span className="settings-users-role">{accountRoleLabel(u)}</span>
                )}
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
            {editing ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'} {!editing && <span style={{ color: 'var(--error)' }}>*</span>}
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
          {canSeeRoles && user?.profileId != null && (
            <label>
              Роль
              <select
                value={form.isProfileAdmin ? 'admin' : 'user'}
                onChange={(e) =>
                  setForm((f) => ({ ...f, isProfileAdmin: e.target.value === 'admin' }))
                }
                className="login-input"
                style={{ width: '100%', marginTop: '4px' }}
              >
                <option value="user">Пользователь</option>
                <option value="admin">Администратор</option>
              </select>
            </label>
          )}
          {canSeeRoles && user?.profileId == null && (
            <label>
              Роль для входа
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                className="login-input"
                style={{ width: '100%', marginTop: '4px' }}
              >
                <option value="user">Пользователь</option>
                {showSystemAdminRoleOption && <option value="admin">Администратор системы</option>}
              </select>
            </label>
          )}
          <div className="admin-form-actions">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Отмена</Button>
            <Button variant="primary" onClick={save}>{editing ? 'Сохранить' : 'Добавить'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
