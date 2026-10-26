/**
 * Вкладка «Конкуренты» в карточке товара.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { productsApi } from '../../../services/products.api';
import { Button } from '../../common/Button/Button';

const MP_LABEL = { wb: 'Wildberries', ym: 'Яндекс.Маркет', ozon: 'Ozon' };
const OZON_COLOR = {
  GREEN: '#15803d',
  YELLOW: '#a16207',
  RED: '#b91c1c',
};
const MP_ORDER = ['ozon', 'wb', 'ym'];

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
  const [ozonCompetitors, setOzonCompetitors] = useState([]);
  const [hasOzonSku, setHasOzonSku] = useState(false);
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
      setOzonCompetitors(Array.isArray(res?.ozon_competitors) ? res.ozon_competitors : []);
      setHasOzonSku(Boolean(res?.meta?.has_ozon_sku));
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

  const onRefreshOzon = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await productsApi.refreshOzonCompetitorPrices(productId);
      setOzonCompetitors(Array.isArray(res?.items) ? res.items : []);
      setHasOzonSku(Boolean(res?.has_ozon_sku));
      const withPrice = (res?.items || []).filter((row) => row.competitor_min_price != null);
      if (!res?.has_ozon_sku) {
        setMessage('У товара нет артикула Ozon');
      } else if (!withPrice.length) {
        setMessage('Ozon не вернул минимальную цену конкурентов по этому товару');
      } else {
        setMessage('Цены конкурентов на Ozon обновлены');
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Не удалось обновить цены Ozon');
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
        До {maxPerMp} ссылок на маркетплейс. Расширение берёт цены с карточки и со страницы выдачи.
        Ozon обновляется, когда страница снова открыта в браузере.
        Wildberries и Яндекс.Маркет после добавления обновляются с сервера раз в час.
        Отдельно для Ozon — минимальная цена конкурентов из кабинета (индекс цен).
        Уведомление по ссылкам — если цена конкурента ниже вашей себестоимости
        {productCost != null && productCost !== '' ? ` (${formatMoney(productCost)})` : ''}.
      </div>

      {hasOzonSku ? (
        <div className="mb-3 p-2 border rounded">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <strong style={{ fontSize: 13 }}>Ozon — минимальная цена конкурентов</strong>
            <Button type="button" variant="secondary" disabled={busy} onClick={onRefreshOzon}>
              Обновить из кабинета
            </Button>
          </div>
          {ozonCompetitors.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Цены ещё не загружены. Нажмите «Обновить из кабинета».
            </div>
          ) : (
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>Артикул Ozon</th>
                  <th>Мин. цена на Ozon</th>
                  <th>Мин. цена на других площадках</th>
                  <th>Индекс</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {ozonCompetitors.map((row) => (
                  <tr
                    key={row.id || row.offer_id}
                    style={row.below_cost ? { background: 'rgba(239, 68, 68, 0.08)' } : undefined}
                  >
                    <td>{row.offer_id}</td>
                    <td>
                      {formatMoney(row.competitor_min_price)}
                      {row.below_cost ? (
                        <div style={{ fontSize: 11, color: '#b91c1c' }}>Ниже себестоимости</div>
                      ) : null}
                    </td>
                    <td>{formatMoney(row.external_min_price)}</td>
                    <td style={{ color: OZON_COLOR[row.color_index] || 'inherit' }}>
                      {row.color_label || '—'}
                    </td>
                    <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      {formatDt(row.last_checked_at)}
                      {row.last_error ? (
                        <div style={{ color: '#b45309' }}>{row.last_error}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

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
            placeholder="ozon.ru/product/…, wildberries.ru/catalog/… или market.yandex.ru/card/…"
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
                <th>Остаток</th>
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
                  <td>{row.stock_qty != null ? row.stock_qty : '—'}</td>
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
