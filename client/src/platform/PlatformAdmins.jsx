/**
 * Администраторы продукта (супераккаунт) — несколько человек, полный доступ к /platform.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { usersApi } from '../services/users.api.js';
import { Button } from '../components/common/Button/Button';
import { Modal } from '../components/common/Modal/Modal';
import { buildFullName } from '../utils/userName.js';
import './platform.css';

function emptyForm() {
  return {
    email: '',
    password: '',
    lastName: '',
    firstName: '',
    middleName: '',
    phone: '',
    birthDate: '',
  };
}

function displayName(u) {
  return (
    buildFullName({
      lastName: u.last_name ?? '',
      firstName: u.first_name ?? '',
      middleName: u.middle_name ?? '',
    }) ||
    u.full_name ||
    ''
  );
}

export function PlatformAdmins() {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await usersApi.getPlatformAdmins();
      setList(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setFormError('');
    setForm(emptyForm());
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
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setFormError('');
  };

  const save = async () => {
    if (saving) return;
    const email = String(form.email ?? '').trim();
    if (!email) {
      setFormError('Укажите email администратора');
      return;
    }
    if (!editing && !String(form.password ?? '').trim()) {
      setFormError('Введите пароль для нового администратора');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        email,
        lastName: String(form.lastName ?? '').trim(),
        firstName: String(form.firstName ?? '').trim(),
        middleName: String(form.middleName ?? '').trim(),
        birthDate: String(form.birthDate ?? '').trim() || null,
        phone: String(form.phone ?? '').trim() || null,
        role: 'admin',
        profileId: null,
        isProfileAdmin: false,
        accountRole: null,
      };
      if (form.password) payload.password = form.password;
      if (editing) {
        await usersApi.update(editing.id, payload);
      } else {
        await usersApi.create(payload);
      }
      setModalOpen(false);
      setFormError('');
      await load();
    } catch (err) {
      setFormError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (u) => {
    if (Number(u.id) === Number(user?.id)) {
      alert('Нельзя удалить свою учётную запись');
      return;
    }
    if (list.length <= 1) {
      alert('Нельзя удалить последнего администратора продукта');
      return;
    }
    if (!window.confirm(`Удалить администратора ${displayName(u) || u.email}?`)) return;
    try {
      await usersApi.delete(u.id);
      await load();
    } catch (err) {
      alert(err?.response?.data?.message || err?.message || 'Ошибка удаления');
    }
  };

  return (
    <div className="platform-page platform-admins">
      <div className="platform-admins__head">
        <div>
          <h1 className="title">Администраторы</h1>
          <p className="platform-muted" style={{ margin: 0 }}>
            Несколько человек с доступом к админке продукта. Добавлять и менять данные может любой суперадмин.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          Добавить администратора
        </Button>
      </div>

      {loading && <p className="platform-muted">Загрузка…</p>}
      {error && <div className="platform-admins__error">Ошибка: {error}</div>}

      {!loading && !error && (
        <div className="platform-admins__list">
          {list.length === 0 ? (
            <div className="platform-placeholder">
              <p>Администраторов пока нет</p>
              <Button onClick={openCreate}>Добавить администратора</Button>
            </div>
          ) : (
            list.map((u) => {
              const isSelf = Number(u.id) === Number(user?.id);
              const name = displayName(u);
              return (
                <div key={u.id} className="platform-admins__item">
                  <div className="platform-admins__meta">
                    <div className="platform-admins__primary">
                      <span className="platform-admins__email">{u.email || 'без email'}</span>
                      {isSelf ? <span className="platform-admins__badge">вы</span> : null}
                    </div>
                    {name ? <div className="platform-admins__name">{name}</div> : null}
                    <div className="platform-admins__secondary">
                      {u.phone ? <span>тел. {u.phone}</span> : <span className="platform-muted">телефон не указан</span>}
                      {u.birth_date ? (
                        <span> · дата рождения {(u.birth_date || '').toString().slice(0, 10)}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="platform-admins__actions">
                    <Button variant="secondary" size="small" onClick={() => openEdit(u)}>
                      Изменить
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      className="btn-danger"
                      onClick={() => remove(u)}
                      disabled={isSelf || list.length <= 1}
                      title={
                        isSelf
                          ? 'Нельзя удалить себя'
                          : list.length <= 1
                            ? 'Нельзя удалить последнего администратора'
                            : undefined
                      }
                    >
                      Удалить
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editing ? 'Редактировать администратора' : 'Добавить администратора'}
        size="large"
      >
        <form
          className="platform-admins-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {formError ? <p className="platform-admins__error">{formError}</p> : null}
          <div className="platform-mp-fields">
            <label className="platform-mp-label">
              Email <span style={{ color: 'var(--error, #dc3545)' }}>*</span>
              <input
                type="email"
                className="platform-mp-input"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                autoComplete="email"
                disabled={saving}
                required
              />
            </label>
            <label className="platform-mp-label">
              {editing ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'}{' '}
              {!editing && <span style={{ color: 'var(--error, #dc3545)' }}>*</span>}
              <input
                type="password"
                className="platform-mp-input"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                autoComplete="new-password"
                disabled={saving}
              />
            </label>
            <label className="platform-mp-label">
              Телефон
              <input
                type="tel"
                className="platform-mp-input"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                autoComplete="tel"
                placeholder="+7 999 123-45-67"
                disabled={saving}
              />
            </label>
            <label className="platform-mp-label">
              Фамилия
              <input
                type="text"
                className="platform-mp-input"
                value={form.lastName}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                autoComplete="family-name"
                disabled={saving}
              />
            </label>
            <label className="platform-mp-label">
              Имя
              <input
                type="text"
                className="platform-mp-input"
                value={form.firstName}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                autoComplete="given-name"
                disabled={saving}
              />
            </label>
            <label className="platform-mp-label">
              Отчество
              <input
                type="text"
                className="platform-mp-input"
                value={form.middleName}
                onChange={(e) => setForm((f) => ({ ...f, middleName: e.target.value }))}
                autoComplete="additional-name"
                disabled={saving}
              />
            </label>
            <label className="platform-mp-label">
              Дата рождения
              <input
                type="date"
                className="platform-mp-input"
                value={form.birthDate}
                onChange={(e) => setForm((f) => ({ ...f, birthDate: e.target.value }))}
                autoComplete="bday"
                disabled={saving}
              />
            </label>
          </div>
          <div className="platform-admins-form__footer">
            <Button variant="secondary" type="button" onClick={closeModal} disabled={saving}>
              Отмена
            </Button>
            <Button variant="primary" type="submit" disabled={saving}>
              {saving ? 'Сохранение…' : editing ? 'Сохранить' : 'Добавить'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
