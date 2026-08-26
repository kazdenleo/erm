import React from 'react';
import {
  countWords,
  limitItemsForControl,
  limitUnitLabel,
  measureLimitValue,
} from '../../../utils/marketplaceFieldLimits.js';

/** Счётчик относительно настроенного лимита (символы и/или слова). */
export function MarketplaceFieldLimitHint({ value, maxLength, maxWords, items, mpLabel }) {
  const rows = [];
  if (Array.isArray(items) && items.length) {
    for (const item of items) {
      if (!item || !(Number(item.max) > 0)) continue;
      rows.push({
        kind: item.kind === 'words' ? 'words' : 'chars',
        length: item.length,
        max: item.max,
        over: item.over,
        unitLabel: item.unitLabel || limitUnitLabel(item.kind),
        mpLabel: item.mpLabel || mpLabel,
      });
    }
  } else {
    if (Number(maxLength) > 0) {
      const length = String(value ?? '').length;
      rows.push({
        kind: 'chars',
        length,
        max: Number(maxLength),
        over: length > Number(maxLength),
        unitLabel: 'символов',
        mpLabel,
      });
    }
    if (Number(maxWords) > 0) {
      const length = countWords(value);
      rows.push({
        kind: 'words',
        length,
        max: Number(maxWords),
        over: length > Number(maxWords),
        unitLabel: 'слов',
        mpLabel,
      });
    }
  }
  if (!rows.length) return null;
  return (
    <div className="mp-field-limit-hint-stack">
      {rows.map((row) => {
        const who = row.mpLabel ? ` (${row.mpLabel})` : '';
        return (
          <div
            key={`${row.kind}-${row.max}-${row.mpLabel || ''}`}
            className={`mp-field-limit-hint${row.over ? ' mp-field-limit-hint--over' : ''}`}
          >
            {row.length} / {row.max} {row.unitLabel}{who}
          </div>
        );
      })}
    </div>
  );
}

export function ControlFieldLimitHint({ limitsByMp, formData, controlKey, extras }) {
  const items = limitItemsForControl(limitsByMp, formData, controlKey, extras);
  if (!items.length) return null;
  return <MarketplaceFieldLimitHint items={items} />;
}

export function limitHintFromValue(value, items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items.map((item) => ({
    ...item,
    length: measureLimitValue(value, item.kind === 'words' ? 'words' : 'chars'),
    over: Number(item.max) > 0 && measureLimitValue(value, item.kind === 'words' ? 'words' : 'chars') > item.max,
  }));
}
