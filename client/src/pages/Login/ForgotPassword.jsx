/**
 * Запрос ссылки восстановления пароля
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../../services/auth.api.js';
import { Button } from '../../components/common/Button/Button';
import './Login.css';

export function ForgotPassword() {
  const [login, setLogin] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!login.trim()) {
      setError('Укажите email или телефон');
      return;
    }
    setSubmitting(true);
    try {
      const res = await authApi.forgotPassword(login.trim());
      setSuccess(res?.message || 'Если аккаунт найден — проверьте почту.');
    } catch (err) {
      setError(
        err?.response?.data?.message || err?.message || 'Не удалось отправить запрос'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card card">
        <h1 className="login-title">Восстановление пароля</h1>
        <p className="login-subtitle">
          Укажите email или телефон аккаунта. Ссылку отправим на email, если он указан в профиле.
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          {success && (
            <div className="login-error" style={{ background: 'rgba(34,139,34,0.12)', color: 'inherit' }}>
              {success}
            </div>
          )}
          <label className="login-label">
            Email или телефон
            <input
              type="text"
              className="login-input"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              required
              autoComplete="username"
              placeholder="email@example.com или +7…"
            />
          </label>
          <Button type="submit" disabled={submitting} className="login-submit">
            {submitting ? 'Отправка…' : 'Отправить ссылку'}
          </Button>
          <p className="login-footer-text">
            <Link to="/login">← Ко входу</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
