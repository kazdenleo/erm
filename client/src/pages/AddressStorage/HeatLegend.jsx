import React from 'react';
import { HEAT_METRICS, LOCATION_TYPE_LABELS } from './addressStorageUtils';

const LEGENDS = {
  type: null,
  fill: [
    ['#f8f9fa', 'пусто'],
    ['#c3e6cb', 'мало'],
    ['#2f9e44', 'полно'],
    ['#ff8787', 'переполнено'],
  ],
  shipped: [
    ['#fff4e6', 'редко'],
    ['#f08c00', ''],
    ['#e03131', 'часто'],
  ],
  idle: [
    ['#e7f5ff', 'недавно'],
    ['#748ffc', ''],
    ['#364fc7', '90+ дн.'],
  ],
};

export function HeatControls({ metric, onMetric, days, onDays }) {
  return (
    <div className="address-heat-controls">
      <span className="muted-hint">Раскраска:</span>
      {HEAT_METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          className={`erp-filter-btn${metric === m.key ? ' erp-filter-btn--active' : ''}`}
          onClick={() => onMetric(m.key)}
        >
          {m.label}
        </button>
      ))}
      {metric === 'shipped' ? (
        <select className="form-select form-select-sm address-heat-controls__days" value={days} onChange={(e) => onDays(Number(e.target.value))}>
          {[7, 30, 90, 180].map((d) => (
            <option key={d} value={d}>
              за {d} дн.
            </option>
          ))}
        </select>
      ) : null}
      <HeatLegend metric={metric} />
    </div>
  );
}

export function HeatLegend({ metric }) {
  const items =
    metric === 'type'
      ? Object.entries(LOCATION_TYPE_LABELS).map(([k, v]) => [`var(--address-type-${k})`, v])
      : LEGENDS[metric] || [];
  return (
    <span className="address-legend">
      {items.map(([color, label], i) => (
        <span key={i} className="address-legend__item">
          <span className="address-legend__swatch" style={{ background: color }} />
          {label}
        </span>
      ))}
    </span>
  );
}
