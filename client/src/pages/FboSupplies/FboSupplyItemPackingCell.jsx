/**
 * Отображение «упаковано / в поставке»; по клику — редактирование количества в поставке.
 */

import React, { useEffect, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { packedCellClass } from './fboPackedCell.js';

export function FboSupplyItemPackingCell({
  supplyId,
  itemId,
  packed = 0,
  planned = 0,
  disabled = false,
  onSaved,
  onBreakdownClick,
}) {
  const [editing, setEditing] = useState(false);
  const [plannedInput, setPlannedInput] = useState(String(planned));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const packedNum = Number(packed) || 0;
  const plannedNum = Number(planned) || 0;
  const cls = packedCellClass(packedNum, plannedNum);

  useEffect(() => {
    setPlannedInput(String(planned));
    setError(null);
    if (!editing) return;
    setEditing(false);
  }, [itemId, planned]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const cancelEdit = () => {
    setPlannedInput(String(planned));
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    const raw = (plannedInput || '').trim();
    const next = raw === '' ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 0) {
      setError('Укажите целое число ≥ 0');
      setPlannedInput(String(planned));
      return;
    }
    if (next === plannedNum || saving || disabled) {
      setEditing(false);
      return;
    }

    if (next === 0) {
      const msg =
        packedNum > 0
          ? `Удалить товар из поставки? В грузоместах упаковано ${packedNum} шт. — эти позиции будут сняты.`
          : 'Удалить товар из поставки?';
      if (!window.confirm(msg)) {
        cancelEdit();
        return;
      }
    } else if (next < packedNum) {
      if (
        !window.confirm(
          `В поставке будет ${next} шт., а упаковано ${packedNum}. Продолжить?`
        )
      ) {
        cancelEdit();
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const data = await fboSuppliesApi.updateSupplyItem(supplyId, itemId, next);
      setEditing(false);
      await onSaved?.(data);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось сохранить');
      setPlannedInput(String(planned));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className={`fbo-supply-qty-cell fbo-supply-qty-cell--edit fbo-packed-${cls}`}>
        <span className="fbo-supply-qty-cell__packed-num">{packedNum}</span>
        <span className="fbo-supply-qty-cell__sep">/</span>
        <input
          ref={inputRef}
          type="number"
          min={0}
          step={1}
          className="form-control form-control-sm fbo-supply-qty-cell__plan"
          value={plannedInput}
          disabled={disabled || saving}
          onChange={(e) => {
            setPlannedInput(e.target.value);
            setError(null);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          }}
          aria-label="Количество в поставке"
        />
        {error ? <div className="text-danger small mt-1">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className={`fbo-supply-qty-cell fbo-packed-${cls}`}>
      <span
        className={`fbo-packed-cell fbo-packed-${cls} fbo-supply-qty-cell__packed-part`}
        role={packedNum > 0 ? 'button' : undefined}
        tabIndex={packedNum > 0 ? 0 : undefined}
        onClick={() => {
          if (packedNum > 0) onBreakdownClick?.();
        }}
        onKeyDown={(e) => {
          if (packedNum > 0 && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onBreakdownClick?.();
          }
        }}
        title={packedNum > 0 ? 'Упаковано по грузоместам' : undefined}
      >
        {packedNum}
      </span>
      <span className="fbo-supply-qty-cell__sep"> / </span>
      <button
        type="button"
        className={`fbo-packed-cell fbo-packed-${cls} fbo-supply-qty-cell__plan-part`}
        disabled={disabled || saving}
        onClick={() => setEditing(true)}
        title="Изменить количество в поставке"
      >
        {plannedNum}
      </button>
    </div>
  );
}
