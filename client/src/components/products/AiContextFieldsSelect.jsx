import React, { useEffect, useMemo, useRef, useState } from 'react';

function toggleKey(list, key) {
  if (list.includes(key)) return list.filter((k) => k !== key);
  return [...list, key];
}

export function AiContextFieldsSelect({
  options = [],
  value = [],
  onChange,
  disabled = false,
  placeholder = 'Выберите атрибуты',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const selected = Array.isArray(value) ? value.map(String) : [];
  const selectedSet = new Set(selected);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => String(o.label || o.key || '').toLowerCase().includes(q));
  }, [options, query]);

  const selectedOptions = selected
    .map((key) => options.find((o) => o.key === key))
    .filter(Boolean);

  const pick = (key) => {
    onChange((prev) => toggleKey(Array.isArray(prev) ? prev : selected, key));
  };

  const removeChip = (key, e) => {
    e.stopPropagation();
    onChange((prev) => (Array.isArray(prev) ? prev : selected).filter((k) => k !== key));
  };

  const clearAll = (e) => {
    e.stopPropagation();
    onChange([]);
  };

  return (
    <div className={`ai-context-select${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`ai-context-select__trigger${open ? ' is-open' : ''}${
          selected.length === 0 ? ' is-empty' : ''
        }`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ai-context-select__value">
          {selectedOptions.length === 0 ? (
            <span className="ai-context-select__placeholder">{placeholder}</span>
          ) : (
            <span className="ai-context-select__chips">
              {selectedOptions.map((opt) => (
                <span key={opt.key} className="ai-context-select__chip">
                  <span className="ai-context-select__chip-text">{opt.label}</span>
                  {!disabled ? (
                    <span
                      className="ai-context-select__chip-remove"
                      role="button"
                      tabIndex={-1}
                      title="Убрать"
                      onClick={(e) => removeChip(opt.key, e)}
                    >
                      ×
                    </span>
                  ) : null}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="ai-context-select__actions">
          {selected.length > 0 && !disabled ? (
            <span
              className="ai-context-select__clear"
              role="button"
              tabIndex={-1}
              title="Сбросить"
              onClick={clearAll}
            >
              ×
            </span>
          ) : null}
          <span className="ai-context-select__caret" aria-hidden>
            ▾
          </span>
        </span>
      </button>
      {open && !disabled ? (
        <div className="ai-context-select__menu" role="listbox" aria-multiselectable="true">
          <input
            ref={searchRef}
            type="search"
            className="ai-context-select__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск атрибута…"
            onClick={(e) => e.stopPropagation()}
          />
          {filtered.length === 0 ? (
            <div className="ai-context-select__empty">Ничего не найдено</div>
          ) : (
            filtered.map((opt) => {
              const active = selectedSet.has(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`ai-context-select__option${active ? ' is-selected' : ''}`}
                  onClick={() => pick(opt.key)}
                >
                  <span className="ai-context-select__check">{active ? '✓' : ''}</span>
                  {opt.label}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export default AiContextFieldsSelect;
