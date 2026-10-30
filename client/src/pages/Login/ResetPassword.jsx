/**
 * Установка нового пароля по токену из письма
 */

import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../../services/auth.api.js';
import { Button } from '../../components/common/Button/Button';
import './Login.css';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = useMemo(() => String(searchParams.get('token') || '').trim(), [searchParams]);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!token) {
      setError('В ссылке нет токена. Запросите восстановление снова.');
      return;
    }
    if (password.length < 8) {
      setError('Пароль: не менее 8 символов');
      return;
    }
    if (password !== password2) {
      setError('Пароль и подтверждение не совпадают');
      return;
    }
    setSubmitting(true);
    try {
      const res = await authApi.resetPassword(token, password);
      setSuccess(res?.message || 'Пароль обновлён.');
      setTimeout(() => navigate('/login', { replace: true }), 1500);
    } catch (err) {
      setError(
        err?.response?.data?.message || err?.message || 'Не удалось сменить пароль'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card card">
        <h1 className="login-title">Новый пароль</h1>
        <p className="login-subtitle">Задайте пароль для входа в личный кабинет.</p>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          {success && (
            <div className="login-error" style={{ background: 'rgba(34,139,34,0.12)', color: 'inherit' }}>
              {success}
            </div>
          )}
          {!token && (
            <div className="login-error">Ссылка повреждена. Откройте её из письма целиком.</div>
          )}
          <label className="login-label">
            Новый пароль
            <input
              type="password"
              className="login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              disabled={!token || !!success}
            />
          </label>
          <label className="login-label">
            Повтор пароля
            <input
              type="password"
              className="login-input"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              disabled={!token || !!success}
            />
          </label>
          <Button type="submit" disabled={submitting || !token || !!success} className="login-submit">
            {submitting ? 'Сохранение…' : 'Сохранить пароль'}
          </Button>
          <p className="login-footer-text">
            <Link to="/forgot-password">Запросить ссылку снова</Link>
            {' · '}
            <Link to="/login">Вход</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
