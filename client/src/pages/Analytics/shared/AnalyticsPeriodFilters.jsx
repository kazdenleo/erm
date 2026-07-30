import React from 'react';
import {
  ANALYTICS_PERIOD_PRESETS,
  rangeLastDays,
} from './analyticsPeriod';

/**
 * Выпадающий список пресетов + поля «С» / «По».
 * При выборе 7/14/28 — подставляет даты; при ручном изменении дат — переключается на «Период».
 */
export function AnalyticsPeriodFilters({
  periodPreset,
  onPeriodPresetChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
}) {
  const handlePreset = (value) => {
    onPeriodPresetChange(value);
    if (value === 'custom') return;
    const days = Number(value);
    if (!Number.isFinite(days) || days < 1) return;
    const range = rangeLastDays(days);
    onDateFromChange(range.dateFrom);
    onDateToChange(range.dateTo);
  };

  const handleFrom = (value) => {
    onPeriodPresetChange('custom');
    onDateFromChange(value);
  };

  const handleTo = (value) => {
    onPeriodPresetChange('custom');
    onDateToChange(value);
  };

  return (
    <>
      <label className="sales-analytics__filter">
        <span>Период</span>
        <select value={periodPreset} onChange={(e) => handlePreset(e.target.value)}>
          {ANALYTICS_PERIOD_PRESETS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="sales-analytics__filter">
        <span>С</span>
        <input type="date" value={dateFrom} onChange={(e) => handleFrom(e.target.value)} />
      </label>
      <label className="sales-analytics__filter">
        <span>По</span>
        <input type="date" value={dateTo} onChange={(e) => handleTo(e.target.value)} />
      </label>
    </>
  );
}
