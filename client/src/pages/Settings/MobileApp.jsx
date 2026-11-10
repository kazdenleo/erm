/**
 * Настройки → Приложение: QR/APK мобильного приложения и установщик парсера (Автолюбитель).
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

  const [parserInfo, setParserInfo] = useState(null);
  const [parserLoading, setParserLoading] = useState(true);
  const [parserError, setParserError] = useState('');
  const [parserDownloading, setParserDownloading] = useState(false);

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

  const loadParser = useCallback(async () => {
    setParserLoading(true);
    setParserError('');
    try {
      const res = await api.get('/catalog-parser');
      const data = res?.data?.data ?? res?.data ?? null;
      setParserInfo(data);
    } catch (e) {
      setParserInfo(null);
      // 401/403 — просто скрываем блок; остальные ошибки показываем
      const status = e?.response?.status;
      if (status !== 401 && status !== 403) {
        setParserError(
          e?.response?.data?.message || e?.message || 'Не удалось загрузить сведения об установщике'
        );
      }
    } finally {
      setParserLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadParser();
  }, [load, loadParser]);

  const downloadParser = useCallback(async () => {
    setParserDownloading(true);
    setParserError('');
    try {
      const res = await api.get('/catalog-parser/download', { responseType: 'blob', timeout: 300000 });
      const blob = res?.data instanceof Blob ? res.data : new Blob([res?.data]);
      const ctype = String(res?.headers?.['content-type'] || blob.type || '');
      if (ctype.includes('application/json') || blob.type === 'application/json') {
        const text = await blob.text();
        let msg = 'Не удалось скачать установщик';
        try {
          const parsed = JSON.parse(text);
          if (parsed?.message) msg = parsed.message;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      if (!blob.size || blob.size < 1024) {
        throw new Error('Файл установщика пустой или повреждён');
      }
      const fileName = parserInfo?.fileName || 'SborshikKatalogov-setup.exe';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setParserError(e?.response?.data?.message || e?.message || 'Не удалось скачать установщик');
    } finally {
      setParserDownloading(false);
    }
  }, [parserInfo?.fileName]);

  const apiBase = resolveApiBaseUrl().replace(/\/+$/, '');
  const qrSrc = `${apiBase}/mobile-app/qr.png?t=${qrBust}`;
  const downloadHref = info?.downloadUrl || `${apiBase}/mobile-app/download`;
  const versionLabel = [info?.version, info?.versionCode != null ? `(${info.versionCode})` : null]
    .filter(Boolean)
    .join(' ');
  const sizeLabel = formatBytes(info?.sizeBytes);
  const updatedLabel = formatDate(info?.updatedAt);

  const parserAllowed = Boolean(parserInfo?.allowed);
  const parserAvailable = Boolean(parserInfo?.available);
  const parserVersionLabel = parserInfo?.version ? String(parserInfo.version) : null;
  const parserSizeLabel = formatBytes(parserInfo?.sizeBytes);
  const parserUpdatedLabel = formatDate(parserInfo?.updatedAt);

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

      {parserAllowed ? (
        <section className="settings-parser-section">
          <h2 className="settings-parser-title">Сборщик каталогов (парсер)</h2>
          <p className="settings-parser-subtitle">
            Установщик десктоп-программы для сбора карточек каталога в Excel. Доступен только аккаунту
            «Автолюбитель».
          </p>

          {parserLoading ? <p className="settings-mobile-muted">Загрузка…</p> : null}
          {parserError ? <p className="settings-mobile-error">{parserError}</p> : null}

          {!parserLoading && !parserAvailable ? (
            <p className="settings-mobile-warn">
              Установщик ещё не загружен на сервер. После публикации файл появится здесь.
            </p>
          ) : null}

          {!parserLoading && parserAvailable ? (
            <div className="settings-mobile-card settings-parser-card">
              <div className="settings-mobile-meta">
                <div className="settings-mobile-name">{parserInfo?.name || 'Сборщик каталогов'}</div>
                {parserVersionLabel ? (
                  <div className="settings-mobile-row">
                    <span className="settings-mobile-label">Версия</span>
                    <span>{parserVersionLabel}</span>
                  </div>
                ) : null}
                {parserUpdatedLabel ? (
                  <div className="settings-mobile-row">
                    <span className="settings-mobile-label">Обновлено</span>
                    <span>{parserUpdatedLabel}</span>
                  </div>
                ) : null}
                {parserSizeLabel ? (
                  <div className="settings-mobile-row">
                    <span className="settings-mobile-label">Размер</span>
                    <span>{parserSizeLabel}</span>
                  </div>
                ) : null}
                <div className="settings-mobile-actions">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={downloadParser}
                    disabled={parserDownloading}
                  >
                    {parserDownloading ? 'Скачивание…' : 'Скачать установщик'}
                  </Button>
                  <Button type="button" variant="secondary" onClick={loadParser} disabled={parserDownloading}>
                    Обновить
                  </Button>
                </div>
                <p className="settings-mobile-hint">
                  Файл: {parserInfo?.fileName || 'SborshikKatalogov-setup.exe'}. После установки откройте
                  программу и укажите каталог для сбора.
                </p>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
