/**
 * Регистрация новых администраторов аккаунта (не администраторов системы).
 * Доступно только администратору аккаунта: isProfileAdmin и не role === 'admin'.
 */

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext.jsx';
import { usersApi } from '../../../services/users.api.js';
import { Button } from '../../../components/common/Button/Button';
import './RegisterAccountAdmin.css';

export function RegisterAccountAdmin() {
  const { user, isAdmin, isProfileAdmin, profileId } = useAuth();
  const navigate = useNavigate();
  const accountName = user?.profile?.name ?? '';

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const allowed = isProfileAdmin && profileId != null && !isAdmin;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!allowed) return;

    const em = email.trim();
    const fn = fullName.trim();
    if (!em) {
      setError('Укажите электронную почту (логин)');
      return;
    }
    if (!fn) {
      setError('Укажите ФИО');
      return;
    }
    if (!password || password.length < 8) {
      setError('Пароль: не менее 8 символов');
      return;
    }

    setSubmitting(true);
    try {
      await usersApi.create({
        email: em,
        password,
        fullName: fn,
        phone: phone.trim() || undefined,
        role: 'user',
        profileId,
        isProfileAdmin: true,
      });
      navigate('/settings/users', { replace: true });
    } catch (err) {
      setError(
        err?.response?.data?.message || err?.message || 'Не удалось создать пользователя'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!allowed) {
    return (
      <div className="card register-account-admin-page">
        <h1 className="title">Регистрация администраторов аккаунта</h1>
        <p className="subtitle text-muted">
          Этот раздел предназначен для администраторов аккаунта. Администраторы системы создают
          аккаунты и пользователей в своей консоли.
        </p>
        <Link to="/settings/users" className="btn btn-primary">
          К пользователям
        </Link>
      </div>
    );
  }

  return (
    <div className="card register-account-admin-page">
      <h1 className="title">Регистрация администраторов аккаунта</h1>
      <p className="subtitle text-muted">
        Новый пользователь получит права администратора вашего аккаунта и сможет входить по указанной
        почте и паролю.
      </p>

      <form className="register-account-admin-form" onSubmit={handleSubmit}>
        {error && (
          <div className="register-account-admin-error" role="alert">
            {error}
          </div>
        )}

        <label className="register-account-admin-label">
          Название
          <input
            type="text"
            className="form-control register-account-admin-input"
            value={accountName}
            readOnly
            disabled
            title="Название текущего аккаунта"
          />
        </label>

        <label className="register-account-admin-label">
          Электронная почта <span className="register-account-admin-req">*</span>
          <input
            type="email"
            className="form-control register-account-admin-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            required
          />
        </label>

        <label className="register-account-admin-label">
          Телефон
          <input
            type="tel"
            className="form-control register-account-admin-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
        </label>

        <label className="register-account-admin-label">
          ФИО <span className="register-account-admin-req">*</span>
          <input
            type="text"
            className="form-control register-account-admin-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
            required
          />
        </label>

        <label className="register-account-admin-label">
          Пароль <span className="register-account-admin-req">*</span>
          <input
            type="password"
            className="form-control register-account-admin-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <p className="register-account-admin-hint small text-muted">Не менее 8 символов.</p>

        <div className="register-account-admin-actions">
          <Link to="/settings/users" className="btn btn-outline-secondary">
            Отмена
          </Link>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Создание…' : 'Зарегистрировать администратора'}
          </Button>
        </div>
      </form>
    </div>
  );
}
