/**
 * Мультивыбор для доступа: выпадающий список с несколькими опциями.
 * Пустой выбор = полный доступ (placeholder).
 */

import React, { useEffect, useRef, useState } from 'react';

export function AccessMultiSelect({
  label,
  options,
  value,
  onChange,
  disabled = false,
  emptyLabel = 'Все (полный доступ)',
  placeholder = 'Выберите…',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = Array.isArray(value) ? value : [];
  const selectedSet = new Set(selected.map(Number));

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
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

  const toggle = (id) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    if (selectedSet.has(n)) {
      onChange(selected.filter((x) => Number(x) !== n));
    } else {
      onChange([...selected, n]);
    }
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange([]);
  };

  const summary =
    selected.length === 0
      ? emptyLabel
      : selected
          .map((id) => options.find((o) => Number(o.id) === Number(id)))
          .filter(Boolean)
          .map((o) => o.label)
          .join(', ') || `${selected.length} выбрано`;

  return (
    <div className={`access-multi-select${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
      <div className="access-multi-select__label">{label}</div>
      <button
        type="button"
        className={`access-multi-select__trigger${open ? ' is-open' : ''}${selected.length === 0 ? ' is-empty' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="access-multi-select__value" title={summary}>
          {summary || placeholder}
        </span>
        <span className="access-multi-select__actions">
          {selected.length > 0 && !disabled ? (
            <span
              className="access-multi-select__clear"
              role="button"
              tabIndex={-1}
              onClick={clear}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') clear(e);
              }}
              title="Сбросить (полный доступ)"
            >
              ×
            </span>
          ) : null}
          <span className="access-multi-select__caret" aria-hidden>
            ▾
          </span>
        </span>
      </button>

      {open && !disabled ? (
        <div className="access-multi-select__menu" role="listbox" aria-multiselectable="true">
          {options.length === 0 ? (
            <div className="access-multi-select__empty">Нет вариантов</div>
          ) : (
            options.map((opt) => {
              const id = Number(opt.id);
              const checked = selectedSet.has(id);
              return (
                <label key={opt.id} className="access-multi-select__option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                  />
                  <span>{opt.label}</span>
                </label>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
