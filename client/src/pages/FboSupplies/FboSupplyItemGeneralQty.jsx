/**
 * Количество на вкладке «Общее»: план / зарезервировано + нал / путь.
 */

import React, { useEffect, useRef, useState } from 'react';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { packedCellClass } from './fboPackedCell.js';
import { getFboItemReserveParts } from './fboSupplyItemReserve.js';
import { FboSupplyReserveBreakdown } from './FboSupplyReserveBreakdown.jsx';

export function FboSupplyItemGeneralQty({
  item,
  supplyId,
  disabled = false,
  reserveDisabled = false,
  onSaved,
}) {
  const itemId = item?.id;
  const planned = Number(item?.quantity) || 0;
  const { stock, incoming, total: reservedRaw } = getFboItemReserveParts(item);
  const total = reserveDisabled ? 0 : reservedRaw;
  const cls = packedCellClass(total, planned);

  const [editing, setEditing] = useState(false);
  const [plannedInput, setPlannedInput] = useState(String(planned));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const savingRef = useRef(false);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    setPlannedInput(String(planned));
    setEditing(false);
    setError(null);
  }, [itemId, planned]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const cancelEdit = () => {
    skipBlurRef.current = true;
    setPlannedInput(String(planned));
    setError(null);
    setEditing(false);
  };

  const startPlanEdit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || saving || editing) return;
    setError(null);
    setPlannedInput(String(planned));
    setEditing(true);
  };

  const save = async () => {
    if (savingRef.current) return;

    const raw = (plannedInput || '').trim();
    const next = raw === '' ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 0) {
      setError('Укажите целое число ≥ 0');
      return;
    }
    if (next === planned || disabled) {
      cancelEdit();
      return;
    }

    if (next === 0) {
      const msg = 'Удалить товар из поставки?';
      if (!window.confirm(msg)) {
        cancelEdit();
        return;
      }
    }

    savingRef.current = true;
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
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleBlur = () => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    if (savingRef.current) return;
    void save();
  };

  return (
    <div className="fbo-supply-qty-with-reserve">
      <div
        className={`fbo-supply-qty-main fbo-supply-qty-cell fbo-packed-${cls}${
          editing ? ' fbo-supply-qty-cell--editing' : ''
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="fbo-supply-qty-cell__plan-slot">
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              className={`fbo-supply-qty-cell__plan-input${error ? ' is-invalid' : ''}`}
              value={plannedInput}
              disabled={disabled || saving}
              title={error || 'Количество в поставке'}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, '');
                setPlannedInput(v);
                setError(null);
              }}
              onBlur={handleBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  skipBlurRef.current = true;
                  cancelEdit();
                }
              }}
              aria-label="Количество в поставке"
            />
          ) : (
            <span
              className={`fbo-packed-cell fbo-packed-${cls} fbo-supply-qty-cell__plan-part`}
              role="button"
              tabIndex={disabled || saving ? -1 : 0}
              onClick={startPlanEdit}
              onKeyDown={(e) => {
                if (disabled || saving) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  startPlanEdit(e);
                }
              }}
              title="Количество в поставке (нажмите, чтобы изменить)"
            >
              {planned}
            </span>
          )}
        </span>
        <span className="fbo-supply-qty-cell__sep"> / </span>
        <span
          className={`fbo-supply-qty-main__reserved fbo-packed-cell fbo-packed-${cls}`}
          title="Зарезервировано под поставку"
        >
          {total}
        </span>
      </div>
      <FboSupplyReserveBreakdown
        showEmpty
        reserveDisabled={reserveDisabled}
        reservedFromStock={stock}
        reservedFromIncoming={incoming}
        sourceOnHand={item?.sourceOnHand ?? item?.source_on_hand}
        sourceIncoming={item?.sourceIncoming ?? item?.source_incoming}
      />
    </div>
  );
}
