import React from 'react';
import {
  getFboSupplyStatusClass,
  getFboSupplyStatusLabel,
} from '../../constants/fboSupplyStatuses';

export function FboSupplyStatusBadge({ status, className = '' }) {
  const key = getFboSupplyStatusClass(status);
  const label = getFboSupplyStatusLabel(status);
  return (
    <span className={`fbo-status-badge fbo-status-badge--${key}${className ? ` ${className}` : ''}`}>
      {label}
    </span>
  );
}

export default FboSupplyStatusBadge;
