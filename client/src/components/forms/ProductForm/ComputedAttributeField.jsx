import React from 'react';
import { isComputedAttrType } from '../../../utils/attributeFormula.js';

export function ComputedAttributeField({
  attr,
  value,
  htmlFor,
  heading,
  disabled = false,
  lockedReason = '',
  isManual = false,
  formulaError = '',
  onChange,
  onResetToFormula,
}) {
  const formula = String(attr?.formula || '').trim();
  const computed = isComputedAttrType(attr?.type);
  return (
    <div>
      {heading}
      <input
        id={htmlFor}
        type="number"
        className="form-control form-control-sm"
        step="0.01"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        readOnly={disabled}
        title={disabled ? lockedReason || undefined : formula ? `Формула: ${formula}` : undefined}
      />
      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
        {disabled && lockedReason ? (
          lockedReason
        ) : computed && formula ? (
          <>
            {isManual ? 'Задано вручную' : 'По формуле'}
            {': '}
            <code style={{ fontSize: '10px' }}>{formula}</code>
            {isManual && onResetToFormula && !disabled ? (
              <>
                {' '}
                <button
                  type="button"
                  className="btn btn-link p-0"
                  style={{ fontSize: '11px' }}
                  onClick={onResetToFormula}
                >
                  вернуть формулу
                </button>
              </>
            ) : null}
          </>
        ) : computed ? (
          'Можно ввести значение или задать формулу в настройках атрибутов'
        ) : null}
        {formulaError ? (
          <div style={{ color: '#b45309' }}>{formulaError}</div>
        ) : null}
      </div>
    </div>
  );
}
