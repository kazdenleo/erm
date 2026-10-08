/**
 * Общие мелочи для страниц аналитики: форматирование, карточки сводки, фильтры МП/схемы.
 */

import React from 'react';
import { rangeLastDays } from './analyticsPeriod';
import './analyticsKit.css';

export const LONG_PERIOD_PRESETS = [
  { value: '30', label: '30 дней', days: 30 },
  { value: '90', label: '90 дней', days: 90 },
  { value: '180', label: '180 дней', days: 180 },
  { value: 'custom', label: 'Период' },
];

/** Пресеты 30/90/180 дней + поля «С» / «По» (для возвратов, штрафов). */
export function LongPeriodFilters({ periodPreset, setPeriodPreset, dateFrom, dateTo, setDateFrom, setDateTo }) {
  const onPreset = (value) => {
    setPeriodPreset(value);
    const found = LONG_PERIOD_PRESETS.find((p) => p.value === value && p.days);
    if (!found) return;
    const r = rangeLastDays(found.days);
    setDateFrom(r.dateFrom);
    setDateTo(r.dateTo);
  };
  return (
    <>
      <SelectFilter label="Период" value={periodPreset} onChange={onPreset} options={LONG_PERIOD_PRESETS} />
      <label className="sales-analytics__filter">
        <span>С</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => {
            setPeriodPreset('custom');
            setDateFrom(e.target.value);
          }}
        />
      </label>
      <label className="sales-analytics__filter">
        <span>По</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => {
            setPeriodPreset('custom');
            setDateTo(e.target.value);
          }}
        />
      </label>
    </>
  );
}

export const MP_LABELS = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс Маркет' };

export const MARKETPLACE_OPTIONS = [
  { value: 'all', label: 'Все маркетплейсы' },
  { value: 'ozon', label: 'Ozon' },
  { value: 'wb', label: 'Wildberries' },
  { value: 'ym', label: 'Яндекс Маркет' },
];

export const SCHEME_OPTIONS = [
  { value: 'all', label: 'FBO + FBS' },
  { value: 'fbo', label: 'Только FBO' },
  { value: 'fbs', label: 'Только FBS' },
];

export function marketplaceLabel(mp) {
  return MP_LABELS[mp] || mp || '—';
}

export function formatQty(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(n));
}

export function formatRub(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number(n));
}

export function formatPercent(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(Number(n))}%`;
}

export function formatDateRu(ymd) {
  if (!ymd) return '—';
  const s = String(ymd).slice(0, 10);
  const [y, m, d] = s.split('-');
  return y && m && d ? `${d}.${m}.${y}` : s;
}

export function errorMessage(e, fallback) {
  return e?.response?.data?.message || e?.response?.data?.error || e?.message || fallback;
}

export function SummaryCards({ cards }) {
  return (
    <div className="product-dynamics__summary-cards">
      {cards.filter(Boolean).map((c) => (
        <div
          key={c.label}
          className={`product-dynamics__summary-card${c.tone ? ` analytics-kit__card--${c.tone}` : ''}`}
          title={c.title}
        >
          <div className="product-dynamics__summary-card-label">{c.label}</div>
          <div className="product-dynamics__summary-card-value">{c.value}</div>
          {c.sub ? <div className="analytics-kit__card-sub">{c.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function SelectFilter({ label, value, onChange, options }) {
  return (
    <label className="sales-analytics__filter">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NumberFilter({ label, value, onChange, min = 0, step = 1, width = 90, title }) {
  return (
    <label className="sales-analytics__filter" title={title}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        style={{ width }}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ToggleGroup({ label, value, onChange, options, disabled }) {
  return (
    <div className="product-dynamics__toggle-group" role="group" aria-label={label}>
      {label ? <span className="product-dynamics__toggle-label">{label}</span> : null}
      {options.map((f) => (
        <button
          key={f.value}
          type="button"
          className={`product-dynamics__toggle${value === f.value ? ' is-active' : ''}`}
          onClick={() => onChange(f.value)}
          disabled={disabled}
        >
          {f.label}
          {f.count != null ? <span className="analytics-kit__toggle-count">{f.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }) {
  return (
    <span className={`analytics-kit__badge analytics-kit__badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ProductCell({ name, sku }) {
  return (
    <>
      <strong>{sku || '—'}</strong>
      {name ? <div className="analytics-kit__product-name">{name}</div> : null}
    </>
  );
}
