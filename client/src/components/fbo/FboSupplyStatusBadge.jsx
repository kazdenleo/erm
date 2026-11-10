import React from 'react';
import {
  getFboSupplyStatusClass,
  getFboSupplyStatusLabel,
  normalizeFboSupplyStatus,
} from '../../constants/fboSupplyStatuses';

export function FboSupplyStatusBadge({
  status,
  className = '',
  lastCollectAt = null,
  lastPackAt = null,
}) {
  const activity = { lastCollectAt, lastPackAt };
  const key = getFboSupplyStatusClass(status, activity);
  const label = getFboSupplyStatusLabel(normalizeFboSupplyStatus(status), activity);
  return (
    <span className={`fbo-status-badge fbo-status-badge--${key}${className ? ` ${className}` : ''}`}>
      {label}
    </span>
  );
}

export default FboSupplyStatusBadge;
