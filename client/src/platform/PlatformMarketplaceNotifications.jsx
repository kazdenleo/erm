/**
 * Журнал уведомлений маркетплейсов и ключи приёма (супер-админ).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { platformMarketplaceNotificationsApi } from '../services/platformMarketplaceNotifications.api.js';
import { Button } from '../components/common/Button/Button';
import './platform.css';

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}

function emptyForm() {
  return {
    ingestKey: '',
    ozon: { webhookSecret: '', clientId: '', comment: '' },
    wildberries: { token: '', comment: '' },
    yandex: { webhookSecret: '', comment: '' },
  };
}

export function PlatformMarketplaceNotifications() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [hookPath, setHookPath] = useState('/api/hooks/marketplaces');
  const [form, setForm] = useState(emptyForm);
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const pageSize = 50;
  const [openId, setOpenId] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await platformMarketplaceNotificationsApi.getSettings();
      if (s?.ok && s?.data?.secrets) {
        setForm({ ...emptyForm(), ...s.data.secrets });
        if (s.data.hookPath) setHookPath(s.data.hookPath);
        setHint(s.data.hookHint || '');
      }
      const e = await platformMarketplaceNotificationsApi.listEvents({ limit: pageSize, offset });
      if (e?.ok && e?.data) {
        setEvents(Array.isArray(e.data.items) ? e.data.items : []);
        setTotal(typeof e.data.total === 'number' ? e.data.total : 0);
      } else {
        setEvents([]);
        setTotal(0);
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
      setEvents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await platformMarketplaceNotificationsApi.putSettings(form);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const originHint = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}${hookPath}`;
  }, [hookPath]);

  const pageCount = total <= 0 ? 1 : Math.ceil(total / pageSize);
  const pageMax = Math.max(0, pageCount - 1);
  const pageIndex = Math.min(Math.floor(offset / pageSize), pageMax);

  return (
    <div className="platform-page platform-mp-notifications">
      <h1 className="title">Уведомления маркетплейсов</h1>
      <p className="platform-muted" style={{ marginBottom: '1rem', maxWidth: '52rem' }}>
        Журнал входящих событий по API (вебхуки и push). Укажите общий ключ приёма и при необходимости отдельные поля под
        ключи Ozon, Wildberries и Яндекс Маркет — они понадобятся, когда подключим конкретные схемы уведомлений.
      </p>

      {error ? (
        <div className="error" style={{ marginBottom: '12px' }}>
          {error}
        </div>
      ) : null}

      <section className="platform-mp-card" style={{ marginBottom: '1.25rem' }}>
        <h2 className="platform-mp-card__title">URL приёма</h2>
        <p className="platform-muted" style={{ marginBottom: '0.5rem', fontSize: '0.88rem' }}>
          {hint || 'Заголовок X-Platform-Ingest-Key обязателен, если задан общий ключ ниже (или переменная PLATFORM_MP_INGEST_KEY на сервере).'}
        </p>
        <code className="platform-mp-code">{originHint}</code>
      </section>

      <section className="platform-mp-card" style={{ marginBottom: '1.25rem' }}>
        <h2 className="platform-mp-card__title">Ключи (настройте под интеграции)</h2>
        <div className="platform-mp-fields">
          <label className="platform-mp-label">
            Общий ключ приёма (X-Platform-Ingest-Key)
            <input
              type="password"
              autoComplete="new-password"
              className="platform-mp-input"
              value={form.ingestKey ?? ''}
              onChange={(ev) => setForm((f) => ({ ...f, ingestKey: ev.target.value }))}
              placeholder="Задайте до включения вебхуков на стороне маркетплейса"
            />
          </label>

          <h3 className="platform-mp-subtitle">Ozon</h3>
          <label className="platform-mp-label">
            Секрет вебхука (заполните позже)
            <input
              type="password"
              className="platform-mp-input"
              value={form.ozon?.webhookSecret ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  ozon: { ...f.ozon, webhookSecret: ev.target.value },
                }))
              }
              placeholder=""
            />
          </label>
          <label className="platform-mp-label">
            Client ID API (если потребуется для подписи)
            <input
              type="text"
              className="platform-mp-input"
              value={form.ozon?.clientId ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  ozon: { ...f.ozon, clientId: ev.target.value },
                }))
              }
              placeholder=""
            />
          </label>
          <label className="platform-mp-label">
            Комментарий
            <input
              type="text"
              className="platform-mp-input"
              value={form.ozon?.comment ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  ozon: { ...f.ozon, comment: ev.target.value },
                }))
              }
              placeholder="Например, ссылка на документацию Ozon"
            />
          </label>

          <h3 className="platform-mp-subtitle">Wildberries</h3>
          <label className="platform-mp-label">
            Токен / ключ API уведомлений (заполните позже)
            <input
              type="password"
              className="platform-mp-input"
              value={form.wildberries?.token ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  wildberries: { ...f.wildberries, token: ev.target.value },
                }))
              }
              placeholder=""
            />
          </label>
          <label className="platform-mp-label">
            Комментарий
            <input
              type="text"
              className="platform-mp-input"
              value={form.wildberries?.comment ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  wildberries: { ...f.wildberries, comment: ev.target.value },
                }))
              }
              placeholder=""
            />
          </label>

          <h3 className="platform-mp-subtitle">Яндекс Маркет</h3>
          <label className="platform-mp-label">
            Секрет вебхука / уведомлений (заполните позже)
            <input
              type="password"
              className="platform-mp-input"
              value={form.yandex?.webhookSecret ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  yandex: { ...f.yandex, webhookSecret: ev.target.value },
                }))
              }
              placeholder=""
            />
          </label>
          <label className="platform-mp-label">
            Комментарий
            <input
              type="text"
              className="platform-mp-input"
              value={form.yandex?.comment ?? ''}
              onChange={(ev) =>
                setForm((f) => ({
                  ...f,
                  yandex: { ...f.yandex, comment: ev.target.value },
                }))
              }
              placeholder=""
            />
          </label>
        </div>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button type="button" variant="primary" onClick={save} disabled={saving || loading}>
            {saving ? 'Сохранение…' : 'Сохранить настройки'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => loadAll()} disabled={loading}>
            Обновить журнал
          </Button>
        </div>
      </section>

      <section className="platform-mp-card">
        <h2 className="platform-mp-card__title">Журнал событий</h2>
        {loading ? (
          <p className="platform-muted">Загрузка…</p>
        ) : events.length === 0 ? (
          <p className="platform-muted">Пока нет записей. После настройки вебхуков события появятся здесь.</p>
        ) : (
          <>
            <div className="platform-mp-table-wrap">
              <table className="platform-mp-table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Источник</th>
                    <th>Тип</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {events.map((row) => (
                    <React.Fragment key={row.id}>
                      <tr>
                        <td>{formatDate(row.createdAt)}</td>
                        <td>{row.source}</td>
                        <td>{row.eventType || '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="platform-mp-link-btn"
                            onClick={() => setOpenId((id) => (id === row.id ? null : row.id))}
                          >
                            {openId === row.id ? 'Скрыть' : 'Тело'}
                          </button>
                        </td>
                      </tr>
                      {openId === row.id ? (
                        <tr className="platform-mp-row-detail">
                          <td colSpan={4}>
                            <pre className="platform-mp-pre">{JSON.stringify(row.payload ?? {}, null, 2)}</pre>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="platform-mp-pager">
              <span className="platform-muted">
                Всего: {total}. Стр. {pageIndex + 1} из {Math.max(1, pageMax + 1)}
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={offset <= 0}
                  onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
                >
                  Назад
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={offset + pageSize >= total}
                  onClick={() => setOffset((o) => o + pageSize)}
                >
                  Вперёд
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
