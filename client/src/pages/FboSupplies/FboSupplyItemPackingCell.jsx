/**
 * Упаковано / план; план редактируется на месте (без отдельного окна).
 * При наведении на «упаковано» — список грузомест с количеством.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fboSuppliesApi } from '../../services/fboSupplies.api';
import { packedCellClass } from './fboPackedCell.js';

function formatByCargoTitle(byCargo) {
  const rows = (byCargo || []).filter((r) => (Number(r.quantity) || 0) > 0);
  if (!rows.length) return null;
  return rows
    .map((r) => {
      const label = r.cargoBarcode || (r.cargoUnitId != null ? `№ ${r.cargoUnitId}` : 'ГМ');
      return `${label}: ${Number(r.quantity) || 0} шт.`;
    })
    .join('\n');
}

export function FboSupplyItemPackingCell({
  supplyId,
  itemId,
  packed = 0,
  planned = 0,
  byCargo = null,
  disabled = false,
  onSaved,
  onBreakdownClick,
  packedTitle = null,
  packedClickable = true,
}) {
  const [editing, setEditing] = useState(false);
  const [plannedInput, setPlannedInput] = useState(String(planned));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [tipPos, setTipPos] = useState(null);
  const inputRef = useRef(null);
  const packedRef = useRef(null);
  const savingRef = useRef(false);
  const skipBlurRef = useRef(false);

  const packedNum = Number(packed) || 0;
  const plannedNum = Number(planned) || 0;
  const cls = packedCellClass(packedNum, plannedNum);
  const cargoRows = useMemo(
    () => (byCargo || []).filter((r) => (Number(r.quantity) || 0) > 0),
    [byCargo]
  );
  const cargoTitle = useMemo(() => formatByCargoTitle(cargoRows), [cargoRows]);
  const resolvedPackedTitle =
    packedTitle ||
    cargoTitle ||
    (packedNum > 0 ? 'Упаковано в грузоместах (нажмите для деталей)' : 'Упаковано');
  const canOpenBreakdown = packedClickable && packedNum > 0 && !editing;
  const showCargoTip = cargoRows.length > 0 && !editing;

  useEffect(() => {
    setPlannedInput(String(planned));
    setEditing(false);
    setError(null);
  }, [itemId]);

  useEffect(() => {
    if (!editing) {
      setPlannedInput(String(planned));
    }
  }, [planned, editing]);

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
    if (next === plannedNum || disabled) {
      cancelEdit();
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

  const showTip = () => {
    if (!showCargoTip || !packedRef.current) return;
    const rect = packedRef.current.getBoundingClientRect();
    const preferAbove = rect.top > 120;
    setTipPos({
      left: rect.left + rect.width / 2,
      top: preferAbove ? rect.top - 8 : rect.bottom + 8,
      place: preferAbove ? 'above' : 'below',
    });
  };

  const hideTip = () => setTipPos(null);

  return (
    <div
      className={`fbo-supply-qty-cell fbo-packed-${cls}${editing ? ' fbo-supply-qty-cell--editing' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        ref={packedRef}
        className={`fbo-packed-cell fbo-packed-${cls} fbo-supply-qty-cell__packed-part${
          showCargoTip ? ' fbo-supply-qty-cell__packed-part--has-tip' : ''
        }`}
        role={canOpenBreakdown ? 'button' : undefined}
        tabIndex={canOpenBreakdown ? 0 : undefined}
        onMouseEnter={showTip}
        onMouseLeave={hideTip}
        onFocus={showTip}
        onBlur={hideTip}
        onClick={(e) => {
          e.stopPropagation();
          hideTip();
          if (!canOpenBreakdown) return;
          onBreakdownClick?.();
        }}
        onKeyDown={(e) => {
          if (!canOpenBreakdown) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            hideTip();
            onBreakdownClick?.();
          }
        }}
        title={showCargoTip ? undefined : resolvedPackedTitle}
        aria-label={
          cargoTitle
            ? `Упаковано ${packedNum}. ${cargoTitle.replace(/\n/g, '; ')}`
            : resolvedPackedTitle
        }
      >
        {packedNum}
      </span>
      {showCargoTip && tipPos
        ? createPortal(
            <span
              className={`fbo-packed-cargo-tip fbo-packed-cargo-tip--fixed fbo-packed-cargo-tip--${tipPos.place}`}
              role="tooltip"
              style={{ left: tipPos.left, top: tipPos.top }}
            >
              <span className="fbo-packed-cargo-tip__title">В грузоместах</span>
              <ul className="fbo-packed-cargo-tip__list">
                {cargoRows.map((r) => (
                  <li key={`${r.cargoUnitId}-${r.cargoBarcode || ''}`}>
                    <span className="fbo-packed-cargo-tip__bc">
                      {r.cargoBarcode || (r.cargoUnitId != null ? `№ ${r.cargoUnitId}` : 'ГМ')}
                    </span>
                    <span className="fbo-packed-cargo-tip__qty">{Number(r.quantity) || 0} шт.</span>
                  </li>
                ))}
              </ul>
            </span>,
            document.body
          )
        : null}
      <span className="fbo-supply-qty-cell__sep"> / </span>
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
            {plannedNum}
          </span>
        )}
      </span>
    </div>
  );
}
