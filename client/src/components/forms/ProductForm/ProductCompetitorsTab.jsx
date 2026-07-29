/**
 * Вкладка «Конкуренты» в карточке товара.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../../../services/products.api';
import { Button } from '../../common/Button/Button';

const MP_LABEL = { wb: 'Wildberries', ym: 'Яндекс.Маркет', ozon: 'Ozon (откл.)' };
const MP_ORDER = ['wb', 'ym'];

function formatMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

function formatDt(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('ru-RU');
  } catch {
    return String(v);
  }
}

export function ProductCompetitorsTab({ productId, productCost }) {
  const [items, setItems] = useState([]);
  const [maxPerMp, setMaxPerMp] = useState(5);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError('');
    try {
      const res = await productsApi.listCompetitors(productId);
      setItems(Array.isArray(res?.data) ? res.data : []);
      if (res?.meta?.max_per_marketplace) setMaxPerMp(Number(res.meta.max_per_marketplace));
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить конкурентов');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = MP_ORDER.reduce((acc, mp) => {
    acc[mp] = items.filter((i) => i.marketplace === mp).length;
    return acc;
  }, {});

  const onAdd = async (e) => {
    e?.preventDefault?.();
    if (!url.trim()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await productsApi.addCompetitor(productId, url.trim());
      setUrl('');
      setMessage('Ссылка добавлена, данные обновлены');
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось добавить');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id) => {
    if (!window.confirm('Удалить ссылку на конкурента?')) return;
    setBusy(true);
    setError('');
    try {
      await productsApi.removeCompetitor(productId, id);
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось удалить');
    } finally {
      setBusy(false);
    }
  };

  const onRefreshAll = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await productsApi.refreshCompetitors(productId);
      setMessage('Данные конкурентов обновлены');
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка обновления');
    } finally {
      setBusy(false);
    }
  };

  const onRefreshOne = async (id) => {
    setBusy(true);
    setError('');
    try {
      await productsApi.refreshCompetitor(productId, id);
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка обновления');
    } finally {
      setBusy(false);
    }
  };

  if (!productId) {
    return (
      <div className="alert alert-info mb-0">
        Сначала сохраните товар — затем можно добавлять ссылки на конкурентов.
      </div>
    );
  }

  return (
    <div className="product-competitors-tab">
      <div className="mb-3" style={{ fontSize: '13px', color: 'var(--muted)' }}>
        До {maxPerMp} ссылок на каждый маркетплейс (Wildberries и Яндекс.Маркет). Ozon — позже.
        Обновление раз в час (и вручную). Уведомление — если цена конкурента ниже вашей себестоимости
        {productCost != null && productCost !== '' ? ` (${formatMoney(productCost)})` : ''}.
      </div>

      {/* Не <form>: вкладка внутри формы товара — вложенный form сабмитит карточку и уводит на список */}
      <div className="row g-2 align-items-end mb-3">
        <div className="col-md-9">
          <label className="form-label" htmlFor="competitor-url">
            Ссылка на карточку конкурента
          </label>
          <input
            id="competitor-url"
            type="text"
            inputMode="url"
            className="form-control form-control-sm"
            placeholder="https://www.wildberries.ru/catalog/… или market.yandex.ru/card/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                onAdd(e);
              }
            }}
            disabled={busy}
          />
        </div>
        <div className="col-md-3 d-flex gap-2">
          <Button type="button" variant="primary" disabled={busy || !url.trim()} onClick={onAdd}>
            Добавить
          </Button>
          <Button type="button" variant="secondary" disabled={busy || loading} onClick={onRefreshAll}>
            Обновить все
          </Button>
        </div>
      </div>

      <div className="mb-2" style={{ fontSize: '12px', color: 'var(--muted)' }}>
        {MP_ORDER.map((mp) => (
          <span key={mp} style={{ marginRight: 12 }}>
            {MP_LABEL[mp]}: {counts[mp] || 0}/{maxPerMp}
          </span>
        ))}
      </div>

      {error ? <div className="alert alert-danger py-2">{error}</div> : null}
      {message ? <div className="alert alert-success py-2">{message}</div> : null}

      {loading ? (
        <div style={{ color: 'var(--muted)' }}>Загрузка…</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>Пока нет ссылок на конкурентов.</div>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>МП</th>
                <th>Товар</th>
                <th>Цена</th>
                <th>Рейтинг</th>
                <th>Отзывы</th>
                <th>Проверка</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={row.id}
                  style={
                    row.below_cost
                      ? { background: 'rgba(239, 68, 68, 0.08)' }
                      : undefined
                  }
                >
                  <td>{MP_LABEL[row.marketplace] || row.marketplace}</td>
                  <td style={{ maxWidth: 280 }}>
                    <div style={{ fontWeight: 500 }}>{row.title || '—'}</div>
                    <a href={row.url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                      открыть
                    </a>
                    {row.last_error ? (
                      <div style={{ fontSize: 11, color: '#b45309' }}>{row.last_error}</div>
                    ) : null}
                    {row.below_cost ? (
                      <div style={{ fontSize: 11, color: '#b91c1c' }}>
                        Ниже себестоимости ({formatMoney(row.product_cost)})
                      </div>
                    ) : null}
                  </td>
                  <td>{formatMoney(row.price)}</td>
                  <td>
                    {row.rating != null && Number.isFinite(Number(row.rating))
                      ? Number(row.rating).toFixed(1)
                      : '—'}
                  </td>
                  <td>
                    {row.reviews_count != null && Number.isFinite(Number(row.reviews_count))
                      ? row.reviews_count
                      : '—'}
                  </td>
                  <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatDt(row.last_checked_at)}</td>
                  <td className="text-nowrap">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => onRefreshOne(row.id)}
                    >
                      ↻
                    </Button>{' '}
                    <Button
                      type="button"
                      variant="danger"
                      disabled={busy}
                      onClick={() => onRemove(row.id)}
                    >
                      ×
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
