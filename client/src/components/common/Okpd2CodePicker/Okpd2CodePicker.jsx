/**
 * Выбор кода ОКПД2 из классификатора (поиск по коду или названию).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { okpd2Api } from '../../../services/okpd2.api';
import '../TnVedCodePicker/TnVedCodePicker.css';

export function Okpd2CodePicker({
  value,
  onChange,
  error,
  id = 'okpd2Code',
  label = 'Код ОКПД2',
  hint = 'Выберите код из классификатора ОКПД2 (поиск по коду или названию).',
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setOptions([]);
      setLoadError('');
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await okpd2Api.searchCodes({ q, limit: 40 });
        if (!cancelled) {
          setOptions(res?.data || []);
          setLoadError('');
        }
      } catch (e) {
        if (!cancelled) {
          setOptions([]);
          setLoadError(e?.response?.data?.message || e?.response?.data?.error || '');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return undefined;
    }
    let cancelled = false;
    okpd2Api
      .getCode(value)
      .then((res) => {
        if (!cancelled) setSelected(res?.data ? { ...res.data, found: true } : { code: value, found: false });
      })
      .catch(() => {
        if (!cancelled) setSelected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const selectedInfo = useMemo(() => {
    if (!value) return null;
    if (selected && selected.code === value) return selected;
    const hit = options.find((o) => o.code === value);
    return hit ? { ...hit, found: true } : null;
  }, [value, selected, options]);

  return (
    <div className="tnved-picker">
      <label className="tnved-picker__label" htmlFor={id}>
        {label}
      </label>
      {hint ? <p className="tnved-picker__hint">{hint}</p> : null}
      {value ? (
        <div className="tnved-selected">
          <div className="tnved-selected__body">
            <span>
              <strong>{value}</strong>
              {selectedInfo?.name ? ` — ${selectedInfo.name}` : ''}
            </span>
            {selectedInfo && selectedInfo.found === false ? (
              <span className="tnved-selected__warn">Кода нет в классификаторе ОКПД2 — выберите код из справочника</span>
            ) : null}
          </div>
          <button type="button" className="tnved-clear" onClick={() => onChange('')} aria-label="Сбросить код ОКПД2">
            ×
          </button>
        </div>
      ) : null}
      <input
        id={id}
        type="text"
        className="form-control form-control-sm tnved-picker__search"
        placeholder="Поиск: 26.20 или «ноутбук»…"
        value={query}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
      />
      {open && query.trim() ? (
        <div className="tnved-options">
          {loading ? (
            <div className="tnved-picker__muted">Поиск…</div>
          ) : options.length === 0 ? (
            <div className="tnved-picker__muted">{loadError || 'Ничего не найдено'}</div>
          ) : (
            options.map((row) => (
              <button
                key={row.code}
                type="button"
                className={`tnved-option${value === row.code ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
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
