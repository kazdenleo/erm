/**
 * Лента новостей маркетплейсов (автосбор) — супер-админ.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { platformMarketplaceNewsApi } from '../services/platformMarketplaceNews.api.js';
import { Button } from '../components/common/Button/Button';
import { Modal } from '../components/common/Modal/Modal';
import { NewsCopyTextButton } from '../components/marketplaceNews/NewsCopyTextButton.jsx';
import './platform.css';

const SOURCE_LABELS = {
  ozon: 'Ozon',
  wildberries: 'Wildberries',
  yandex: 'Яндекс Маркет',
};

const TAG_LABELS = {
  api: 'API',
  ops: 'Важные новости МП',
};

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU');
  } catch {
    return String(iso);
  }
}

export function PlatformMarketplaceNews() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState('');
  const [syncInfo, setSyncInfo] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [source, setSource] = useState('all');
  const [tag, setTag] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [openItem, setOpenItem] = useState(null);
  const pageSize = 30;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await platformMarketplaceNewsApi.list({
        limit: pageSize,
        offset,
        source: source === 'all' ? undefined : source,
        tag: tag === 'all' ? undefined : tag,
        unreadOnly,
      });
      if (res?.ok && res?.data) {
        setItems(Array.isArray(res.data.items) ? res.data.items : []);
        setTotal(typeof res.data.total === 'number' ? res.data.total : 0);
        setUnreadCount(typeof res.data.unreadCount === 'number' ? res.data.unreadCount : 0);
      } else {
        setItems([]);
        setTotal(0);
        setUnreadCount(0);
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
      setItems([]);
      setTotal(0);
      setUnreadCount(0);
    } finally {
      setLoading(false);
    }
  }, [offset, source, tag, unreadOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const onSourceChange = (next) => {
    setSource(next);
    setOffset(0);
  };

  const onTagChange = (next) => {
    setTag(next);
    setOffset(0);
  };

  const runSync = async () => {
    setSyncing(true);
    setError('');
    setSyncInfo('');
    try {
      const res = await platformMarketplaceNewsApi.sync();
      const d = res?.data;
      const errParts = Array.isArray(d?.errors)
        ? d.errors.map((e) => `${e.source}: ${e.message}`).join('; ')
        : '';
      setSyncInfo(
        `Добавлено: ${d?.inserted ?? 0}, обновлено: ${d?.updated ?? 0}` +
          (errParts ? `. Ошибки: ${errParts}` : '')
      );
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось обновить');
    } finally {
      setSyncing(false);
    }
  };

  const openNews = async (item) => {
    setOpenItem(item);
    if (item?.isRead || !item?.id) return;
    try {
      const res = await platformMarketplaceNewsApi.markRead(item.id);
      const updated = res?.data;
      if (updated) {
        setOpenItem(updated);
        setItems((prev) => prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)));
        setUnreadCount((c) => Math.max(0, c - 1));
      }
    } catch {
      // просмотр всё равно доступен
    }
  };

  const closeNews = () => setOpenItem(null);

  const markAllRead = async () => {
    setMarkingAll(true);
    setError('');
    try {
      await platformMarketplaceNewsApi.markAllRead({
        source: source === 'all' ? undefined : source,
        tag: tag === 'all' ? undefined : tag,
      });
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось отметить прочитанными');
    } finally {
      setMarkingAll(false);
    }
  };

  const pageCount = total <= 0 ? 1 : Math.ceil(total / pageSize);
  const pageMax = Math.max(0, pageCount - 1);
  const pageIndex = Math.min(Math.floor(offset / pageSize), pageMax);

  return (
    <div className="platform-page platform-mp-news">
      <div className="platform-mp-news__head">
        <div>
          <h1 className="title">Новости маркетплейсов</h1>
          <p className="platform-muted" style={{ marginBottom: 0, maxWidth: '40rem' }}>
            Автосбор: изменения API и операционные новости (тарифы, условия, логистика, поставки) Ozon,
            Wildberries и Яндекс Маркета.
            {unreadCount > 0 ? ` Непрочитанных: ${unreadCount}.` : ''}
          </p>
        </div>
        <div className="platform-mp-news__actions">
          {unreadCount > 0 ? (
            <Button type="button" variant="secondary" onClick={markAllRead} disabled={markingAll || loading}>
              {markingAll ? 'Отмечаем…' : 'Прочитать все'}
            </Button>
          ) : null}
          <Button type="button" variant="primary" onClick={runSync} disabled={syncing || loading}>
            {syncing ? 'Обновление…' : 'Обновить сейчас'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="error" style={{ marginTop: '12px', marginBottom: '12px' }}>
          {error}
        </div>
      ) : null}
      {syncInfo ? (
        <p className="platform-muted" style={{ marginTop: '0.75rem' }}>
          {syncInfo}
        </p>
      ) : null}

      <div className="platform-mp-news__filters" role="group" aria-label="Фильтр по маркетплейсу">
        {[
          { id: 'all', label: 'Все МП' },
          { id: 'ozon', label: 'Ozon' },
          { id: 'wildberries', label: 'Wildberries' },
          { id: 'yandex', label: 'Яндекс' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            className={`platform-mp-news__chip${source === f.id ? ' platform-mp-news__chip--active' : ''}`}
            onClick={() => onSourceChange(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="platform-mp-news__filters" role="group" aria-label="Фильтр по теме" style={{ marginTop: '0.5rem' }}>
        {[
          { id: 'all', label: 'Все темы' },
          { id: 'api', label: 'API' },
          { id: 'ops', label: 'Важные новости МП' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            className={`platform-mp-news__chip${tag === f.id ? ' platform-mp-news__chip--active' : ''}`}
            onClick={() => onTagChange(f.id)}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          className={`platform-mp-news__chip${unreadOnly ? ' platform-mp-news__chip--active' : ''}`}
          onClick={() => {
            setUnreadOnly((v) => !v);
            setOffset(0);
          }}
        >
          Только непрочитанные
          {unreadCount > 0 ? ` (${unreadCount})` : ''}
        </button>
      </div>

      {loading ? (
        <p className="platform-muted" style={{ marginTop: '1rem' }}>
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <div className="platform-placeholder" style={{ marginTop: '1rem' }}>
          {unreadOnly
            ? 'Непрочитанных новостей нет.'
            : 'Новостей пока нет. Нажмите «Обновить сейчас», чтобы собрать ленту с официальных источников.'}
        </div>
      ) : (
        <ul className="platform-mp-news__list">
          {items.map((item) => (
            <li
              key={item.id}
              className={`platform-mp-news__card${item.isRead ? '' : ' platform-mp-news__card--unread'}`}
            >
              <div className="platform-mp-news__card-top">
                <div className="platform-mp-news__meta">
                  {!item.isRead ? <span className="platform-mp-news__dot" aria-label="Непрочитано" /> : null}
                  <span className={`platform-mp-news__badge platform-mp-news__badge--${item.source}`}>
                    {SOURCE_LABELS[item.source] || item.source}
                  </span>
                  {(Array.isArray(item.tags) ? item.tags : []).map((tag) =>
                    TAG_LABELS[tag] ? (
                      <span key={tag} className={`platform-mp-news__tag platform-mp-news__tag--${tag}`}>
                        {TAG_LABELS[tag]}
                      </span>
                    ) : null
                  )}
                  <time dateTime={item.publishedAt || undefined}>{formatDate(item.publishedAt)}</time>
                  {item.isRead ? <span className="platform-mp-news__read-label">прочитано</span> : null}
                </div>
                <NewsCopyTextButton
                  className="platform-mp-news-copy--card"
                  title={item.title}
                  body={item.body || item.summary || ''}
                />
              </div>
              <button
                type="button"
                className="platform-mp-news__card-open"
                onClick={() => openNews(item)}
              >
                <h2 className="platform-mp-news__title">{item.title}</h2>
                {item.summary ? <p className="platform-mp-news__summary">{item.summary}</p> : null}
                <span className="platform-mp-news__open-hint">Открыть полностью</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {total > pageSize ? (
        <div className="platform-mp-pager">
          <span className="platform-muted">
            {total} · стр. {pageIndex + 1} из {pageCount}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button
              type="button"
              variant="secondary"
              disabled={pageIndex <= 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              Назад
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pageIndex >= pageMax || loading}
              onClick={() => setOffset(offset + pageSize)}
            >
              Вперёд
            </Button>
          </div>
        </div>
      ) : null}

      <Modal
        isOpen={!!openItem}
        onClose={closeNews}
        title={openItem?.title || 'Новость'}
        size="large"
        scrollable
      >
        {openItem ? (
          <div className="platform-mp-news-detail">
            <div className="platform-mp-news-detail__toolbar">
              <p className="platform-muted platform-mp-news-detail__meta">
                {SOURCE_LABELS[openItem.source] || openItem.source}
                {(Array.isArray(openItem.tags) ? openItem.tags : [])
                  .map((tag) => TAG_LABELS[tag])
                  .filter(Boolean)
                  .map((label) => ` · ${label}`)
                  .join('')}
                {openItem.publishedAt ? ` · ${formatDate(openItem.publishedAt)}` : ''}
              </p>
              <NewsCopyTextButton
                title={openItem.title}
                body={openItem.body || openItem.summary || ''}
              />
            </div>
            <div className="platform-mp-news-detail__body">
              {openItem.body || openItem.summary || 'Текст недоступен'}
            </div>
            {openItem.url ? (
              <p className="platform-mp-news-detail__footer">
                <a href={openItem.url} target="_blank" rel="noopener noreferrer">
                  Источник (если нужен оригинал)
                </a>
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
