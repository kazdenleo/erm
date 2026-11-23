/**
 * Login Page
 * Страница входа в систему
 */

import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button } from '../../components/common/Button/Button';
import { BrandLogo } from '../../components/brand/BrandLogo.jsx';
import './Login.css';

function reasonMessage(search) {
  try {
    const reason = new URLSearchParams(search || '').get('reason');
    if (reason === 'session') {
      return 'Вы вошли с другого устройства. Эта сессия завершена — войдите снова.';
    }
    if (reason === 'daily') {
      return 'Сессия истекла: требуется повторный вход в новый день.';
    }
  } catch {
    /* ignore */
  }
  return '';
}

export function Login({ mode = 'user' }) {
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login: signIn, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || (mode === 'platform' ? '/platform/accounts' : '/');
  const reasonHint = useMemo(() => reasonMessage(location.search), [location.search]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await signIn(loginValue.trim(), password);
      if (result?.mustChangePassword) {
        navigate('/first-login-change-password', { replace: true });
        return;
      }
      // Раздельные входы: platform-login → только в админку продукта; login → только в MySell.
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
      if (result?.user?.profile?.onboarding?.completed === false) {
        navigate('/onboarding', { replace: true });
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
        <div className="login-brand">
          <Link to="/" aria-label="MySell">
            <BrandLogo height={36} />
          </Link>
        </div>
        <h1 className="login-title">{mode === 'platform' ? 'Вход администратора продукта' : 'Вход в систему'}</h1>
        <p className="login-subtitle">
          {mode === 'platform' ? (
            'Админка продукта'
          ) : (
            <>
              <Link to="/">MySell</Link> — личный кабинет
            </>
          )}
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          {(error || reasonHint) && <div className="login-error">{error || reasonHint}</div>}
          <label className="login-label">
            Email или телефон
            <input
              type="text"
              className="login-input"
              value={loginValue}
              onChange={(e) => setLoginValue(e.target.value)}
              required
              autoComplete="username"
              placeholder="email@example.com или +7…"
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
            <>
              <p className="login-footer-text">
                <Link to="/forgot-password">Забыли пароль?</Link>
              </p>
              <p className="login-footer-text">
                Нет аккаунта? <Link to="/register">Регистрация</Link>
              </p>
              <p className="login-footer-text">
                <Link to="/">← На главную</Link>
              </p>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
