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

function emptyTelegram() {
  return {
    enabled: false,
    botToken: '',
    hasBotToken: false,
    botTokenHint: '',
    chatId: '',
    events: { public_signup: true },
  };
}

function emptyForm() {
  return {
    ingestKey: '',
    ozon: { webhookSecret: '', clientId: '', comment: '' },
    wildberries: { token: '', comment: '' },
    yandex: { webhookSecret: '', comment: '' },
    telegram: emptyTelegram(),
  };
}

function normalizeTelegramFromApi(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const chatIds = Array.isArray(src.chatIds) ? src.chatIds : [];
  return {
    enabled: src.enabled === true,
    botToken: '',
    hasBotToken: src.hasBotToken === true,
    botTokenHint: typeof src.botTokenHint === 'string' ? src.botTokenHint : '',
    chatId: chatIds.join(', '),
    events: {
      public_signup: src.events?.public_signup !== false,
    },
  };
}

export function PlatformMarketplaceNotifications() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [hookPath, setHookPath] = useState('/api/hooks/marketplaces');
  const [ozonHookPath, setOzonHookPath] = useState('/api/hooks/ozon');
  const [form, setForm] = useState(emptyForm);
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const pageSize = 50;
  const [openId, setOpenId] = useState(null);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramTestMessage, setTelegramTestMessage] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await platformMarketplaceNotificationsApi.getSettings();
      if (s?.ok && s?.data?.secrets) {
        const secrets = s.data.secrets;
        setForm({
          ...emptyForm(),
          ...secrets,
          telegram: normalizeTelegramFromApi(secrets.telegram),
        });
        if (s.data.hookPath) setHookPath(s.data.hookPath);
        if (s.data.ozonHookPath) setOzonHookPath(s.data.ozonHookPath);
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
    setTelegramTestMessage('');
    try {
      const tg = form.telegram || emptyTelegram();
      const payload = {
        ...form,
        telegram: {
          enabled: tg.enabled === true,
          botToken: String(tg.botToken || '').trim(),
          chatIds: String(tg.chatId || '')
            .split(/[\s,;]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          events: {
            public_signup: tg.events?.public_signup !== false,
          },
        },
      };
      await platformMarketplaceNotificationsApi.putSettings(payload);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const testTelegram = async () => {
    const tg = form.telegram || emptyTelegram();
    setTelegramTesting(true);
    setTelegramTestMessage('');
    setError('');
    try {
      const res = await platformMarketplaceNotificationsApi.testTelegram({
        botToken: tg.botToken || '',
        chatId: tg.chatId || '',
      });
      if (!res?.ok) throw new Error(res?.message || 'Не удалось отправить');
      setTelegramTestMessage('Сообщение отправлено в Telegram.');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка отправки в Telegram');
    } finally {
      setTelegramTesting(false);
    }
  };

  const setTelegram = (patch) => {
    setForm((f) => ({
      ...f,
      telegram: { ...(f.telegram || emptyTelegram()), ...patch },
    }));
  };

  const originHint = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}${hookPath}`;
  }, [hookPath]);

  const ozonOriginHint = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}${ozonHookPath}`;
  }, [ozonHookPath]);

  const pageCount = total <= 0 ? 1 : Math.ceil(total / pageSize);
  const pageMax = Math.max(0, pageCount - 1);
  const pageIndex = Math.min(Math.floor(offset / pageSize), pageMax);

  return (
    <div className="platform-page platform-mp-notifications">
      <h1 className="title">Уведомления</h1>
      <p className="platform-muted" style={{ marginBottom: '1rem', maxWidth: '52rem' }}>
        Telegram суперадмину и журнал входящих событий маркетплейсов (вебхуки и push).
      </p>

      {error ? (
        <div className="error" style={{ marginBottom: '12px' }}>
          {error}
        </div>
      ) : null}

      <section className="platform-mp-card" style={{ marginBottom: '1.25rem' }}>
        <h2 className="platform-mp-card__title">Telegram суперадмина</h2>
        <p className="platform-muted" style={{ marginBottom: '0.75rem', fontSize: '0.88rem' }}>
          Когда на сайте включают публичную регистрацию и появляется новый аккаунт — придёт сообщение сюда.
          Токен бота: @BotFather. Chat id: напишите боту /start или добавьте в группу (@userinfobot).
        </p>
        {(() => {
          const tg = form.telegram || emptyTelegram();
          return (
            <div className="platform-mp-fields">
              <label className="platform-mp-label" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  checked={tg.enabled === true}
                  onChange={(ev) => setTelegram({ enabled: ev.target.checked })}
                />
                <span>Отправлять уведомления в Telegram</span>
              </label>
              <label className="platform-mp-label">
                Токен бота
                <input
                  type="password"
                  autoComplete="new-password"
                  className="platform-mp-input"
                  value={tg.botToken || ''}
                  placeholder={
                    tg.hasBotToken ? `Сохранён ${tg.botTokenHint || ''}`.trim() : '123456789:AA...'
                  }
                  onChange={(ev) => setTelegram({ botToken: ev.target.value })}
                />
              </label>
              <label className="platform-mp-label">
                Chat id
                <input
                  type="text"
                  className="platform-mp-input"
                  value={tg.chatId || ''}
                  placeholder="123456789 или -1001234567890"
                  onChange={(ev) => setTelegram({ chatId: ev.target.value })}
                />
              </label>
              <label className="platform-mp-label" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <input
                  type="checkbox"
                  checked={tg.events?.public_signup !== false}
                  onChange={(ev) =>
                    setTelegram({
                      events: { ...(tg.events || {}), public_signup: ev.target.checked },
                    })
                  }
                />
                <span>
                  <strong>Регистрация аккаунта</strong>
                  <span className="platform-muted" style={{ display: 'block', fontSize: '0.85rem', marginTop: 2 }}>
                    Новая заявка через /register (название, ФИО, телефон).
                  </span>
                </span>
              </label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={testTelegram}
                  disabled={telegramTesting || loading}
                >
                  {telegramTesting ? 'Отправка…' : 'Проверить отправку'}
                </Button>
                {telegramTestMessage ? (
                  <span className="platform-muted" style={{ fontSize: '0.88rem' }}>
                    {telegramTestMessage}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })()}
      </section>

      <section className="platform-mp-card" style={{ marginBottom: '1.25rem' }}>
        <h2 className="platform-mp-card__title">URL приёма</h2>
        <p className="platform-muted" style={{ marginBottom: '0.5rem', fontSize: '0.88rem' }}>
          {hint || 'Общий URL требует X-Platform-Ingest-Key. Для push Ozon — отдельный URL без ключа.'}
        </p>
        <div style={{ marginBottom: '0.75rem' }}>
          <div className="platform-muted" style={{ fontSize: '0.82rem', marginBottom: '0.25rem' }}>
            Общий (с ключом)
          </div>
          <code className="platform-mp-code">{originHint}</code>
        </div>
        <div>
          <div className="platform-muted" style={{ fontSize: '0.82rem', marginBottom: '0.25rem' }}>
            Ozon Seller API push (TYPE_PING / события)
          </div>
          <code className="platform-mp-code">{ozonOriginHint}</code>
        </div>
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
