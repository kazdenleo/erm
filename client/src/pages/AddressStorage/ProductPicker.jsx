/**
 * Поиск товара по названию, артикулу или штрихкоду в рамках склада.
 */

import React, { useEffect, useRef, useState } from 'react';
import { addressStorageApi } from '../../services/addressStorage.api';

export function ProductPicker({ warehouseId, onPick, placeholder = 'Товар: название, артикул или штрихкод', autoFocus = false }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setItems([]);
      return undefined;
    }
    const id = ++reqRef.current;
    setLoading(true);
    const t = setTimeout(() => {
      addressStorageApi
        .searchProducts(warehouseId, term)
        .then((list) => {
          if (id === reqRef.current) setItems(list || []);
        })
        .catch(() => {})
        .finally(() => {
          if (id === reqRef.current) setLoading(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [q, warehouseId]);

  return (
    <div className="address-picker">
      <input
        className="form-control form-control-sm"
        value={q}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && q.trim().length >= 2 ? (
        <ul className="address-picker__list">
          {loading && !items.length ? <li className="muted-hint">Поиск…</li> : null}
          {!loading && !items.length ? <li className="muted-hint">Ничего не найдено</li> : null}
          {items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick?.(p);
                  setQ('');
                  setOpen(false);
                }}
              >
                <code>{p.sku}</code> {p.name}
                <span className="muted-hint">
                  {' '}
                  · {p.warehouseQty} шт{p.assignedLocationCode ? ` · 📌 ${p.assignedLocationCode}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
