import React from 'react';

/** Счётчик символов относительно настроенного лимита маркетплейса. */
export function MarketplaceFieldLimitHint({ value, maxLength, mpLabel }) {
  const limit = Number(maxLength);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const length = String(value ?? '').length;
  const over = length > limit;
  const who = mpLabel ? ` (${mpLabel})` : '';
  return (
    <div className={`mp-field-limit-hint${over ? ' mp-field-limit-hint--over' : ''}`}>
      {length} / {limit} символов{who}
    </div>
  );
}
