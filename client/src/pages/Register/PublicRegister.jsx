/**
 * Публичная регистрация аккаунта: название, телефон, ФИО, пароль.
 * Email необязателен. Вход — по телефону и паролю.
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../../services/auth.api.js';
import { Button } from '../../components/common/Button/Button';
import '../Login/Login.css';

export function PublicRegister() {
  const [accountName, setAccountName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
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
    setSubmitting(true);
    try {
      const res = await authApi.registerAccount({
        accountName: accountName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim(),
        fullName: fullName.trim(),
        password,
      });
      if (res?.ok) {
        setSuccess(res.message || 'Аккаунт создан. Войдите по телефону или email.');
        setAccountName('');
        setEmail('');
        setPhone('');
        setFullName('');
        setPassword('');
        setPassword2('');
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

  return (
    <div className="login-page">
      <div className="login-card card" style={{ maxWidth: 440 }}>
        <h1 className="login-title">Регистрация</h1>
        <p className="login-subtitle">Создание личного кабинета аккаунта</p>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          {success && (
            <div className="login-error" style={{ background: '#e8f4ec', color: '#1e7e34' }}>
              {success}
            </div>
          )}
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
          <Button type="submit" disabled={submitting} className="login-submit">
            {submitting ? 'Отправка…' : 'Зарегистрироваться'}
          </Button>
          <p className="login-footer-text">
            Уже есть аккаунт? <Link to="/login">Вход</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
