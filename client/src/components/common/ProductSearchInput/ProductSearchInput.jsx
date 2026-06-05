/**
 * Поиск товара по штрихкоду, артикулу и названию (сервер + локальный список).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { barcodeStringsFromProduct } from '../../../utils/productBarcodes.js';
import {
  formatProductOptionLabel,
  normalizeProductSearchQuery,
  searchProductsCombined,
} from '../../../utils/productSearch';

export function ProductSearchInput({
  value,
  onChange,
  onSelect,
  products = [],
  organizationId = null,
  placeholder = 'Штрихкод, артикул или название',
  id,
  className = 'warehouse-ops-scan-input',
  disabled = false,
  autoFocus = false,
}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const q = normalizeProductSearchQuery(value);

  useEffect(() => {
    if (!q) {
      setResults([]);
      setLoading(false);
      setOpen(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const merged = await searchProductsCombined(q, {
          products,
          organizationId,
          limit: 40,
        });
        if (!cancelled) {
          setResults(merged);
          setOpen(merged.length > 0);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
          setOpen(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, products, organizationId]);

  const showList = open && q && results.length > 0;
  const showEmpty = !loading && q.length > 0 && results.length === 0;

  const title = useMemo(() => {
    if (loading) return 'Поиск…';
    if (results.length > 1) return 'Выберите товар';
    return '';
  }, [loading, results.length]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type="text"
        className={className}
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (results.length > 0 && q) setOpen(true);
        }}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (results.length === 1) {
            onSelect?.(results[0]);
            setOpen(false);
            return;
          }
          if (results.length > 1) {
            const ql = q.toLowerCase();
            const exact = results.find((p) => {
              const sku = String(p?.sku || '').trim().toLowerCase();
              if (sku === ql) return true;
              return barcodeStringsFromProduct(p?.barcodes).some(
                (b) => String(b || '').trim().toLowerCase() === ql
              );
            });
            if (exact) {
              onSelect?.(exact);
              setOpen(false);
            }
          }
        }}
      />
      {showList ? (
        <div
          className="warehouse-ops-suggest"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 1060,
          }}
        >
          {title ? <div className="warehouse-ops-suggest-title">{title}</div> : null}
          <div className="warehouse-ops-suggest-list" style={{ maxHeight: 280, overflow: 'auto' }}>
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                className="warehouse-ops-suggest-item"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => {
                  onSelect?.(p);
                  setOpen(false);
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.sku || '—'}</div>
                <div style={{ fontSize: 12, opacity: 0.85 }}>{formatProductOptionLabel(p)}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {showEmpty ? (
        <div
          className="warehouse-ops-suggest warehouse-ops-suggest--empty"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 1060,
          }}
        >
          <div className="warehouse-ops-suggest-title">Ничего не найдено</div>
        </div>
      ) : null}
    </div>
  );
}
