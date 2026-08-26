/**
 * Выбор кода ТН ВЭД из справочника ЕАЭС (поиск по коду или названию).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { tnVedApi } from '../../../services/tnVed.api';
import './TnVedCodePicker.css';

export function TnVedCodePicker({
  value,
  onChange,
  error,
  required = false,
  id = 'tnVedCode',
  label = 'Код ТН ВЭД',
  hint = 'Выберите код из справочника ТН ВЭД ЕАЭС (поиск по коду или названию).',
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [resolvedLabel, setResolvedLabel] = useState('');

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await tnVedApi.searchCodes({ q: query, limit: 40 });
        if (!cancelled) setOptions(res?.data || []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    if (!value) {
      setResolvedLabel('');
      return undefined;
    }
    let cancelled = false;
    tnVedApi
      .searchCodes({ q: value, limit: 10 })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data || [];
        const hit = list.find((o) => o.code === value);
        setResolvedLabel(hit ? `${hit.code} — ${hit.name}` : '');
      })
      .catch(() => {
        if (!cancelled) setResolvedLabel('');
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const selectedLabel = useMemo(() => {
    if (!value) return '';
    const hit = options.find((o) => o.code === value);
    if (hit) return `${hit.code} — ${hit.name}`;
    return resolvedLabel || value;
  }, [value, options, resolvedLabel]);

  return (
    <div className="tnved-picker">
      <label className="tnved-picker__label" htmlFor={id}>
        {label}
        {required ? <span className="tnved-picker__req"> *</span> : null}
      </label>
      {hint ? <p className="tnved-picker__hint">{hint}</p> : null}
      {value ? (
        <div className="tnved-selected">
          <span>{selectedLabel || value}</span>
          <button
            type="button"
            className="tnved-clear"
            onClick={() => onChange('')}
            aria-label="Сбросить код ТН ВЭД"
          >
            ×
          </button>
        </div>
      ) : null}
      <input
        id={id}
        type="text"
        className="form-control form-control-sm tnved-picker__search"
        placeholder="Поиск: 8708 или «амортизатор»…"
        value={query}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open ? (
        <div className="tnved-options">
          {loading ? (
            <div className="tnved-picker__muted">Поиск…</div>
          ) : options.length === 0 ? (
            <div className="tnved-picker__muted">Ничего не найдено</div>
          ) : (
            options.map((row) => (
              <button
                key={row.code}
                type="button"
                className={`tnved-option${value === row.code ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(row.code);
                  setQuery('');
                  setOpen(false);
                }}
              >
                <strong>{row.code}</strong>
                <span>{row.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {error ? <div className="tnved-picker__error">{error}</div> : null}
    </div>
  );
}
