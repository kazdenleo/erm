/**
 * История изменения цен — по товару и в целом по кабинету.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { pricingStrategiesApi } from '../../services/pricingStrategies.api.js';
import { productsApi } from '../../services/products.api.js';
import { searchProductsRemote } from '../../utils/productSearch.js';
import { PriceChangeHistoryTable } from './PriceChangeHistoryTable.jsx';
import './PriceHistory.css';
import './Prices.css';

const DAYS_OPTIONS = [7, 14, 30];
const PAGE_SIZE = 150;

function unwrapProduct(res) {
  if (!res) return null;
  if (res.id) return res;
  if (res.data?.id) return res.data;
  if (res.data?.data?.id) return res.data.data;
  return null;
}

export function PriceHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const productIdParam = searchParams.get('productId') || '';

  const [days, setDays] = useState(30);
  const [marketplace, setMarketplace] = useState('');
  const [query, setQuery] = useState('');
  const [suggest, setSuggest] = useState([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [selected, setSelected] = useState(null);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const suggestBoxRef = useRef(null);

  const productId = selected?.id || (productIdParam ? Number(productIdParam) : null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pricingStrategiesApi.priceChanges({
        days,
        limit: PAGE_SIZE,
        marketplace: marketplace || undefined,
        productId: productId && Number.isFinite(Number(productId)) ? productId : undefined,
      });
      const data = res?.data || {};
      setItems(data.items || []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [days, marketplace, productId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = Number(productIdParam);
    if (!Number.isFinite(id) || id < 1) {
      if (!productIdParam) setSelected(null);
      return undefined;
    }
    if (selected?.id && Number(selected.id) === id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await productsApi.getById(id);
        const product = unwrapProduct(res);
        if (!cancelled && product?.id) {
          setSelected(product);
          setQuery(product.sku || product.name || '');
        }
      } catch {
        if (!cancelled) {
          setSelected({ id, sku: `#${id}`, name: '' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productIdParam, selected?.id]);

  useEffect(() => {
    const q = query.trim();
    if (!q || (selected && (q === selected.sku || q === selected.name))) {
      setSuggest([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const list = await searchProductsRemote(q, { limit: 12 });
      if (!cancelled) {
        setSuggest(list);
        setSuggestOpen(true);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, selected]);

  useEffect(() => {
    const onDoc = (e) => {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(e.target)) {
        setSuggestOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selectProduct = (product) => {
    if (!product?.id) return;
    setSelected(product);
    setQuery(product.sku || product.name || '');
    setSuggest([]);
    setSuggestOpen(false);
    setSearchParams({ productId: String(product.id) });
  };

  const clearProduct = () => {
    setSelected(null);
    setQuery('');
    setSuggest([]);
    setSearchParams({});
  };

  const hideProductColumn = Boolean(productId && Number.isFinite(Number(productId)));

  return (
    <div className="card price-history-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="title">История изменения цен</h1>
          <p className="subtitle">
            Как менялись минимум и фактическая цена и почему.{' '}
            <Link to="/prices" style={{ color: 'var(--primary)' }}>
              ← к ценам
            </Link>
          </p>
        </div>
      </div>

      <div className="price-history-toolbar">
        <label className="price-history-field price-history-search" ref={suggestBoxRef}>
          Товар (артикул или название)
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => suggest.length && setSuggestOpen(true)}
            placeholder="Найти товар…"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (suggest.length === 1) selectProduct(suggest[0]);
            }}
          />
          {suggestOpen && suggest.length ? (
            <ul className="price-history-suggest">
              {suggest.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => selectProduct(p)}>
                    <div className="sku">{p.sku || `#${p.id}`}</div>
                    <div className="name">{p.name || '—'}</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </label>
        <label className="price-history-field">
          Маркетплейс
          <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
            <option value="">Все</option>
            <option value="ozon">Ozon</option>
            <option value="wb">Wildberries</option>
            <option value="ym">Яндекс.Маркет</option>
          </select>
        </label>
        <label className="price-history-field">
          Период
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} дн.
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="secondary" onClick={load} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </Button>
      </div>

      {selected?.id ? (
        <div className="price-history-selected">
          <span>
            Товар: <strong>{selected.sku || `#${selected.id}`}</strong>
            {selected.name ? ` — ${selected.name}` : ''}
          </span>
          <button type="button" onClick={clearProduct} title="Сбросить фильтр по товару">
            ×
          </button>
        </div>
      ) : null}

      <div className="price-history-meta">
        Записей: {total}
        {items.length && items.length < total ? ` (показано ${items.length})` : ''}
        {' · '}
        храним последние 30 дней
      </div>

      <PriceChangeHistoryTable
        items={items}
        loading={loading}
        error={error}
        hideProductColumn={hideProductColumn}
        onProductClick={(row) =>
          selectProduct({
            id: row.productId,
            sku: row.productSku,
            name: row.productName,
          })
        }
        emptyText={
          hideProductColumn
            ? 'По этому товару пока нет записей за выбранный период. Они появятся после пересчёта минимума, стратегии или ручного изменения фактической цены.'
            : 'Пока нет изменений за период. Выберите товар или дождитесь пересчёта цен.'
        }
      />
    </div>
  );
}
