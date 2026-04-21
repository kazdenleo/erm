/**
 * Настройки этикеток: размер для печати (используется Print Helper при конвертации PNG → PDF).
 */

import React, { useState, useEffect } from 'react';
import './Labels.css';

const STORAGE_KEY = 'erm_label_size';
const API_BASE = process.env.REACT_APP_API_URL || '/api';

export const LABEL_SIZES = [
  { value: '58x40', label: '58 × 40 мм' },
  { value: '75x120', label: '75 × 120 мм' },
];

export function getStoredLabelSize() {
  try {
    let v = localStorage.getItem(STORAGE_KEY);
    if (v === '120x75') v = '75x120';
    if (LABEL_SIZES.some((s) => s.value === v)) return v;
  } catch (_) {}
  return LABEL_SIZES[0].value;
}

export function Labels() {
  const [size, setSize] = useState(getStoredLabelSize);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, size);
    } catch (_) {}
  }, [size]);

  return (
    <div className="settings-page card settings-labels">
      <h1 className="title">Этикетки</h1>
      <p className="subtitle">Размер этикетки для тихой печати (Print Helper).</p>
      <div className="form-group settings-labels-select">
        <label htmlFor="label-size">Размер этикетки</label>
        <select
          id="label-size"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className="settings-labels-select-el"
        >
          {LABEL_SIZES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <h2 className="subtitle" style={{ marginTop: 0 }}>Print Helper (тихая печать)</h2>
      <p className="subtitle" style={{ marginTop: 0 }}>
        Установите локальную программу на ПК сборки, чтобы печать шла без диалога браузера.
      </p>
      <div className="form-group">
        <a className="btn btn-primary" href={`${API_BASE.replace(/\/$/, '')}/downloads/print-helper`}>
          Скачать установщик Print Helper (Windows)
        </a>
      </div>
    </div>
  );
}
