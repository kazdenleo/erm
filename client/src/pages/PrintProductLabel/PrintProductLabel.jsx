import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../services/api';

export function PrintProductLabel() {
  const { productId } = useParams();
  const id = useMemo(() => (productId != null ? String(productId).trim() : ''), [productId]);
  const [blobUrl, setBlobUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      document.title = ' ';
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let url = '';

    (async () => {
      try {
        setError('');
        setBlobUrl('');
        const res = await api.get(`/products/${encodeURIComponent(id)}/label`, {
          responseType: 'blob',
          timeout: 60000,
          headers: { Accept: 'image/png' },
        });
        if (cancelled) return;
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
    if (!blobUrl) return;
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [blobUrl]);

  if (!id) return <p>Не указан товар</p>;
  if (error) return <p style={{ padding: 24, color: '#b00' }}>{error}</p>;

  return (
    <div style={{ margin: 0, padding: 0, textAlign: 'center' }}>
      {blobUrl ? (
        <img src={blobUrl} alt="Этикетка товара" style={{ maxWidth: '100%', height: 'auto' }} />
      ) : (
        <p style={{ padding: 24 }}>Загрузка этикетки…</p>
      )}
    </div>
  );
}
