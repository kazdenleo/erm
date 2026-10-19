/**
 * Настройки → Приложение: QR и ссылка на последнюю версию APK.
 */

import React, { useCallback, useEffect, useState } from 'react';
import api, { resolveApiBaseUrl } from '../../services/api';
import { Button } from '../../components/common/Button/Button';
import './MobileApp.css';

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} КБ`;
  return `${(v / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function MobileApp() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [qrBust, setQrBust] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/mobile-app');
      const data = res?.data?.data ?? res?.data ?? null;
      setInfo(data);
      setQrBust(Date.now());
    } catch (e) {
      setInfo(null);
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить сведения о приложении');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const apiBase = resolveApiBaseUrl().replace(/\/+$/, '');
  const qrSrc = `${apiBase}/mobile-app/qr.png?t=${qrBust}`;
  const downloadHref = info?.downloadUrl || `${apiBase}/mobile-app/download`;
  const versionLabel = [info?.version, info?.versionCode != null ? `(${info.versionCode})` : null]
    .filter(Boolean)
    .join(' ');
  const sizeLabel = formatBytes(info?.sizeBytes);
  const updatedLabel = formatDate(info?.updatedAt);

  return (
    <div className="page settings-mobile-app">
      <h1 className="title">Приложение</h1>
      <p className="subtitle">
        Мобильное приложение «ERM Склад» для сборки и приёмки. Отсканируйте QR-код камерой телефона, чтобы
        скачать последнюю версию.
      </p>

      {loading ? <p className="settings-mobile-muted">Загрузка…</p> : null}
      {error ? <p className="settings-mobile-error">{error}</p> : null}

      {!loading && info && !info.available ? (
        <p className="settings-mobile-warn">
          APK ещё не загружен на сервер. После публикации сборки файл появится здесь автоматически.
        </p>
      ) : null}

      {!loading && info?.available ? (
        <div className="settings-mobile-card">
          <div className="settings-mobile-qr-wrap">
            <img className="settings-mobile-qr" src={qrSrc} alt="QR-код для скачивания ERM Склад" />
          </div>
          <div className="settings-mobile-meta">
            <div className="settings-mobile-name">{info.name || 'ERM Склад'}</div>
            {versionLabel ? (
              <div className="settings-mobile-row">
                <span className="settings-mobile-label">Версия</span>
                <span>{versionLabel}</span>
              </div>
            ) : null}
            {updatedLabel ? (
              <div className="settings-mobile-row">
                <span className="settings-mobile-label">Обновлено</span>
                <span>{updatedLabel}</span>
              </div>
            ) : null}
            {sizeLabel ? (
              <div className="settings-mobile-row">
                <span className="settings-mobile-label">Размер</span>
                <span>{sizeLabel}</span>
              </div>
            ) : null}
            <div className="settings-mobile-actions">
              <a className="btn btn-primary" href={downloadHref} download>
                Скачать APK
              </a>
              <Button type="button" variant="secondary" onClick={load}>
                Обновить
              </Button>
            </div>
            <p className="settings-mobile-hint">
              Если установка блокируется — удалите старую версию приложения и разрешите установку из браузера.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
