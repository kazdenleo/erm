import React from 'react';
import {
  FBO_SUPPLY_STATUS_OPTIONS,
  canSelectFboSupplyStatus,
  fboSupplyStatusBlockedTitle,
  getFboSupplyStatusClass,
  getFboSupplyStatusFilterLabel,
  getFboSupplyStatusLabel,
  normalizeFboSupplyStatus,
} from '../../constants/fboSupplyStatuses';

export function FboSupplyStatusSelect({
  status,
  disabled = false,
  onChange,
  className = '',
  title,
  hasDiscrepancy = false,
  lastCollectAt = null,
  lastPackAt = null,
}) {
  const normalized = normalizeFboSupplyStatus(status);
  const activity = { lastCollectAt, lastPackAt };
  const statusClass = getFboSupplyStatusClass(normalized, activity);
  return (
    <select
      className={`fbo-status-select fbo-status-select--${statusClass}${className ? ` ${className}` : ''}`}
      value={normalized || 'new'}
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
        const label =
          s === normalized
            ? getFboSupplyStatusLabel(s, activity)
            : getFboSupplyStatusFilterLabel(s);
        return (
          <option key={s} value={s} disabled={blocked} title={blockedTitle || undefined}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

export default FboSupplyStatusSelect;
