/**
 * Очередь обращений — администратор продукта
 */

import React, { useState, useEffect, useCallback } from 'react';
import { inquiriesApi } from '../services/inquiries.api.js';
import api from '../services/api.js';
import { Button } from '../components/common/Button/Button';
import { Modal } from '../components/common/Modal/Modal';
import './platform.css';

const STATUS_OPTIONS = [
  { value: 'new', label: 'Новый' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'completed', label: 'Завершён' },
];

function statusLabel(v) {
  return STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}

function MediaPreview({ inquiryId, attachment }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let blobUrl;
    (async () => {
      try {
        const res = await api.get(
          `/inquiries/${inquiryId}/attachments/${attachment.id}/file`,
          { responseType: 'blob' }
        );
        if (cancelled) return;
        blobUrl = URL.createObjectURL(res.data);
        setUrl(blobUrl);
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [inquiryId, attachment.id]);

  if (!url) return <span className="platform-muted">загрузка…</span>;
  const isVideo = String(attachment.mime_type || '').startsWith('video/');
  if (isVideo) {
    return <video className="platform-inq-video" controls src={url} />;
  }
  return <img className="platform-inq-img" alt="" src={url} />;
}

export function PlatformInquiries() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [replySaving, setReplySaving] = useState(false);
  const [replyMessage, setReplyMessage] = useState('');

  const load = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (id) => {
    setDetail(null);
    setReplyDraft('');
    setReplyMessage('');
    setDetailLoading(true);
    try {
      const res = await inquiriesApi.getById(id);
      if (res?.ok) {
        setDetail(res.data);
        setReplyDraft(res.data?.admin_reply || '');
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailLoading(false);
    setReplyDraft('');
    setReplyMessage('');
  };

  const saveReply = async () => {
    if (!detail?.id) return;
    setReplySaving(true);
    setReplyMessage('');
    setError('');
    try {
      const res = await inquiriesApi.reply(detail.id, { reply: replyDraft });
      if (res?.ok) {
        setDetail(res.data);
        setReplyDraft(res.data?.admin_reply || '');
        setReplyMessage(res.data?.admin_reply ? 'Ответ сохранён. Пользователь увидит его в «Поддержке».' : 'Ответ очищен.');
        await load();
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сохранить ответ');
    } finally {
      setReplySaving(false);
    }
  };

  const changeStatus = async (id, status) => {
    setSavingId(id);
    setError('');
    try {
      const res = await inquiriesApi.updateStatus(id, status);
      if (res?.ok) {
        await load();
        if (detail && String(detail.id) === String(id)) {
          setDetail((d) => (d ? { ...d, status: res.data.status } : d));
        }
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сохранить');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="platform-page card">
      <h1 className="title">Обращения</h1>
      <p className="platform-muted" style={{ marginBottom: '1rem' }}>
        Все обращения пользователей по аккаунтам. Можно ответить в карточке обращения и сменить статус.
      </p>

      {error && <p className="text-danger">{error}</p>}

      {loading && <p>Загрузка…</p>}

      {!loading && list.length === 0 && !error && (
        <div className="platform-placeholder">
          <p>Обращений пока нет.</p>
        </div>
      )}

      {!loading && list.length > 0 && (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Аккаунт</th>
                <th>Автор</th>
                <th>Текст</th>
                <th>Ответ</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="text-nowrap small">{formatDate(row.created_at)}</td>
                  <td>{row.profile_name || `— (#${row.profile_id})`}</td>
                  <td className="small">
                    {row.author_email}
                    {row.author_full_name && (
                      <span className="text-muted"> — {row.author_full_name}</span>
                    )}
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    <span className="text-truncate d-inline-block" style={{ maxWidth: 260 }} title={row.body_text}>
                      {row.body_text || '—'}
                    </span>
                  </td>
                  <td className="small">
                    {row.admin_reply ? (
                      <span className="text-success" title={row.admin_reply}>
                        есть
                      </span>
                    ) : (
                      <span className="text-muted">нет</span>
                    )}
                  </td>
                  <td style={{ minWidth: 140 }}>
                    <select
                      className="form-select form-select-sm"
                      value={row.status}
                      disabled={savingId === row.id}
                      onChange={(e) => changeStatus(row.id, e.target.value)}
                      aria-label="Статус обращения"
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Button type="button" variant="secondary" size="small" onClick={() => openDetail(row.id)}>
                      Открыть
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={!!detail || detailLoading}
        onClose={closeDetail}
        title={detail ? `Обращение #${detail.id}` : 'Загрузка…'}
        size="large"
      >
        {detailLoading && <p>Загрузка…</p>}
        {detail && (
          <div className="platform-inq-detail">
            <p className="small text-muted mb-2">
              {formatDate(detail.created_at)} · {detail.profile_name || `Профиль #${detail.profile_id}`} ·{' '}
              {detail.author_email}
            </p>
            <p className="mb-3" style={{ whiteSpace: 'pre-wrap' }}>
              {detail.body_text || '—'}
            </p>
            <p className="small mb-1">
              Статус: <strong>{statusLabel(detail.status)}</strong>
            </p>
            <div className="d-flex flex-wrap gap-2 mb-3">
              {STATUS_OPTIONS.map((o) => (
                <Button
                  key={o.value}
                  type="button"
                  size="small"
                  variant={detail.status === o.value ? 'primary' : 'secondary'}
                  disabled={savingId === detail.id}
                  onClick={() => changeStatus(detail.id, o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
            {(detail.attachments || []).length > 0 && (
              <div className="mb-3">
                <h3 className="h6">Вложения</h3>
                <div className="platform-inq-media">
                  {detail.attachments.map((a) => (
                    <MediaPreview key={a.id} inquiryId={detail.id} attachment={a} />
                  ))}
                </div>
              </div>
            )}
            <div className="platform-inq-reply">
              <h3 className="h6">Ответ пользователю</h3>
              <textarea
                className="form-control"
                rows={5}
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                placeholder="Напишите ответ — пользователь увидит его в разделе «Поддержка»"
                disabled={replySaving}
              />
              {detail.admin_replied_at ? (
                <p className="small text-muted mt-1 mb-2">
                  Сохранён {formatDate(detail.admin_replied_at)}
                  {detail.replied_by_email ? ` · ${detail.replied_by_email}` : ''}
                </p>
              ) : (
                <p className="small text-muted mt-1 mb-2">Ответа ещё нет</p>
              )}
              <div className="d-flex flex-wrap gap-2 align-items-center">
                <Button type="button" variant="primary" size="small" onClick={saveReply} disabled={replySaving}>
                  {replySaving ? 'Сохранение…' : 'Сохранить ответ'}
                </Button>
                {detail.admin_reply ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="small"
                    disabled={replySaving}
                    onClick={async () => {
                      setReplyDraft('');
                      setReplySaving(true);
                      setReplyMessage('');
                      try {
                        const res = await inquiriesApi.reply(detail.id, { reply: '' });
                        if (res?.ok) {
                          setDetail(res.data);
                          setReplyMessage('Ответ очищен.');
                          await load();
                        }
                      } catch (err) {
                        setError(err?.response?.data?.message || err?.message || 'Не удалось очистить');
                      } finally {
                        setReplySaving(false);
                      }
                    }}
                  >
                    Очистить
                  </Button>
                ) : null}
                {replyMessage ? <span className="small text-muted">{replyMessage}</span> : null}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
