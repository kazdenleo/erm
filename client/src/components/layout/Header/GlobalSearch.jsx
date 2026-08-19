import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchApi } from '../../../services/search.api';
import { productCardPath } from '../../../utils/productCardPath.js';
import { getOrderStatusLabel } from '../../../constants/orderStatuses';
import './GlobalSearch.css';

const MP_LABEL = {
  ozon: 'Ozon',
  wb: 'WB',
  wildberries: 'WB',
  ym: 'YM',
  yandex: 'YM',
  manual: 'Ручной',
};

function mpLabel(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  return MP_LABEL[m] || marketplace || '—';
}

function purchaseStatusLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'open') return 'Открыта';
  if (s === 'archived') return 'Архив';
  if (s === 'received') return 'Принята';
  return status || '—';
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const listId = useId();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  const [active, setActive] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);
  const [activeIdx, setActiveIdx] = useState(-1);

  const flatItems = React.useMemo(() => {
    if (!results) return [];
    const items = [];
    for (const p of results.products || []) {
      items.push({ type: 'product', key: `p-${p.id}`, data: p });
    }
    for (const o of results.orders || []) {
      items.push({ type: 'order', key: `o-${o.id}`, data: o });
    }
    for (const pu of results.purchases || []) {
      items.push({ type: 'purchase', key: `pu-${pu.id}`, data: pu });
    }
    return items;
  }, [results]);

  const runSearch = useCallback(async (q) => {
    const trimmed = String(q || '').trim();
    if (!trimmed) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await searchApi.global(trimmed, { limit: 12 });
      setResults(data);
      setActiveIdx(-1);
    } catch (e) {
      setResults(null);
      setError(e.response?.data?.message || e.message || 'Ошибка поиска');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    debounceRef.current = setTimeout(() => runSearch(query), 280);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setActive(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const openProduct = (p) => {
    navigate(productCardPath(p.id));
    closeSearch();
  };

  const openOrder = (o) => {
    const mp = String(o.marketplace || 'ozon').toLowerCase();
    navigate(`/orders/${mp}/${encodeURIComponent(o.orderId)}`);
    closeSearch();
  };

  const openPurchase = (pu) => {
    navigate(`/stock-levels/purchases?purchase=${pu.id}`);
    closeSearch();
  };

  const closeSearch = () => {
    setActive(false);
    setQuery('');
    setResults(null);
    setError(null);
    setActiveIdx(-1);
  };

  const openItem = (item) => {
    if (!item) return;
    if (item.type === 'product') openProduct(item.data);
    else if (item.type === 'order') openOrder(item.data);
    else if (item.type === 'purchase') openPurchase(item.data);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeSearch();
      return;
    }
    if (!flatItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      openItem(flatItems[activeIdx]);
    } else if (e.key === 'Enter' && query.trim()) {
      e.preventDefault();
      if (flatItems.length === 1) {
        openItem(flatItems[0]);
      } else if ((results?.products?.length || 0) > 0) {
        navigate(`/products?search=${encodeURIComponent(query.trim())}`);
        closeSearch();
      } else if ((results?.orders?.length || 0) > 0) {
        navigate(`/orders?search=${encodeURIComponent(query.trim())}`);
        closeSearch();
      }
    }
  };

  const showPanel = active && (loading || error || results || query.trim());

  const total =
    (results?.products?.length || 0) +
    (results?.orders?.length || 0) +
    (results?.purchases?.length || 0);

  return (
    <div
      ref={rootRef}
      className={`search-wrapper global-search${active ? ' active' : ''}`}
    >
      <div className="input-holder">
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder="Товар, заказ, штрихкод, закупка…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setActive(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={Boolean(showPanel)}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
        />
        <button
          type="button"
          className="search-icon"
          aria-label="Поиск"
          onClick={() => {
            setActive(true);
            inputRef.current?.focus();
            if (query.trim()) runSearch(query);
          }}
        >
          <span />
        </button>
      </div>
      <button
        type="button"
        className="btn-close"
        aria-label="Закрыть поиск"
        onClick={closeSearch}
      />

      {showPanel ? (
        <div className="global-search__panel" id={listId} role="listbox">
          {loading ? <div className="global-search__hint">Поиск…</div> : null}
          {error ? <div className="global-search__error">{error}</div> : null}
          {!loading && !error && results && total === 0 && query.trim() ? (
            <div className="global-search__hint">Ничего не найдено</div>
          ) : null}

          {!loading && !error && (results?.products?.length || 0) > 0 ? (
            <section className="global-search__section">
              <div className="global-search__section-title">Товары</div>
              {results.products.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={activeIdx === i}
                    className={`global-search__item${activeIdx === i ? ' global-search__item--active' : ''}`}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => openProduct(p)}
                  >
                    <span className="global-search__item-sku">{p.sku || '—'}</span>
                    <span className="global-search__item-name">{p.name || `Товар №${p.id}`}</span>
                  </button>
                ))}
            </section>
          ) : null}

          {!loading && !error && (results?.orders?.length || 0) > 0 ? (
            <section className="global-search__section">
              <div className="global-search__section-title">Заказы</div>
              {results.orders.map((o, i) => {
                const idx = (results?.products?.length || 0) + i;
                return (
                  <button
                    key={`${o.marketplace}-${o.orderId}`}
                    type="button"
                    role="option"
                    aria-selected={activeIdx === idx}
                    className={`global-search__item${activeIdx === idx ? ' global-search__item--active' : ''}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => openOrder(o)}
                  >
                    <span className="global-search__item-sku">
                      {mpLabel(o.marketplace)} · {o.orderId}
                    </span>
                    <span className="global-search__item-name">
                      {o.productSku ? `${o.productSku} — ` : ''}
                      {o.productName || o.offerId || '—'}
                      {o.status ? ` · ${getOrderStatusLabel(o.status)}` : ''}
                    </span>
                  </button>
                );
              })}
            </section>
          ) : null}

          {!loading && !error && (results?.purchases?.length || 0) > 0 ? (
            <section className="global-search__section">
              <div className="global-search__section-title">Закупки</div>
              {results.purchases.map((pu, i) => {
                const idx =
                  (results?.products?.length || 0) + (results?.orders?.length || 0) + i;
                return (
                  <button
                    key={pu.id}
                    type="button"
                    role="option"
                    aria-selected={activeIdx === idx}
                    className={`global-search__item${activeIdx === idx ? ' global-search__item--active' : ''}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => openPurchase(pu)}
                  >
                    <span className="global-search__item-sku">
                      Закупка №{pu.id}
                      {pu.supplierName ? ` · ${pu.supplierName}` : ''}
                    </span>
                    <span className="global-search__item-name">
                      {purchaseStatusLabel(pu.status)}
                      {pu.note ? ` · ${String(pu.note).slice(0, 80)}` : ''}
                    </span>
                  </button>
                );
              })}
            </section>
          ) : null}

          {!loading && !error && total > 0 && query.trim() ? (
            <div className="global-search__footer">
              <button
                type="button"
                className="global-search__footer-link"
                onClick={() => {
                  navigate(`/products?search=${encodeURIComponent(query.trim())}`);
                  closeSearch();
                }}
              >
                Все товары по запросу
              </button>
              <button
                type="button"
                className="global-search__footer-link"
                onClick={() => {
                  navigate(`/orders?search=${encodeURIComponent(query.trim())}`);
                  closeSearch();
                }}
              >
                Все заказы по запросу
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
