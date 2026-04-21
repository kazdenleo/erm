/**
 * Настройки этикеток: размер для печати (используется Print Helper при конвертации PNG → PDF).
 */

import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import './Labels.css';

const STORAGE_KEY = 'erm_label_size';

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
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, size);
    } catch (_) {}
  }, [size]);

  const downloadPrintHelper = async () => {
    if (downloadLoading) return;
    setDownloadLoading(true);
    setDownloadError('');
    try {
      const resp = await api.get('/downloads/print-helper', {
        responseType: 'blob',
        timeout: 120000,
      });

      const blob = resp?.data instanceof Blob ? resp.data : new Blob([resp?.data]);
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'erm-print-helper-setup.exe';
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Не удалось скачать установщик. Проверьте, что файл загружен на сервер.';
      setDownloadError(String(msg));
    } finally {
      setDownloadLoading(false);
    }
  };

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
        <button className="btn btn-primary" type="button" onClick={downloadPrintHelper} disabled={downloadLoading}>
          {downloadLoading ? 'Скачивание…' : 'Скачать установщик Print Helper (Windows)'}
        </button>
        {downloadError && (
          <p className="error" style={{ marginTop: 10 }}>
            {downloadError}
          </p>
        )}
      </div>
    </div>
  );
}
