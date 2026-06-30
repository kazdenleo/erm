/**
 * Поиск товара по штрихкоду, артикулу и названию — единый выпадающий список.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { barcodeStringsFromProduct } from '../../../utils/productBarcodes.js';
import {
  formatProductOptionLabel,
  isLikelyBarcodeScan,
  normalizeProductSearchQuery,
  searchProductsCombined,
} from '../../../utils/productSearch';
import './ProductSearchInput.css';

function findExactMatch(results, query) {
  const ql = String(query || '').trim().toLowerCase();
  if (!ql) return null;
  return (
    results.find((p) => {
      const sku = String(p?.sku || '').trim().toLowerCase();
      if (sku === ql) return true;
      return barcodeStringsFromProduct(p?.barcodes).some(
        (b) => String(b || '').trim().toLowerCase() === ql
      );
    }) || null
  );
}

function defaultRenderOption(product) {
  return (
    <>
      <div className="product-search-input__sku">{product.sku || '—'}</div>
      <div className="product-search-input__name">{product.name || formatProductOptionLabel(product)}</div>
    </>
  );
}

export function ProductSearchInput({
  value,
  onChange,
  onSelect,
  products = [],
  organizationId = null,
  warehouseId = null,
  placeholder = 'Штрихкод, артикул или название',
  id,
  className = 'warehouse-ops-scan-input',
  disabled = false,
  autoFocus = false,
  inputRef = null,
  minQueryLength = 1,
  autoSelectSingleScan = false,
  renderOption = null,
}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const lastAutoSelectKeyRef = useRef('');

  const q = normalizeProductSearchQuery(value);
  const showQuery = q.length >= minQueryLength;

  const pickProduct = useCallback(
    (product) => {
      if (!product?.id) return;
      onSelect?.(product);
      setOpen(false);
      setActiveIndex(-1);
    },
    [onSelect]
  );

  useEffect(() => {
    if (!showQuery) {
      setResults([]);
      setLoading(false);
      setOpen(false);
      setActiveIndex(-1);
      lastAutoSelectKeyRef.current = '';
      return undefined;
    }
    let cancelled = false;
    setOpen(true);
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const merged = await searchProductsCombined(q, {
          products,
          organizationId,
          warehouseId,
          limit: 40,
        });
        if (cancelled) return;
        setResults(merged);
        setActiveIndex(merged.length > 0 ? 0 : -1);
        if (
          autoSelectSingleScan &&
          merged.length === 1 &&
          isLikelyBarcodeScan(q) &&
          lastAutoSelectKeyRef.current !== q
        ) {
          lastAutoSelectKeyRef.current = q;
          pickProduct(merged[0]);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
          setActiveIndex(-1);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, showQuery, products, organizationId, warehouseId, autoSelectSingleScan, pickProduct]);

  const panelTitle = useMemo(() => {
    if (loading) return 'Поиск…';
    if (results.length > 1) return 'Выберите товар';
    if (results.length === 1) return 'Найден 1 товар';
    return '';
  }, [loading, results.length]);

  const showPanel = open && showQuery && (loading || results.length > 0 || !loading);
  const showEmpty = showPanel && !loading && results.length === 0;

  const renderItem = typeof renderOption === 'function' ? renderOption : defaultRenderOption;

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % results.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (results.length === 1) {
      pickProduct(results[0]);
      return;
    }
    if (results.length > 1) {
      if (activeIndex >= 0 && activeIndex < results.length) {
        pickProduct(results[activeIndex]);
        return;
      }
      const exact = findExactMatch(results, q);
      if (exact) pickProduct(exact);
    }
  };

  return (
    <div className="product-search-input">
      <input
        id={id}
        ref={inputRef}
        type="text"
        className={className}
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          lastAutoSelectKeyRef.current = '';
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (showQuery) setOpen(true);
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={handleKeyDown}
      />
      {showPanel && !showEmpty ? (
        <div className="product-search-input__panel">
          {panelTitle ? <div className="product-search-input__title">{panelTitle}</div> : null}
          <div className="product-search-input__list">
            {results.map((p, idx) => (
              <button
                key={p.id}
                type="button"
                className={`product-search-input__item${idx === activeIndex ? ' product-search-input__item--active' : ''}`}
                onMouseDown={(ev) => ev.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => pickProduct(p)}
              >
                {renderItem(p)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {showEmpty ? (
        <div className="product-search-input__panel product-search-input__panel--empty">
          <div className="product-search-input__title">Ничего не найдено</div>
        </div>
      ) : null}
    </div>
  );
}
