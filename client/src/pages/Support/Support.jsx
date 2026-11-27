/**
 * Обращения в поддержку и идеи (пользователь аккаунта)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { inquiriesApi } from '../../services/inquiries.api.js';
import { Button } from '../../components/common/Button/Button';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import './Support.css';

const MAX_INQUIRY_FILES = 20;

function clipboardImagesToFiles(clipboardData) {
  if (!clipboardData) return [];
  const out = [];
  const items = clipboardData.items ? Array.from(clipboardData.items) : [];
  for (const item of items) {
    if (!item || item.kind !== 'file') continue;
    const type = String(item.type || '');
    if (!type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const ext = type.includes('png')
      ? 'png'
      : type.includes('jpeg') || type.includes('jpg')
        ? 'jpg'
        : type.includes('webp')
          ? 'webp'
          : type.includes('gif')
            ? 'gif'
            : 'png';
    const name = `clipboard-${Date.now()}-${out.length + 1}.${ext}`;
    out.push(new File([blob], name, { type: blob.type || type, lastModified: Date.now() }));
  }
  if (out.length === 0 && clipboardData.files?.length) {
    for (const f of Array.from(clipboardData.files)) {
      if (f && String(f.type || '').startsWith('image/')) out.push(f);
    }
  }
  return out;
}

export function Support() {
  const { profileId, loading: authLoading, isAdmin, refreshUser } = useAuth();
  const [kind, setKind] = useState('support');
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pasteHint, setPasteHint] = useState('');
  const fileInputRef = useRef(null);

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

  const [filePreviewUrls, setFilePreviewUrls] = useState([]);

  useEffect(() => {
    const urls = files.map((f) =>
      f && String(f.type || '').startsWith('image/') ? URL.createObjectURL(f) : null
    );
    setFilePreviewUrls(urls);
    return () => {
      for (const url of urls) {
        if (!url) continue;
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
    };
  }, [files]);

  const addFiles = useCallback((incoming) => {
    const listIn = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
    if (listIn.length === 0) return { added: 0, truncated: false };
    let truncated = false;
    let added = 0;
    setFiles((prev) => {
      const room = Math.max(0, MAX_INQUIRY_FILES - prev.length);
      if (room <= 0) {
        truncated = true;
        return prev;
      }
      const slice = listIn.slice(0, room);
      added = slice.length;
      if (listIn.length > room) truncated = true;
      return [...prev, ...slice];
    });
    return { added, truncated };
  }, []);

  const removeFileAt = useCallback((index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const onPasteFiles = useCallback(
    (e) => {
      const pasted = clipboardImagesToFiles(e.clipboardData);
      if (pasted.length === 0) return;
      e.preventDefault();
      const { added, truncated } = addFiles(pasted);
      if (added > 0) {
        setPasteHint(
          added === 1 ? 'Изображение из буфера добавлено' : `Добавлено изображений из буфера: ${added}`
        );
        setError('');
      }
      if (truncated) {
        setError(`Можно прикрепить не больше ${MAX_INQUIRY_FILES} файлов`);
      }
    },
    [addFiles]
  );

  const submit = async (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t && files.length === 0) {
      setError('Введите текст или прикрепите файл');
      return;
    }
    setSending(true);
    setError('');
    setPasteHint('');
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
        setPasteHint('');
        if (fileInputRef.current) fileInputRef.current.value = '';
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
            onPaste={onPasteFiles}
            placeholder={
              isIdea
                ? 'Кратко опишите идею: что хотите добавить или изменить и зачем это нужно'
                : 'Опишите проблему или вопрос'
            }
          />
        </label>
        <p className="small text-muted mt-1 mb-0">
          Скриншот можно вставить из буфера: скопируйте изображение и нажмите Ctrl+V (⌘V) в поле текста.
        </p>
        <label className="w-100 mt-2">
          Файлы (фото или видео, до {MAX_INQUIRY_FILES})
          <input
            ref={fileInputRef}
            type="file"
            className="form-control mt-1"
            accept="image/*,video/mp4,video/webm,video/quicktime,.mov"
            multiple
            onChange={(e) => {
              const picked = Array.from(e.target.files || []);
              const { truncated } = addFiles(picked);
              if (truncated) setError(`Можно прикрепить не больше ${MAX_INQUIRY_FILES} файлов`);
              e.target.value = '';
            }}
          />
        </label>
        {pasteHint ? <p className="small text-success mt-1 mb-0">{pasteHint}</p> : null}
        {files.length > 0 && (
          <div className="support-attachments mt-2">
            <p className="small text-muted mb-1">Выбрано файлов: {files.length}</p>
            <ul className="support-attachments-list">
              {files.map((f, idx) => {
                const previewUrl = filePreviewUrls[idx];
                return (
                  <li key={`${f.name}-${f.size}-${f.lastModified}-${idx}`} className="support-attachment-item">
                    {previewUrl ? (
                      <img src={previewUrl} alt="" className="support-attachment-thumb" />
                    ) : (
                      <span className="support-attachment-fileicon" aria-hidden>
                        ▣
                      </span>
                    )}
                    <span className="support-attachment-name" title={f.name}>
                      {f.name}
                    </span>
                    <button
                      type="button"
                      className="support-attachment-remove"
                      onClick={() => removeFileAt(idx)}
                      aria-label={`Убрать ${f.name}`}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
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
