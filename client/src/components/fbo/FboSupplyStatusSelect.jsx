import React from 'react';
import {
  FBO_SUPPLY_STATUS_OPTIONS,
  getFboSupplyStatusClass,
  getFboSupplyStatusLabel,
} from '../../constants/fboSupplyStatuses';

export function FboSupplyStatusSelect({
  status,
  disabled = false,
  onChange,
  className = '',
  title,
}) {
  const statusClass = getFboSupplyStatusClass(status);
  return (
    <select
      className={`fbo-status-select fbo-status-select--${statusClass}${className ? ` ${className}` : ''}`}
      value={status || 'new'}
      disabled={disabled}
      title={title || 'Сменить статус'}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange?.(e.target.value);
      }}
    >
      {FBO_SUPPLY_STATUS_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {getFboSupplyStatusLabel(s)}
        </option>
      ))}
    </select>
  );
}
