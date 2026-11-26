/**
 * Обращения в поддержку и идеи (пользователь аккаунта)
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
  const [kind, setKind] = useState('support');
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
      fd.append('kind', kind === 'idea' ? 'idea' : 'support');
      for (const f of files) {
        fd.append('files', f);
      }
      const res = await inquiriesApi.create(fd);
      if (res?.ok) {
        setText('');
        setFiles([]);
        setKind('support');
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
        <PageTitle title="Поддержка и идеи" />
        <p className="text-muted">Загрузка…</p>
      </div>
    );
  }

  const hasProfile = profileId != null && profileId !== '';

  if (!hasProfile) {
    return (
      <div className="card">
        <PageTitle title="Поддержка и идеи" />
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

  const isIdea = kind === 'idea';

  return (
    <div>
      <PageTitle title="Поддержка и идеи" />
      <p className="support-lead text-muted">
        Задайте вопрос по работе системы или предложите идею. Ответ администратора продукта появится здесь же в карточке
        обращения.
      </p>

      <form className="card support-form" onSubmit={submit}>
        <fieldset className="support-kind">
          <legend className="support-kind-legend">Тип обращения</legend>
          <div className="support-kind-options" role="radiogroup" aria-label="Тип обращения">
            <label className={`support-kind-option${kind === 'support' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="inquiry-kind"
                value="support"
                checked={kind === 'support'}
                onChange={() => setKind('support')}
              />
              <span className="support-kind-title">Вопрос / проблема</span>
              <span className="support-kind-hint">Не работает, непонятно, нужна помощь</span>
            </label>
            <label className={`support-kind-option${kind === 'idea' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="inquiry-kind"
                value="idea"
                checked={kind === 'idea'}
                onChange={() => setKind('idea')}
              />
              <span className="support-kind-title">Предложить идею</span>
              <span className="support-kind-hint">Новая функция, улучшение, пожелание</span>
            </label>
          </div>
        </fieldset>

        <label className="w-100 mt-3">
          {isIdea ? 'Описание идеи' : 'Текст'}
          <textarea
            className="form-control mt-1"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              isIdea
                ? 'Кратко опишите идею: что хотите добавить или изменить и зачем это нужно'
                : 'Опишите проблему или вопрос'
            }
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
            {sending ? 'Отправка…' : isIdea ? 'Отправить идею' : 'Отправить обращение'}
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
              <div className="support-card-tags">
                <span className={`support-kind-badge${row.kind === 'idea' ? ' support-kind-badge--idea' : ''}`}>
                  {kindRu(row.kind)}
                </span>
                <span className="support-status">{statusRu(row.status)}</span>
              </div>
              <span className="text-muted small">{formatDate(row.created_at)}</span>
            </div>
            <p className="support-body-text mb-0">{row.body_text || '—'}</p>
            {row.admin_reply ? (
              <div className="support-reply">
                <div className="support-reply-head">
                  <strong>Ответ поддержки</strong>
                  {row.admin_replied_at ? (
                    <span className="text-muted small">{formatDate(row.admin_replied_at)}</span>
                  ) : null}
                </div>
                <p className="support-body-text mb-0">{row.admin_reply}</p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function kindRu(k) {
  return k === 'idea' ? 'Идея' : 'Вопрос';
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
