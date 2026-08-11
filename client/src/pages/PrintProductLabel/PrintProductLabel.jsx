/**
 * Печать этикетки одного товара (несколько копий = несколько листов).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import api from '../../services/api';

const MM_TO_PX = 8;

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

async function messageFromLabelError(err) {
  const status = err?.response?.status || 0;
  const data = err?.response?.data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      const text = await data.text();
      try {
        const j = text ? JSON.parse(text) : null;
        if (j?.message) return String(j.message);
      } catch {
        if (text?.trim()) return text.trim();
      }
    } catch {
      /* ignore */
    }
  }
  if (data?.message) return String(data.message);
  if (status === 400) return 'У товара нет категории или шаблона этикетки.';
  if (status === 404) return 'Товар не найден.';
  return err?.message || 'Не удалось загрузить этикетку';
}

export function PrintProductLabel() {
  const { productId } = useParams();
  const [searchParams] = useSearchParams();
  const id = useMemo(() => (productId != null ? String(productId).trim() : ''), [productId]);
  const copies = useMemo(() => parseCopiesParam(searchParams.get('copies')), [searchParams]);
  const marketplace = useMemo(
    () => (searchParams.get('marketplace') != null ? String(searchParams.get('marketplace')).trim() : ''),
    [searchParams]
  );
  const [blobUrl, setBlobUrl] = useState('');
  const [widthMm, setWidthMm] = useState(58);
  const [heightMm, setHeightMm] = useState(40);
  const [error, setError] = useState('');
  const loadedKeysRef = useRef(new Set());
  const printCalledRef = useRef(false);

  const widthPx = Math.round(widthMm * MM_TO_PX);
  const heightPx = Math.round(heightMm * MM_TO_PX);
  const pageSizeCss = `${widthMm}mm ${heightMm}mm`;

  useEffect(() => {
    try {
      document.title = ' ';
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadedKeysRef.current = new Set();
    printCalledRef.current = false;
  }, [id, copies, marketplace]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let url = '';

    (async () => {
      try {
        setError('');
        setBlobUrl('');
        const res = await api.get(`/products/${encodeURIComponent(id)}/label`, {
          params: {
            format: 'png',
            ...(marketplace ? { marketplace } : {}),
          },
          responseType: 'blob',
          timeout: 60000,
          headers: { Accept: 'image/png' },
        });
        if (cancelled) return;
        if (res.data?.type && String(res.data.type).includes('json')) {
          const text = await res.data.text();
          let msg = 'Не удалось загрузить этикетку';
          try {
            msg = JSON.parse(text)?.message || msg;
          } catch {
            if (text?.trim()) msg = text.trim();
          }
          setError(String(msg));
          return;
        }
        setWidthMm(readMmHeader(res.headers, 'x-label-width-mm', 58));
        setHeightMm(readMmHeader(res.headers, 'x-label-height-mm', 40));
        url = URL.createObjectURL(res.data);
        setBlobUrl(url);
      } catch (e) {
        if (cancelled) return;
        setError(await messageFromLabelError(e));
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
  }, [id, copies, marketplace]);

  const markSheetReady = useCallback(
    (key) => {
      if (printCalledRef.current) return;
      loadedKeysRef.current.add(key);
      if (loadedKeysRef.current.size < copies) return;
      printCalledRef.current = true;
      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            window.focus();
            window.print();
          } catch {
            /* ignore */
          }
        }, 200);
      });
    },
    [copies]
  );

  if (!id) return <p>Не указан товар</p>;
  if (error) return <p style={{ padding: 24, color: '#b00' }}>{error}</p>;

  return (
    <>
      <style>{`
        @page {
          size: ${pageSizeCss};
          margin: 0;
        }
        html, body, #root {
          margin: 0 !important;
          padding: 0 !important;
        }
        .product-label-print-loading {
          padding: 24px;
          color: #eee;
          font-family: system-ui, sans-serif;
        }
        @media screen {
          html, body {
            background: #444;
            min-height: 100%;
          }
          .product-label-print-sheet {
            margin: 12px auto;
            box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
          }
        }
        @media print {
          html, body, #root {
            width: ${widthMm}mm !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .product-label-print-loading {
            display: none !important;
          }
          .product-label-print-sheet {
            width: ${widthMm}mm !important;
            height: ${heightMm}mm !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
            box-sizing: border-box;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          .product-label-print-sheet:not(:last-child) {
            page-break-after: always !important;
            break-after: page !important;
          }
          .product-label-print-sheet img {
            display: block !important;
            width: ${widthMm}mm !important;
            height: ${heightMm}mm !important;
            max-width: ${widthMm}mm !important;
            max-height: ${heightMm}mm !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            object-fit: fill;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
        }
        .product-label-print-sheet {
          width: ${widthPx}px;
          height: ${heightPx}px;
          overflow: hidden;
          background: #fff;
          line-height: 0;
        }
        .product-label-print-sheet img {
          display: block;
          width: ${widthPx}px;
          height: ${heightPx}px;
        }
      `}</style>
      {blobUrl ? (
        Array.from({ length: copies }, (_, i) => {
          const key = `c-${i}`;
          return (
            <div key={key} className="product-label-print-sheet">
              <img
                src={blobUrl}
                alt={`Этикетка ${i + 1}`}
                width={widthPx}
                height={heightPx}
                onLoad={() => markSheetReady(key)}
                onError={() => {
                  setError('Не удалось отобразить этикетку');
                  markSheetReady(key);
                }}
              />
            </div>
          );
        })
      ) : (
        <p className="product-label-print-loading">Загрузка этикетки…</p>
      )}
    </>
  );
}
