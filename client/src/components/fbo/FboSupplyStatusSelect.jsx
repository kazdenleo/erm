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
  const isReturn = normalized === 'return';
  const options = isReturn
    ? ['return', ...FBO_SUPPLY_STATUS_OPTIONS]
    : FBO_SUPPLY_STATUS_OPTIONS;
  return (
    <select
      className={`fbo-status-select fbo-status-select--${statusClass}${className ? ` ${className}` : ''}`}
      value={normalized || 'new'}
      disabled={disabled || isReturn}
      title={
        isReturn
          ? 'Из «Возврат» выходите через вкладку «Возврат» → «Вернуть в активные»'
          : title || 'Сменить статус'
      }
      aria-label="Статус поставки"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange?.(e.target.value);
      }}
    >
      {options.map((s) => {
        const blocked =
          s === 'return' || !canSelectFboSupplyStatus(s, hasDiscrepancy, normalized);
        const blockedTitle =
          s === 'return'
            ? 'Используйте вкладку «Возврат»'
            : fboSupplyStatusBlockedTitle(s, hasDiscrepancy, normalized);
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
