import React from 'react';
import { isComputedAttrType } from '../../../utils/attributeFormula.js';

const TOOL_HINT = 'Изменено другим инструментом';
const TOOL_HINT_TITLE =
  'Значение обновили стратегия ценообразования или пересчёт минимальных цен';

export function ComputedAttributeField({
  attr,
  value,
  htmlFor,
  heading,
  disabled = false,
  lockedReason = '',
  isManual = false,
  changedByTool = false,
  formulaError = '',
  onChange,
  onResetToFormula,
}) {
  const formula = String(attr?.formula || '').trim();
  const computed = isComputedAttrType(attr?.type);
  return (
    <div>
      {heading}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <input
          id={htmlFor}
          type="number"
          className="form-control form-control-sm"
          step="0.01"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          readOnly={disabled}
          title={
            disabled
              ? lockedReason || undefined
              : changedByTool
                ? TOOL_HINT_TITLE
                : formula
                  ? `Формула: ${formula}`
                  : undefined
          }
          style={{ flex: '1 1 120px', minWidth: 0 }}
        />
        {changedByTool && !disabled ? (
          <span
            style={{ fontSize: '11px', color: '#d97706', whiteSpace: 'nowrap' }}
            title={TOOL_HINT_TITLE}
          >
            {TOOL_HINT}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
        {disabled && lockedReason ? (
          lockedReason
        ) : computed && formula ? (
          <>
            {changedByTool ? 'Формула' : isManual ? 'Задано вручную' : 'По формуле'}
            {': '}
            <code style={{ fontSize: '10px' }}>{formula}</code>
            {(isManual || changedByTool) && onResetToFormula && !disabled ? (
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
        ) : computed && !changedByTool ? (
          'Можно ввести значение или задать формулу в настройках атрибутов'
        ) : null}
        {formulaError ? (
          <div style={{ color: '#b45309' }}>{formulaError}</div>
        ) : null}
      </div>
    </div>
  );
}
