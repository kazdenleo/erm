/**
 * Settings → Users
 * Управление пользователями профиля (логин, пароль, роль). Видно только администратору профиля и системе.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { Button } from '../../../components/common/Button/Button';
import { Modal } from '../../../components/common/Modal/Modal';
import { buildFullName } from '../../../utils/userName.js';
import './Users.css';

/** Подпись роли в списке: админ аккаунта — по флагу is_profile_admin, не по role */
function accountRoleLabel(u) {
  if (u.role === 'admin') return 'Администратор системы';
  const r = String(u.account_role ?? '').trim().toLowerCase();
  if (r === 'admin' || u.is_profile_admin) return 'Администратор';
  if (r === 'picker') return 'Сборщик';
  if (r === 'warehouse_manager') return 'Руководитель склада';
  if (r === 'editor') return 'Редактор';
  return 'Редактор';
}

export function SettingsUsers() {
  const { user, isAdmin, isAccountAdmin } = useAuth();
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
    accountRole: 'editor',
  });

  const canManage = isAccountAdmin;
  /** Роли в этом разделе — только у администратора аккаунта (не у админа продукта) */
  const canSeeRoles = isAccountAdmin && !isAdmin;
  /** Администраторов системы создают вне привязки к аккаунту; в списке «пользователей профиля» эту роль не задаём */
  const showSystemAdminRoleOption = false;

  const load = useCallback(async () => {
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
  }, [canManage, isAdmin, user?.profileId]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ email: '', password: '', lastName: '', firstName: '', middleName: '', role: 'user', isProfileAdmin: false, accountRole: 'editor' });
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
      // profileId для создания задаёт сервер из req.user.profileId; передавать его может только админ системы
      if (form.password) payload.password = form.password;
      if (!editing && user?.profileId != null) {
        payload.isProfileAdmin = !!form.isProfileAdmin;
      }
      if (editing && user?.profileId != null) {
        payload.isProfileAdmin = !!form.isProfileAdmin;
      }
      if (canSeeRoles) {
        payload.accountRole = form.isProfileAdmin ? 'admin' : form.accountRole;
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
      <p className="subtitle">
        Добавление пользователей аккаунта: логин (email), пароль и роль. Роли видны только администратору аккаунта.
      </p>

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
                value={form.isProfileAdmin ? 'admin' : form.accountRole}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    isProfileAdmin: e.target.value === 'admin',
                    accountRole: e.target.value === 'admin' ? 'admin' : e.target.value,
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
                  <div>
                    <div>Администратор:</div>
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      <li>может добавлять и удалять пользователей</li>
                      <li>может выдавать роли пользователям</li>
                      <li>имеет доступ ко всем разделам аккаунта</li>
                    </ul>
                  </div>
                ) : form.accountRole === 'picker' ? (
                  <div>
                    <div>Сборщик:</div>
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      <li>сборка заказов</li>
                      <li>печать этикеток</li>
                      <li>без доступа к управлению пользователями</li>
                    </ul>
                  </div>
                ) : form.accountRole === 'warehouse_manager' ? (
                  <div>
                    <div>Руководитель склада:</div>
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      <li>остатки и складские операции</li>
                      <li>контроль поставок/перемещений</li>
                      <li>без доступа к управлению пользователями</li>
                    </ul>
                  </div>
                ) : (
                  <div>
                    <div>Редактор:</div>
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      <li>редактирование товаров и настроек (кроме пользователей)</li>
                      <li>работа с заказами по доступным разделам</li>
                      <li>без доступа к управлению пользователями</li>
                    </ul>
                  </div>
                )}
              </div>
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
