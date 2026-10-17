/**
 * Поиск товара по названию, артикулу или штрихкоду в рамках склада.
 * Сканер: ввод → Enter; при одном совпадении товар выбирается сразу, иначе открывается список.
 */

import React, { useEffect, useRef, useState } from 'react';
import { addressStorageApi } from '../../services/addressStorage.api';
import { isLikelyBarcodeScan, normalizeProductSearchQuery } from '../../utils/productSearch';

export function ProductPicker({ warehouseId, onPick, placeholder = 'Товар: название, артикул или штрихкод', autoFocus = false }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const itemsRef = useRef([]);
  const loadingRef = useRef(false);
  const inputRef = useRef(null);
  const blurCloseTimer = useRef(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const search = (term, { keepOpen = true } = {}) => {
    const cleaned = normalizeProductSearchQuery(term);
    if (cleaned.length < 2) {
      setItems([]);
      return Promise.resolve([]);
    }
    const id = ++reqRef.current;
    setLoading(true);
    if (keepOpen) setOpen(true);
    return addressStorageApi
      .searchProducts(warehouseId, cleaned)
      .then((list) => {
        if (id !== reqRef.current) return null;
        const next = list || [];
        setItems(next);
        if (keepOpen) setOpen(true);
        return next;
      })
      .catch(() => {
        if (id === reqRef.current) setItems([]);
        return [];
      })
      .finally(() => {
        if (id === reqRef.current) setLoading(false);
      });
  };

  useEffect(() => {
    const term = normalizeProductSearchQuery(q);
    if (term.length < 2) {
      setItems([]);
      return undefined;
    }
    // Штрихкод со сканера набирается быстро — короткий debounce; ручной ввод — чуть длиннее.
    const delay = isLikelyBarcodeScan(term) ? 80 : 300;
    const t = setTimeout(() => {
      void search(term);
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search замыкается на warehouseId
  }, [q, warehouseId]);

  const pick = (p) => {
    onPick?.(p);
    setQ('');
    setItems([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  const confirmScan = async () => {
    const term = normalizeProductSearchQuery(q);
    if (term.length < 2) return;
    // Не закрывать список по blur от Enter.
    if (blurCloseTimer.current) {
      clearTimeout(blurCloseTimer.current);
      blurCloseTimer.current = null;
    }
    setOpen(true);
    let list = itemsRef.current;
    if (loadingRef.current || !list.length || normalizeProductSearchQuery(q) !== term) {
      list = (await search(term)) || [];
    }
    if (!list?.length) return;
    if (list.length === 1) {
      pick(list[0]);
      return;
    }
    // Точное совпадение штрихкода / артикула — выбираем его, даже если нашлись ещё похожие.
    const exact = list.find(
      (p) =>
        String(p.sku || '').toLowerCase() === term.toLowerCase() ||
        String(p.id) === term
    );
    if (exact) pick(exact);
  };

  return (
    <div className="address-picker">
      <input
        ref={inputRef}
        className="form-control form-control-sm"
        value={q}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurCloseTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          e.stopPropagation();
          void confirmScan();
        }}
      />
      {open && normalizeProductSearchQuery(q).length >= 2 ? (
        <ul className="address-picker__list">
          {loading && !items.length ? <li className="muted-hint">Поиск…</li> : null}
          {!loading && !items.length ? <li className="muted-hint">Ничего не найдено</li> : null}
          {items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
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
