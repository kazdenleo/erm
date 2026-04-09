/**
 * Кабинет: данные аккаунта (админ аккаунта) и личный профиль пользователя
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { usersApi } from '../../services/users.api.js';
import { profilesApi } from '../../services/profiles.api.js';
import { authApi } from '../../services/auth.api.js';
import { Button } from '../../components/common/Button/Button';
import './Cabinet.css';

export function Cabinet() {
  const { user, isAdmin, profileId, isProfileAdmin, refreshUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accountForm, setAccountForm] = useState({
    name: '',
    contact_email: '',
    contact_phone: '',
  });
  const [savingAccount, setSavingAccount] = useState(false);
  const [personal, setPersonal] = useState({
    fullName: '',
    phone: '',
    email: '',
  });
  const [pwd, setPwd] = useState({ current: '', next: '', next2: '' });
  const [savingPersonal, setSavingPersonal] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);

  const profileTitle = user?.profile?.name || 'Кабинет';

  const load = useCallback(async () => {
    if (profileId == null && !isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const uRes = await usersApi.getMe();
      const row = uRes?.data;
      if (row) {
        setPersonal({
          fullName: row.full_name ?? '',
          phone: row.phone ?? '',
          email: row.email ?? '',
        });
      }
      if (isProfileAdmin && profileId != null) {
        try {
          const pRes = await profilesApi.getMe();
          const p = pRes?.data;
          setAccountForm({
            name: p?.name ?? '',
            contact_email: p?.contact_email ?? '',
            contact_phone: p?.contact_phone ?? '',
          });
        } catch {
          setAccountForm({ name: '', contact_email: '', contact_phone: '' });
        }
      } else {
        setAccountForm({ name: '', contact_email: '', contact_phone: '' });
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [profileId, isAdmin, isProfileAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const savePersonal = async () => {
    setSavingPersonal(true);
    setError('');
    try {
      await usersApi.updateMe({
        fullName: personal.fullName.trim() || null,
        phone: personal.phone.trim() || null,
      });
      await refreshUser();
      alert('Сохранено');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSavingPersonal(false);
    }
  };

  const saveAccount = async () => {
    const name = accountForm.name.trim();
    if (!name) {
      alert('Укажите название аккаунта');
      return;
    }
    setSavingAccount(true);
    setError('');
    try {
      await profilesApi.updateMe({
        name,
        contact_email: accountForm.contact_email.trim() || null,
        contact_phone: accountForm.contact_phone.trim() || null,
      });
      await refreshUser();
      alert('Реквизиты аккаунта сохранены');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка сохранения');
    } finally {
      setSavingAccount(false);
    }
  };

  const savePassword = async () => {
    if (pwd.next !== pwd.next2) {
      alert('Новый пароль и подтверждение не совпадают');
      return;
    }
    setSavingPwd(true);
    setError('');
    try {
      await authApi.changePassword(pwd.current, pwd.next);
      setPwd({ current: '', next: '', next2: '' });
      alert('Пароль изменён');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сменить пароль');
    } finally {
      setSavingPwd(false);
    }
  };

  if (profileId == null && !isAdmin) {
    return (
      <div className="card">
        <h1 className="title">Кабинет</h1>
        <p>У вашей учётной записи нет привязанного аккаунта. Обратитесь к администратору.</p>
      </div>
    );
  }

  if (profileId == null && isAdmin) {
    return (
      <div className="card cabinet-page">
        <h1 className="title">Кабинет</h1>
        <p className="subtitle">Раздел для пользователей с привязкой к аккаунту клиента.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="cabinet-loading">Загрузка...</div>;
  }

  return (
    <div className="cabinet-page card">
      <h1 className="title">{profileTitle}</h1>

      {error && <p className="cabinet-error-msg">{error}</p>}

      {isProfileAdmin && (
        <section className="cabinet-section cabinet-section--account">
          <h2 className="cabinet-section-title">Аккаунт</h2>
          <p className="cabinet-hint">
            Название и контакты аккаунта (не меняют email входа в систему). Дублируется в{' '}
            <Link to="/settings">Настройки → Общие</Link>.
          </p>
          <div className="cabinet-form-grid">
            <label className="cabinet-input-label">
              Название аккаунта
              <input
                type="text"
                className="login-input"
                value={accountForm.name}
                onChange={(e) => setAccountForm((f) => ({ ...f, name: e.target.value }))}
                autoComplete="organization"
              />
            </label>
            <label className="cabinet-input-label">
              Контактный email аккаунта
              <input
                type="email"
                className="login-input"
                value={accountForm.contact_email}
                onChange={(e) => setAccountForm((f) => ({ ...f, contact_email: e.target.value }))}
                autoComplete="email"
              />
            </label>
            <label className="cabinet-input-label">
              Контактный телефон аккаунта
              <input
                type="tel"
                className="login-input"
                value={accountForm.contact_phone}
                onChange={(e) => setAccountForm((f) => ({ ...f, contact_phone: e.target.value }))}
                autoComplete="tel"
              />
            </label>
          </div>
          <div className="cabinet-actions">
            <Button type="button" variant="primary" onClick={saveAccount} disabled={savingAccount}>
              {savingAccount ? 'Сохранение…' : 'Сохранить реквизиты аккаунта'}
            </Button>
          </div>

          <h3 className="cabinet-subtitle">Пароль входа</h3>
          <p className="cabinet-hint small">
            Пароль от вашей учётной записи ({personal.email || 'email'}). Забыли пароль — напишите в{' '}
            <Link to="/support">техподдержку</Link>, восстановление по почте пока не подключено.
          </p>
          <div className="cabinet-form-grid">
            <label className="cabinet-input-label">
              Текущий пароль
              <input
                type="password"
                className="login-input"
                value={pwd.current}
                onChange={(e) => setPwd((p) => ({ ...p, current: e.target.value }))}
                autoComplete="current-password"
              />
            </label>
            <label className="cabinet-input-label">
              Новый пароль (не менее 8 символов)
              <input
                type="password"
                className="login-input"
                value={pwd.next}
                onChange={(e) => setPwd((p) => ({ ...p, next: e.target.value }))}
                autoComplete="new-password"
              />
            </label>
            <label className="cabinet-input-label">
              Повтор нового пароля
              <input
                type="password"
                className="login-input"
                value={pwd.next2}
                onChange={(e) => setPwd((p) => ({ ...p, next2: e.target.value }))}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="cabinet-actions">
            <Button type="button" variant="primary" onClick={savePassword} disabled={savingPwd}>
              {savingPwd ? 'Сохранение…' : 'Сменить пароль'}
            </Button>
          </div>
        </section>
      )}

      <section className="cabinet-section">
        <h2 className="cabinet-section-title">Ваш профиль</h2>
        <p className="cabinet-hint">ФИО, телефон и почта входа в систему.</p>
        <div className="cabinet-form-grid">
          <label className="cabinet-input-label">
            ФИО
            <input
              type="text"
              className="login-input"
              value={personal.fullName}
              onChange={(e) => setPersonal((p) => ({ ...p, fullName: e.target.value }))}
              autoComplete="name"
            />
          </label>
          <label className="cabinet-input-label">
            Телефон
            <input
              type="tel"
              className="login-input"
              value={personal.phone}
              onChange={(e) => setPersonal((p) => ({ ...p, phone: e.target.value }))}
              autoComplete="tel"
            />
          </label>
          <label className="cabinet-input-label">
            Почта (логин)
            <input type="email" className="login-input" value={personal.email} disabled readOnly />
          </label>
        </div>
        <div className="cabinet-actions">
          <Button type="button" variant="primary" onClick={savePersonal} disabled={savingPersonal}>
            {savingPersonal ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </section>
    </div>
  );
}
