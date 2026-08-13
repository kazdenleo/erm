/**
 * Мультивыбор: клик по названию, без галочек.
 * После выбора меню закрывается. Пустой выбор = полный доступ.
 */

import React, { useEffect, useRef, useState } from 'react';

export function AccessMultiSelect({
  label,
  options,
  value,
  onChange,
  disabled = false,
  emptyLabel = 'Все (полный доступ)',
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n)) : [];
  const selectedSet = new Set(selected);

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

  const pick = (id) => {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    let next;
    if (selectedSet.has(n)) {
      next = selected.filter((x) => x !== n);
    } else {
      next = [...selected, n];
    }
    onChange(next);
    setOpen(false);
  };

  const removeChip = (id, e) => {
    e.stopPropagation();
    const n = Number(id);
    onChange(selected.filter((x) => x !== n));
  };

  const clearAll = (e) => {
    e.stopPropagation();
    onChange([]);
    setOpen(false);
  };

  const selectedOptions = selected
    .map((id) => options.find((o) => Number(o.id) === id))
    .filter(Boolean);

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
        <span className="access-multi-select__value">
          {selectedOptions.length === 0 ? (
            <span className="access-multi-select__placeholder">{emptyLabel}</span>
          ) : (
            <span className="access-multi-select__chips">
              {selectedOptions.map((opt) => (
                <span key={opt.id} className="access-multi-select__chip">
                  <span className="access-multi-select__chip-text">{opt.label}</span>
                  {!disabled ? (
                    <span
                      className="access-multi-select__chip-remove"
                      role="button"
                      tabIndex={-1}
                      title="Убрать"
                      onClick={(e) => removeChip(opt.id, e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') removeChip(opt.id, e);
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="access-multi-select__actions">
          {selected.length > 0 && !disabled ? (
            <span
              className="access-multi-select__clear"
              role="button"
              tabIndex={-1}
              onClick={clearAll}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') clearAll(e);
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
              const active = selectedSet.has(id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`access-multi-select__option${active ? ' is-selected' : ''}`}
                  onClick={() => pick(id)}
                >
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
