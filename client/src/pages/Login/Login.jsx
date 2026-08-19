/**
 * Login Page
 * Страница входа в систему
 */

import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button } from '../../components/common/Button/Button';
import './Login.css';

export function Login({ mode = 'user' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || (mode === 'platform' ? '/platform/accounts' : '/');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result?.mustChangePassword) {
        navigate('/first-login-change-password', { replace: true });
        return;
      }
      // Раздельные входы: platform-login → только в админку продукта; login → только в ERP.
      if (mode === 'platform') {
        if (result?.user?.role && String(result.user.role) !== 'admin') {
          logout();
          setError('Этот пользователь не является администратором продукта. Используйте обычный вход.');
          return;
        }
        navigate('/platform/accounts', { replace: true });
        return;
      }
      if (result?.user?.role && String(result.user.role) === 'admin') {
        logout();
        setError('Для администратора продукта используйте отдельный вход: /platform-login');
        return;
      }
      navigate(from && from.startsWith('/platform') ? '/' : from, { replace: true });
    } catch (err) {
      const status = err?.response?.status;
      const serverMsg = err?.response?.data?.message;
      let msg = serverMsg || err?.message || 'Ошибка входа';
      if (
        !serverMsg &&
        (err?.code === 'ERR_NETWORK' ||
          err?.code === 'ECONNREFUSED' ||
          (status === 500 && String(err?.message || '').includes('status code 500')))
      ) {
        msg =
          'Сервер API недоступен. Убедитесь, что backend запущен (cd server && npm run dev) или повторите попытку через минуту.';
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card card">
        <h1 className="login-title">{mode === 'platform' ? 'Вход администратора продукта' : 'Вход в систему'}</h1>
        <p className="login-subtitle">ERP Demo</p>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          <label className="login-label">
            Логин
            <input
              type="text"
              className="login-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label className="login-label">
            Пароль
            <input
              type="password"
              className="login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <Button type="submit" disabled={submitting} className="login-submit">
            {submitting ? 'Вход...' : 'Войти'}
          </Button>
          {mode !== 'platform' && (
            <p className="login-footer-text">
              Нет аккаунта? <Link to="/register">Регистрация</Link>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
