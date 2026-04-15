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
  const { login } = useAuth();
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
          setError('Этот пользователь не является администратором продукта. Используйте обычный вход.');
          return;
        }
        navigate('/platform/accounts', { replace: true });
        return;
      }
      if (result?.user?.role && String(result.user.role) === 'admin') {
        setError('Для администратора продукта используйте отдельный вход: /platform-login');
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(
        err?.message ||
          err?.response?.data?.message ||
          'Ошибка входа'
      );
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
