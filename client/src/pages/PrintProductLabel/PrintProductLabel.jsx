import React, { useEffect, useMemo, useRef, useState } from 'react';
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

export function PrintProductLabel() {
  const { productId } = useParams();
  const [searchParams] = useSearchParams();
  const id = useMemo(() => (productId != null ? String(productId).trim() : ''), [productId]);
  const copies = useMemo(() => parseCopiesParam(searchParams.get('copies')), [searchParams]);
  const [blobUrl, setBlobUrl] = useState('');
  const [widthMm, setWidthMm] = useState(58);
  const [heightMm, setHeightMm] = useState(40);
  const [error, setError] = useState('');
  const imagesLoadedRef = useRef(0);
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
    imagesLoadedRef.current = 0;
    printCalledRef.current = false;
  }, [id, copies]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let url = '';

    (async () => {
      try {
        setError('');
        setBlobUrl('');
        const res = await api.get(`/products/${encodeURIComponent(id)}/label`, {
          params: { format: 'png' },
          responseType: 'blob',
          timeout: 60000,
          headers: { Accept: 'image/png' },
        });
        if (cancelled) return;
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
  }, [id]);

  const schedulePrintWhenReady = () => {
    imagesLoadedRef.current += 1;
    if (printCalledRef.current) return;
    if (imagesLoadedRef.current < copies) return;
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
  };

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
        Array.from({ length: copies }, (_, i) => (
          <div key={i} className="product-label-print-sheet">
            <img
              src={blobUrl}
              alt={`Этикетка ${i + 1}`}
              width={widthPx}
              height={heightPx}
              onLoad={schedulePrintWhenReady}
              onError={() => setError('Не удалось отобразить этикетку')}
              ref={(el) => {
                if (el?.complete) schedulePrintWhenReady();
              }}
            />
          </div>
        ))
      ) : (
        <p className="product-label-print-loading">Загрузка этикетки…</p>
      )}
    </>
  );
}
