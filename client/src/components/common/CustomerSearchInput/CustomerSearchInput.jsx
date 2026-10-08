/**
 * CustomerSearchInput Component
 * Поиск клиента в базе (частные заказы) с выпадающим списком
 */

import React, { useEffect, useRef, useState } from 'react';
import { customersApi } from '../../../services/customers.api';
import '../ProductSearchInput/ProductSearchInput.css';

const MIN_QUERY_LENGTH = 2;

export function CustomerSearchInput({ id, onSelect, disabled = false, placeholder = 'Имя, телефон или email' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      return undefined;
    }
    const reqId = ++requestIdRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await customersApi.list({ search: q, limit: 8, sort: 'last_order_at', dir: 'desc' });
        if (reqId !== requestIdRef.current) return;
        setResults(res.items);
        setActiveIndex(res.items.length > 0 ? 0 : -1);
      } catch {
        if (reqId === requestIdRef.current) setResults([]);
      } finally {
        if (reqId === requestIdRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const pick = (customer) => {
    if (!customer) return;
    onSelect?.(customer);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[activeIndex] ?? results[0]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const q = query.trim();
  const showPanel = open && q.length >= MIN_QUERY_LENGTH;

  return (
    <div className="product-search-input" ref={rootRef}>
      <input
        id={id}
        type="search"
        className="form-control"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      {showPanel ? (
        results.length === 0 ? (
          <div className="product-search-input__panel product-search-input__panel--empty text-muted small">
            {loading ? 'Поиск...' : 'Клиент не найден — заполните ФИО и телефон, он будет добавлен в базу'}
          </div>
        ) : (
          <div className="product-search-input__panel">
            <div className="product-search-input__list">
              {results.map((c, idx) => (
                <button
                  key={c.id}
                  type="button"
                  className={`product-search-input__item${idx === activeIndex ? ' product-search-input__item--active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <div className="product-search-input__row">
                    <div className="product-search-input__sku">{c.name}</div>
                    <div className="product-search-input__meta">
                      {c.ordersCount > 0 ? `заказов: ${c.ordersCount}` : 'без заказов'}
                    </div>
                  </div>
                  <div className="product-search-input__name">
                    {[c.phone, c.email].filter(Boolean).join(' · ') || '—'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
