import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../../services/api';

function parseCopiesParam(raw) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

function readMmHeader(headers, name, fallback) {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function PrintProductLabel() {
  const { productId } = useParams();
  const [searchParams] = useSearchParams();
  const id = useMemo(() => (productId != null ? String(productId).trim() : ''), [productId]);
  const copies = useMemo(() => parseCopiesParam(searchParams.get('copies')), [searchParams]);
  const [blobUrl, setBlobUrl] = useState('');
  const [contentType, setContentType] = useState('');
  const [widthMm, setWidthMm] = useState(58);
  const [heightMm, setHeightMm] = useState(40);
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
        setContentType('');
        const res = await api.get(`/products/${encodeURIComponent(id)}/label`, {
          params: { format: 'pdf', copies },
          responseType: 'blob',
          timeout: 60000,
          headers: { Accept: 'application/pdf' },
        });
        if (cancelled) return;
        const ct = String(res.headers?.['content-type'] || 'application/pdf').toLowerCase();
        setContentType(ct);
        setWidthMm(readMmHeader(res.headers, 'x-label-width-mm', 58));
        setHeightMm(readMmHeader(res.headers, 'x-label-height-mm', 40));
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
  }, [id, copies]);

  useEffect(() => {
    if (!blobUrl || error) return;
    const t = setTimeout(() => {
      try {
        window.focus();
        window.print();
      } catch {
        /* ignore */
      }
    }, 450);
    return () => clearTimeout(t);
  }, [blobUrl, error]);

  const pageSizeCss = `${widthMm}mm ${heightMm}mm`;
  const isPdf = contentType.includes('pdf');

  if (!id) return <p>Не указан товар</p>;
  if (error) return <p style={{ padding: 24, color: '#b00' }}>{error}</p>;

  return (
    <div className="product-label-print-root">
      <style>{`
        @page {
          size: ${pageSizeCss};
          margin: 0;
        }
        html, body {
          margin: 0;
          padding: 0;
          width: ${widthMm}mm;
          height: ${heightMm}mm;
          overflow: hidden;
          background: #fff;
        }
        .product-label-print-root {
          margin: 0;
          padding: 0;
          width: ${widthMm}mm;
          height: ${heightMm}mm;
          overflow: hidden;
          background: #fff;
        }
        .product-label-print-frame,
        .product-label-print-frame iframe {
          display: block;
          width: ${widthMm}mm;
          height: ${heightMm}mm;
          border: 0;
          margin: 0;
          padding: 0;
        }
        .product-label-print-img {
          display: block;
          width: ${widthMm}mm;
          height: ${heightMm}mm;
          object-fit: contain;
        }
        @media print {
          html, body {
            width: ${widthMm}mm !important;
            height: ${heightMm}mm !important;
          }
        }
      `}</style>
      {blobUrl ? (
        isPdf ? (
          <div className="product-label-print-frame">
            <iframe title={`Этикетка ${id}`} src={blobUrl} />
          </div>
        ) : (
          <img
            className="product-label-print-img"
            src={blobUrl}
            alt="Этикетка товара"
            onLoad={() => {
              try {
                window.print();
              } catch {
                /* ignore */
              }
            }}
          />
        )
      ) : (
        <p style={{ padding: 24 }}>Загрузка этикетки…</p>
      )}
    </div>
  );
}
