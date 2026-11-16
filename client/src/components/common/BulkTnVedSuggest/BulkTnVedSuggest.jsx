/**
 * Компактный выбор кода ТН ВЭД из классификатора — для ячеек массового редактирования.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { tnVedApi } from '../../../services/tnVed.api';
import './BulkTnVedSuggest.css';

const DEBOUNCE_MS = 220;

function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

export function BulkTnVedSuggest({
  value = '',
  onChange,
  className = '',
  title,
  disabled = false,
  placeholder = 'Код или название…',
  id,
}) {
  const autoId = useId();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const selected = digitsOnly(value);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await tnVedApi.searchCodes({ q: query, limit: 40 });
        if (!cancelled) setOptions(Array.isArray(res?.data) ? res.data : []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (code) => {
    const next = digitsOnly(code);
    onChange?.(next);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="bulk-tnved-suggest" ref={rootRef}>
      <input
        id={id || autoId}
        type="text"
        className={className}
        value={open ? query : selected}
        disabled={disabled}
        title={title}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => {
          setOpen(true);
          setQuery(selected);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setQuery('');
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const typed = digitsOnly(query);
            if (typed.length === 10) pick(typed);
            else if (options[0]?.code) pick(options[0].code);
          }
        }}
      />
      {selected && !open && !disabled ? (
        <button
          type="button"
          className="bulk-tnved-suggest__clear"
          aria-label="Очистить ТН ВЭД"
          title="Очистить"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange?.('')}
        >
          ×
        </button>
      ) : null}
      {open && !disabled ? (
        <div className="bulk-tnved-suggest__menu" role="listbox">
          {loading ? (
            <div className="bulk-tnved-suggest__muted">Поиск…</div>
          ) : options.length === 0 ? (
            <div className="bulk-tnved-suggest__muted">
              {(() => {
                const d = digitsOnly(query);
                if (d.length > 10) return 'Код ТН ВЭД — 10 цифр';
                if (d.length === 10) return 'Кода нет в классификаторе';
                return 'Ничего не найдено';
              })()}
            </div>
          ) : (
            options.map((row) => (
              <button
                key={row.code}
                type="button"
                className={`bulk-tnved-suggest__opt${
                  selected === String(row.code) ? ' is-active' : ''
                }`}
                role="option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row.code)}
              >
                <strong>{row.code}</strong>
                <span>{row.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
