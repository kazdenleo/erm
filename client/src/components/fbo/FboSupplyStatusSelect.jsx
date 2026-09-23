import React from 'react';
import {
  FBO_SUPPLY_STATUS_OPTIONS,
  canSelectFboSupplyStatus,
  fboSupplyStatusBlockedTitle,
  getFboSupplyStatusClass,
  getFboSupplyStatusLabel,
} from '../../constants/fboSupplyStatuses';

export function FboSupplyStatusSelect({
  status,
  disabled = false,
  onChange,
  className = '',
  title,
  hasDiscrepancy = false,
}) {
  const statusClass = getFboSupplyStatusClass(status);
  return (
    <select
      className={`fbo-status-select fbo-status-select--${statusClass}${className ? ` ${className}` : ''}`}
      value={status || 'new'}
      disabled={disabled}
      title={title || 'Сменить статус'}
      aria-label="Статус поставки"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange?.(e.target.value);
      }}
    >
      {FBO_SUPPLY_STATUS_OPTIONS.map((s) => {
        const blocked = !canSelectFboSupplyStatus(s, hasDiscrepancy);
        const blockedTitle = fboSupplyStatusBlockedTitle(s, hasDiscrepancy);
        return (
          <option key={s} value={s} disabled={blocked} title={blockedTitle || undefined}>
            {getFboSupplyStatusLabel(s)}
          </option>
        );
      })}
    </select>
  );
}

export default FboSupplyStatusSelect;
