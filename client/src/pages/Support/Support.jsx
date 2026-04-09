/**
 * Обращения в поддержку (пользователь аккаунта)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { inquiriesApi } from '../../services/inquiries.api.js';
import { Button } from '../../components/common/Button/Button';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import './Support.css';

export function Support() {
  const { profileId, loading: authLoading, isAdmin, refreshUser } = useAuth();
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (profileId == null || profileId === '') return;
    setLoading(true);
    setError('');
    try {
      const res = await inquiriesApi.list();
      if (res?.ok) setList(res.data || []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t && files.length === 0) {
      setError('Введите текст или прикрепите файл');
      return;
    }
    setSending(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('body', t);
      for (const f of files) {
        fd.append('files', f);
      }
      const res = await inquiriesApi.create(fd);
      if (res?.ok) {
        setText('');
        setFiles([]);
        await load();
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось отправить');
    } finally {
      setSending(false);
    }
  };

  if (authLoading) {
    return (
      <div className="card">
        <PageTitle title="Обращение в техподдержку" />
        <p className="text-muted">Загрузка…</p>
      </div>
    );
  }

  const hasProfile = profileId != null && profileId !== '';

  if (!hasProfile) {
    return (
      <div className="card">
        <PageTitle title="Обращение в техподдержку" />
        <p className="text-muted">
          Не удалось определить ваш аккаунт (профиль) для обращений: в учётной записи нет привязки к профилю в базе,
          не выбрана организация в приложении или не совпадают данные. Выберите организацию в шапке/настройках, если
          есть список, и обновите страницу. Администратор аккаунта может проверить привязку в «Настройки → Пользователи».
        </p>
        {isAdmin && (
          <p className="mt-2 mb-0">
            Для администратора продукта без привязки к аккаунту: очередь обращений — в{' '}
            <Link to="/platform/inquiries">админке продукта → Обращения</Link>.
          </p>
        )}
        <p className="mt-3 mb-0">
          <Button type="button" variant="secondary" size="small" onClick={() => refreshUser()}>
            Обновить данные сессии
          </Button>
          <span className="text-muted small ms-2">после выбора организации или исправления привязки</span>
        </p>
      </div>
    );
  }

  return (
    <div>
      <PageTitle title="Обращение в техподдержку" />
      <p className="support-lead text-muted">
        Опишите вопрос и при необходимости прикрепите фото или видео. Администратор продукта увидит обращение в своей
        панели.
      </p>

      <form className="card support-form" onSubmit={submit}>
        <label className="w-100">
          Текст
          <textarea
            className="form-control mt-1"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Опишите проблему или вопрос"
          />
        </label>
        <label className="w-100 mt-2">
          Файлы (фото или видео, до 20 файлов)
          <input
            type="file"
            className="form-control mt-1"
            accept="image/*,video/mp4,video/webm,video/quicktime,.mov"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
        </label>
        {files.length > 0 && (
          <p className="small text-muted mt-1">Выбрано файлов: {files.length}</p>
        )}
        {error && <p className="text-danger mt-2 mb-0">{error}</p>}
        <div className="mt-3">
          <Button type="submit" variant="primary" disabled={sending}>
            {sending ? 'Отправка…' : 'Отправить обращение'}
          </Button>
        </div>
      </form>

      <h2 className="h5 mt-4">Мои обращения</h2>
      {loading && <p>Загрузка…</p>}
      {!loading && list.length === 0 && <p className="text-muted">Пока нет обращений.</p>}
      <ul className="list-unstyled support-list">
        {list.map((row) => (
          <li key={row.id} className="card support-card mb-2">
            <div className="support-card-head">
              <span className="support-status">{statusRu(row.status)}</span>
              <span className="text-muted small">{formatDate(row.created_at)}</span>
            </div>
            <p className="support-body-text mb-0">{row.body_text || '—'}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusRu(s) {
  if (s === 'in_progress') return 'В работе';
  if (s === 'completed') return 'Завершён';
  return 'Новый';
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}
