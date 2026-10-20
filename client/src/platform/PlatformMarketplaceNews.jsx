/**
 * Лента новостей маркетплейсов (автосбор) — супер-админ.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { platformMarketplaceNewsApi } from '../services/platformMarketplaceNews.api.js';
import { Button } from '../components/common/Button/Button';
import './platform.css';

const SOURCE_LABELS = {
  ozon: 'Ozon',
  wildberries: 'Wildberries',
  yandex: 'Яндекс Маркет',
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
  const [error, setError] = useState('');
  const [syncInfo, setSyncInfo] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [source, setSource] = useState('all');
  const pageSize = 30;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await platformMarketplaceNewsApi.list({
        limit: pageSize,
        offset,
        source: source === 'all' ? undefined : source,
      });
      if (res?.ok && res?.data) {
        setItems(Array.isArray(res.data.items) ? res.data.items : []);
        setTotal(typeof res.data.total === 'number' ? res.data.total : 0);
      } else {
        setItems([]);
        setTotal(0);
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка загрузки');
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [offset, source]);

  useEffect(() => {
    load();
  }, [load]);

  const onSourceChange = (next) => {
    setSource(next);
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

  const pageCount = total <= 0 ? 1 : Math.ceil(total / pageSize);
  const pageMax = Math.max(0, pageCount - 1);
  const pageIndex = Math.min(Math.floor(offset / pageSize), pageMax);

  return (
    <div className="platform-page platform-mp-news">
      <div className="platform-mp-news__head">
        <div>
          <h1 className="title">Новости маркетплейсов</h1>
          <p className="platform-muted" style={{ marginBottom: 0, maxWidth: '40rem' }}>
            Автосбор изменений API и крупных обновлений Ozon, Wildberries и Яндекс Маркета.
          </p>
        </div>
        <Button type="button" variant="primary" onClick={runSync} disabled={syncing || loading}>
          {syncing ? 'Обновление…' : 'Обновить сейчас'}
        </Button>
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
          { id: 'all', label: 'Все' },
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

      {loading ? (
        <p className="platform-muted" style={{ marginTop: '1rem' }}>
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <div className="platform-placeholder" style={{ marginTop: '1rem' }}>
          Новостей пока нет. Нажмите «Обновить сейчас», чтобы собрать ленту с официальных источников.
        </div>
      ) : (
        <ul className="platform-mp-news__list">
          {items.map((item) => (
            <li key={item.id} className="platform-mp-news__card">
              <div className="platform-mp-news__meta">
                <span className={`platform-mp-news__badge platform-mp-news__badge--${item.source}`}>
                  {SOURCE_LABELS[item.source] || item.source}
                </span>
                <time dateTime={item.publishedAt || undefined}>{formatDate(item.publishedAt)}</time>
              </div>
              <h2 className="platform-mp-news__title">{item.title}</h2>
              {item.summary ? <p className="platform-mp-news__summary">{item.summary}</p> : null}
              {item.url ? (
                <a
                  className="platform-mp-news__link"
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть оригинал
                </a>
              ) : null}
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
    </div>
  );
}
