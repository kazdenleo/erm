/**
 * Обязательная смена временного пароля после регистрации или выдачи временного пароля.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { authApi } from '../../services/auth.api.js';
import { Button } from '../../components/common/Button/Button';
import '../Login/Login.css';

export function FirstLoginChangePassword() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('Новый пароль: не менее 8 символов');
      return;
    }
    if (newPassword !== newPassword2) {
      setError('Новые пароли не совпадают');
      return;
    }
    setSubmitting(true);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword);
      if (!res?.ok) {
        throw new Error(res?.message || 'Не удалось сменить пароль');
      }
      await refreshUser();
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          'Ошибка смены пароля'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card card">
        <h1 className="login-title">Смена пароля</h1>
        <p className="login-subtitle">
          Здравствуйте{user?.fullName ? `, ${user.fullName}` : ''}. Введите пароль из письма и задайте новый.
        </p>
        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          <label className="login-label">
            Текущий пароль (из письма)
            <input
              type="password"
              className="login-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <label className="login-label">
            Новый пароль
            <input
              type="password"
              className="login-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <label className="login-label">
            Новый пароль ещё раз
            <input
              type="password"
              className="login-input"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <Button type="submit" disabled={submitting} className="login-submit">
            {submitting ? 'Сохранение…' : 'Сохранить и продолжить'}
          </Button>
        </form>
      </div>
    </div>
  );
}
