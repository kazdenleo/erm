/**
 * Упаковано / план: клик по упакованному — разбивка по грузоместам, план редактируется.
 */

import React, { useEffect, useState } from 'react';
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
  const [plannedInput, setPlannedInput] = useState(String(planned));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setPlannedInput(String(planned));
    setError(null);
  }, [itemId, planned]);

  const packedNum = Number(packed) || 0;
  const plannedNum = Number(planned) || 0;
  const cls = packedCellClass(packedNum, plannedNum);

  const save = async () => {
    const raw = (plannedInput || '').trim();
    const next = raw === '' ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 0) {
      setError('Укажите целое число ≥ 0');
      setPlannedInput(String(planned));
      return;
    }
    if (next === plannedNum || saving || disabled) return;

    if (next === 0) {
      const msg =
        packedNum > 0
          ? `Удалить товар из поставки? В грузоместах упаковано ${packedNum} шт. — эти позиции будут сняты.`
          : 'Удалить товар из поставки?';
      if (!window.confirm(msg)) {
        setPlannedInput(String(planned));
        return;
      }
    } else if (next < packedNum) {
      if (
        !window.confirm(
          `План (${next}) меньше упакованного (${packedNum}). Будет расхождение — уберите лишнее из грузомест или подтвердите.`
        )
      ) {
        setPlannedInput(String(planned));
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const data = await fboSuppliesApi.updateSupplyItem(supplyId, itemId, next);
      await onSaved?.(data);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Не удалось сохранить');
      setPlannedInput(String(planned));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`fbo-supply-qty-cell fbo-packed-${cls}`}>
      <button
        type="button"
        className="fbo-packed-cell fbo-supply-qty-cell__packed"
        disabled={packedNum <= 0}
        onClick={onBreakdownClick}
        title={packedNum > 0 ? 'Упаковано по грузоместам' : 'Ничего не упаковано'}
      >
        {packedNum}
      </button>
      <span className="fbo-supply-qty-cell__sep">/</span>
      <input
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
        }}
        title="Количество в поставке (0 — удалить строку)"
        aria-label="Количество в поставке"
      />
      {error ? <div className="text-danger small mt-1">{error}</div> : null}
    </div>
  );
}
