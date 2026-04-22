import React, { useEffect, useMemo, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import api from '../../services/api';

export function PrintLabel() {
  const { orderId } = useParams();
  const id = useMemo(() => (orderId != null ? String(orderId).trim() : ''), [orderId]);
  const [blobUrl, setBlobUrl] = useState('');
  const [contentType, setContentType] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let url = '';

    (async () => {
      try {
        setError('');
        setBlobUrl('');
        setContentType('');
        const res = await api.get(`/orders/${encodeURIComponent(id)}/label`, {
          responseType: 'blob',
          timeout: 120000,
          headers: { Accept: '*/*' },
        });
        if (cancelled) return;
        const ct = String(res.headers?.['content-type'] || '').toLowerCase();
        setContentType(ct);
        url = URL.createObjectURL(res.data);
        setBlobUrl(url);
      } catch (e) {
        if (cancelled) return;
        const msg = e?.response?.data?.message || e?.message || 'Не удалось загрузить этикетку';
        setError(String(msg));
      }
    })();

    return () => {
      cancelled = true;
      try {
        if (url) URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    };
  }, [id]);

  useEffect(() => {
    if (!blobUrl || error) return;
    // Чуть ждём, чтобы браузер успел отрисовать iframe/img перед печатью.
    const t = setTimeout(() => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      try {
        window.print();
      } catch {
        /* ignore */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [blobUrl, error]);

  if (!id) return <Navigate to="/assembly" replace />;

  const isPdf = contentType.includes('pdf');
  const isPng = contentType.includes('png');

  return (
    <div style={{ margin: 0, padding: 0, width: '100vw', height: '100vh', background: '#fff' }}>
      {error ? (
        <div style={{ padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Не удалось открыть этикетку для печати</div>
          <div style={{ color: '#b42318' }}>{error}</div>
        </div>
      ) : !blobUrl ? (
        <div style={{ padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
          Загрузка этикетки…
        </div>
      ) : isPdf ? (
        <iframe
          title={`Этикетка ${id}`}
          src={blobUrl}
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <img
            alt={`Этикетка ${id}`}
            src={blobUrl}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
            onLoad={() => {
              // Дополнительная попытка печати после загрузки изображения.
              try {
                window.print();
              } catch {
                /* ignore */
              }
            }}
          />
          {!isPng && !isPdf && (
            <div style={{ position: 'fixed', left: 16, bottom: 16, fontFamily: 'system-ui', fontSize: 12, color: '#667085' }}>
              Формат: {contentType || 'unknown'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

