/**
 * Публичная регистрация аккаунта: название, почта, телефон, ФИО.
 * Пароль приходит на email; при первом входе требуется смена пароля.
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
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSubmitting(true);
    try {
      const res = await authApi.registerAccount({
        accountName: accountName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        fullName: fullName.trim(),
      });
      if (res?.ok) {
        setSuccess(res.message || 'Регистрация прошла успешно. Проверьте почту.');
        setAccountName('');
        setEmail('');
        setPhone('');
        setFullName('');
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
            Электронная почта
            <input
              type="email"
              className="login-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label className="login-label">
            Телефон
            <input
              type="tel"
              className="login-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
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
          <p className="login-footer-text" style={{ textAlign: 'left', marginTop: 0 }}>
            На почту будет отправлен временный пароль. После входа его нужно будет сменить.
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
