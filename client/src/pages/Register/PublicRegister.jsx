/**
 * Публичная регистрация аккаунта: название, телефон, ФИО, пароль.
 * Email необязателен. Вход — по телефону и паролю.
 * При PUBLIC_SIGNUP_ENABLED=0 показывается сообщение о закрытой бете.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../../services/auth.api.js';
import { Button } from '../../components/common/Button/Button';
import api from '../../services/api.js';
import '../Login/Login.css';

export function PublicRegister() {
  const [accountName, setAccountName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [acceptOffer, setAcceptOffer] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(null);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/config');
        const data = res?.data?.data || res?.data || {};
        if (cancelled) return;
        setSignupEnabled(data.publicSignupEnabled === true);
        setTurnstileSiteKey(String(data.turnstileSiteKey || '').trim());
      } catch {
        if (!cancelled) setSignupEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!turnstileSiteKey || !signupEnabled) return undefined;
    const w = window;
    if (w.turnstile) {
      try {
        w.turnstile.render('#erm-turnstile', {
          sitekey: turnstileSiteKey,
          callback: (token) => setTurnstileToken(token || ''),
        });
      } catch {
        /* ignore */
      }
      return undefined;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      try {
        window.turnstile?.render('#erm-turnstile', {
          sitekey: turnstileSiteKey,
          callback: (token) => setTurnstileToken(token || ''),
        });
      } catch {
        /* ignore */
      }
    };
    document.body.appendChild(script);
    return () => {
      try {
        script.remove();
      } catch {
        /* ignore */
      }
    };
  }, [turnstileSiteKey, signupEnabled]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!signupEnabled) {
      setError('Публичная регистрация временно закрыта.');
      return;
    }
    if (!phone.trim()) {
      setError('Укажите номер телефона');
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
    if (!acceptOffer) {
      setError('Нужно принять оферту и политику конфиденциальности');
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError('Пройдите проверку «я не робот»');
      return;
    }
    setSubmitting(true);
    try {
      const res = await authApi.registerAccount({
        accountName: accountName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim(),
        fullName: fullName.trim(),
        password,
        acceptOffer: true,
        turnstileToken: turnstileToken || undefined,
        website: '', // honeypot
      });
      if (res?.ok) {
        setSuccess(res.message || 'Аккаунт создан. Войдите по телефону или email.');
        setAccountName('');
        setEmail('');
        setPhone('');
        setFullName('');
        setPassword('');
        setPassword2('');
        setAcceptOffer(false);
      } else {
        setError(res?.message || 'Не удалось зарегистрироваться');
      }
    } catch (err) {
      setError(
        err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          'Ошибка регистрации'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (signupEnabled === null) {
    return (
      <div className="login-page">
        <div className="login-card card" style={{ maxWidth: 440 }}>
          <h1 className="login-title">Регистрация</h1>
          <p className="login-subtitle">Загрузка…</p>
        </div>
      </div>
    );
  }

  if (!signupEnabled) {
    return (
      <div className="login-page">
        <div className="login-card card" style={{ maxWidth: 440 }}>
          <h1 className="login-title">Регистрация закрыта</h1>
          <p className="login-subtitle">
            Сейчас идёт закрытая бета. Аккаунт создаёт администратор платформы.
            Напишите в поддержку или{' '}
            <Link to="/pricing">посмотрите тарифы</Link>.
          </p>
          <p className="login-footer-text">
            Уже есть аккаунт? <Link to="/login">Вход</Link>
          </p>
          <p className="login-footer-text">
            <Link to="/">← На главную</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card card" style={{ maxWidth: 440 }}>
        <h1 className="login-title">Регистрация</h1>
        <p className="login-subtitle">
          <Link to="/">Программа Ирина</Link> — создание личного кабинета.
          7 дней бесплатно (тариф «Бизнес»).{' '}
          <Link to="/offer">Оферта</Link>
          {' · '}
          <Link to="/privacy">Конфиденциальность</Link>
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          {success && (
            <div className="login-error" style={{ background: '#e8f4ec', color: '#1e7e34' }}>
              {success}
            </div>
          )}
          {/* honeypot */}
          <input
            type="text"
            name="website"
            value=""
            readOnly
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            style={{ position: 'absolute', left: '-9999px', height: 0, width: 0, opacity: 0 }}
          />
          <label className="login-label">
            Название аккаунта
            <input
              type="text"
              className="login-input"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              required
              minLength={2}
              autoComplete="organization"
            />
          </label>
          <label className="login-label">
            Телефон
            <input
              type="tel"
              className="login-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              autoComplete="tel"
              placeholder="+7 999 123-45-67"
            />
          </label>
          <label className="login-label">
            Электронная почта
            <input
              type="email"
              className="login-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="login-label">
            ФИО
            <input
              type="text"
              className="login-input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              minLength={2}
              autoComplete="name"
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
              minLength={8}
              autoComplete="new-password"
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
            />
          </label>
          <p className="login-footer-text" style={{ textAlign: 'left', marginTop: 0 }}>
            Вход в систему — по телефону или email и паролю. Телефон обязателен, почта необязательна.
          </p>
          <label
            className="login-label"
            style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}
          >
            <input
              type="checkbox"
              checked={acceptOffer}
              onChange={(e) => setAcceptOffer(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span>
              Принимаю <Link to="/offer">оферту</Link> и{' '}
              <Link to="/privacy">политику конфиденциальности</Link>
            </span>
          </label>
          {turnstileSiteKey ? <div id="erm-turnstile" style={{ margin: '8px 0' }} /> : null}
          <Button type="submit" disabled={submitting} className="login-submit">
            {submitting ? 'Отправка…' : 'Зарегистрироваться'}
          </Button>
          <p className="login-footer-text">
            Уже есть аккаунт? <Link to="/login">Вход</Link>
          </p>
          <p className="login-footer-text">
            <Link to="/">← На главную</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
