/**
 * Настройки этикеток: размер, Print Helper, принтеры по типам стикеров.
 */

import React, { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';
import { LabelConstructor } from './LabelConstructor.jsx';
import {
  LABEL_PRINT_KINDS,
  getLabelPrinterMap,
  setLabelPrinterMap,
} from '../../utils/labelPrinterSettings.js';
import {
  canReachPrintHelper,
  fetchPrintHelperPrinters,
  normalizePrintHelperBase,
} from '../../utils/printHelperClient.js';
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
  const [tab, setTab] = useState('general');
  const [size, setSize] = useState(getStoredLabelSize);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [printHelperUrl, setPrintHelperUrl] = useState('');
  const [printerMap, setPrinterMap] = useState(getLabelPrinterMap);
  const [printers, setPrinters] = useState([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState('');
  const [helperStatus, setHelperStatus] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, size);
    } catch (_) {}
  }, [size]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/config');
        const url = (res?.data?.data?.printHelperUrl ?? res?.data?.printHelperUrl ?? '').trim();
        if (!cancelled) setPrintHelperUrl(url);
      } catch {
        if (!cancelled) setPrintHelperUrl('http://127.0.0.1:9100');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshPrinters = useCallback(async () => {
    setPrintersLoading(true);
    setPrintersError('');
    setHelperStatus('');
    const base = normalizePrintHelperBase(printHelperUrl) || 'http://127.0.0.1:9100';
    try {
      if (!canReachPrintHelper(base)) {
        setPrinters([]);
        setPrintersError('Список принтеров доступен только по HTTPS (или localhost).');
        return;
      }
      const healthAc = new AbortController();
      const healthT = setTimeout(() => healthAc.abort(), 4000);
      let featuresOk = false;
      try {
        const hr = await fetch(`${base}/health`, { mode: 'cors', signal: healthAc.signal });
        if (hr.ok) {
          const h = await hr.json().catch(() => ({}));
          featuresOk = Boolean(h?.features?.printers);
          setHelperStatus(featuresOk ? 'Print Helper подключён' : 'Print Helper старой версии — обновите установщик');
        } else {
          setHelperStatus('Print Helper не отвечает');
        }
      } catch {
        setHelperStatus('Print Helper не запущен на этом ПК');
      } finally {
        clearTimeout(healthT);
      }

      const { printers: list, message: printersMsg } = await fetchPrintHelperPrinters(base);
      setPrinters(list);
      if (!list.length && featuresOk) {
        setPrintersError(
          printersMsg ||
            'Принтеры не найдены. Проверьте службу «Диспетчер печати» и что принтеры видны в параметрах Windows.'
        );
      } else if (!list.length) {
        setPrintersError(
          printersMsg ||
            'Не удалось получить список принтеров. Установите/обновите Print Helper и нажмите «Обновить список».'
        );
      }
    } finally {
      setPrintersLoading(false);
    }
  }, [printHelperUrl]);

  useEffect(() => {
    if (tab !== 'general') return undefined;
    refreshPrinters();
    return undefined;
  }, [tab, refreshPrinters]);

  const onPrinterChange = (kind, value) => {
    const next = setLabelPrinterMap({ ...printerMap, [kind]: value });
    setPrinterMap(next);
  };

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
      // Ошибки API при responseType:blob приходят JSON-ом в теле — иначе скачивается «битый» exe.
      const ctype = String(resp?.headers?.['content-type'] || '');
      if (ctype.includes('application/json') || blob.type === 'application/json') {
        const text = await blob.text();
        let message = 'Не удалось скачать установщик';
        try {
          const j = JSON.parse(text);
          if (j?.message) message = String(j.message);
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      if (!blob.size || blob.size < 1024) {
        throw new Error('Файл установщика пустой или повреждён. Обратитесь к администратору.');
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'erm-print-helper-setup.exe';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      let msg =
        e?.message ||
        'Не удалось скачать установщик. Проверьте, что файл загружен на сервер.';
      const errData = e?.response?.data;
      if (errData instanceof Blob) {
        try {
          const j = JSON.parse(await errData.text());
          if (j?.message) msg = String(j.message);
        } catch {
          /* ignore */
        }
      } else if (errData?.message) {
        msg = String(errData.message);
      }
      setDownloadError(String(msg));
    } finally {
      setDownloadLoading(false);
    }
  };

  return (
    <div className="settings-page card settings-labels">
      <h1 className="title">Этикетки</h1>
      <nav className="settings-labels-tabs" aria-label="Разделы настроек этикеток">
        <button
          type="button"
          className={tab === 'general' ? 'active' : ''}
          onClick={() => setTab('general')}
        >
          Печать
        </button>
        <button
          type="button"
          className={tab === 'constructor' ? 'active' : ''}
          onClick={() => setTab('constructor')}
        >
          Конструктор по категориям
        </button>
      </nav>

      {tab === 'constructor' ? (
        <LabelConstructor />
      ) : (
        <>
          <p className="subtitle">Размер этикетки по умолчанию для тихой печати (Print Helper).</p>
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

          <h2 className="subtitle" style={{ marginTop: 0 }}>Принтеры по типам стикеров</h2>
          <p className="subtitle" style={{ marginTop: 0 }}>
            Настройки хранятся на этом компьютере. Пустое значение — принтер Windows по умолчанию.
            Нужен запущенный Print Helper.
          </p>
          {helperStatus ? <p className="settings-labels-helper-status">{helperStatus}</p> : null}
          <div className="settings-labels-printers-toolbar">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={refreshPrinters}
              disabled={printersLoading}
            >
              {printersLoading ? 'Загрузка…' : 'Обновить список принтеров'}
            </button>
            {printers.length ? (
              <span className="text-muted small">Найдено: {printers.length}</span>
            ) : null}
          </div>
          {printersError ? <p className="error">{printersError}</p> : null}

          <div className="settings-labels-printers">
            {LABEL_PRINT_KINDS.map((kind) => {
              // Показываем фактический принтер с учётом миграции со старого «box» / «cargo».
              const effective =
                printerMap[kind.id] ||
                (kind.id.startsWith('box_') ? printerMap.box : '') ||
                (kind.id === 'box_ym' ? printerMap.cargo : '') ||
                '';
              return (
                <div key={kind.id} className="form-group settings-labels-select settings-labels-printer-row">
                  <label htmlFor={`label-printer-${kind.id}`}>{kind.label}</label>
                  <p className="settings-labels-kind-hint">{kind.hint}</p>
                  <select
                    id={`label-printer-${kind.id}`}
                    value={effective}
                    onChange={(e) => onPrinterChange(kind.id, e.target.value)}
                    className="settings-labels-select-el"
                  >
                    <option value="">Принтер по умолчанию</option>
                    {effective && !printers.includes(effective) ? (
                      <option value={effective}>{effective} (сохранён)</option>
                    ) : null}
                    {printers.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          <hr style={{ margin: '18px 0' }} />

          <h2 className="subtitle" style={{ marginTop: 0 }}>Print Helper (тихая печать)</h2>
          <p className="subtitle" style={{ marginTop: 0 }}>
            Установите локальную программу на ПК сборки, чтобы печать шла без диалога браузера и на нужный принтер.
          </p>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Перед обновлением закройте Print Helper в трее (правый клик → Выход), иначе установщик не сможет
            заменить файл.
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
        </>
      )}
    </div>
  );
}
