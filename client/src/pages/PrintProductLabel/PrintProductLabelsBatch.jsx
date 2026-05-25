/**
 * Печать этикеток нескольких товаров в одной вкладке (один диалог печати).
 * Данные передаются через localStorage (см. openProductLabelsBatchPrintTab).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import { readProductLabelsBatchPayload } from '../../hooks/useProductLabelPrint.js';

const MM_TO_PX = 8;

function readMmHeader(headers, name, fallback) {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeCopies(v) {
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

export function PrintProductLabelsBatch() {
  const payload = useMemo(() => readProductLabelsBatchPayload(), []);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const imagesLoadedRef = useRef(0);
  const printCalledRef = useRef(false);
  const expectedImagesRef = useRef(0);

  const sheets = useMemo(() => {
    const list = [];
    for (const e of entries) {
      if (!e.blobUrl) continue;
      const copies = normalizeCopies(e.copies);
      for (let i = 0; i < copies; i += 1) {
        list.push({
          key: `${e.productId}-${i}`,
          blobUrl: e.blobUrl,
          widthMm: e.widthMm,
          heightMm: e.heightMm,
          widthPx: Math.round(e.widthMm * MM_TO_PX),
          heightPx: Math.round(e.heightMm * MM_TO_PX),
        });
      }
    }
    return list;
  }, [entries]);

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
    expectedImagesRef.current = 0;
  }, [entries]);

  useEffect(() => {
    const items = payload?.items || [];
    if (!items.length) {
      setLoading(false);
      setError('Нет товаров для печати. Вернитесь в поставку FBO и выберите позиции.');
      return;
    }

    let cancelled = false;
    const urlsToRevoke = [];

    (async () => {
      setLoading(true);
      setError('');
      const loaded = [];
      const errors = [];

      for (const raw of items) {
        const productId = raw?.productId != null ? String(raw.productId).trim() : '';
        if (!productId) continue;
        const copies = normalizeCopies(raw.copies);
        try {
          const res = await api.get(`/products/${encodeURIComponent(productId)}/label`, {
            params: { format: 'png' },
            responseType: 'blob',
            timeout: 60000,
            headers: { Accept: 'image/png' },
          });
          if (cancelled) return;
          const blobUrl = URL.createObjectURL(res.data);
          urlsToRevoke.push(blobUrl);
          loaded.push({
            productId,
            copies,
            title: raw.title || '',
            blobUrl,
            widthMm: readMmHeader(res.headers, 'x-label-width-mm', 58),
            heightMm: readMmHeader(res.headers, 'x-label-height-mm', 40),
          });
        } catch (e) {
          const msg = e?.response?.data?.message || e?.message || 'ошибка загрузки';
          errors.push(`${raw.title || productId}: ${msg}`);
        }
      }

      if (cancelled) return;

      if (!loaded.length) {
        setEntries([]);
        setError(
          errors.length
            ? `Не удалось загрузить этикетки:\n${errors.join('\n')}`
            : 'Не удалось загрузить этикетки.'
        );
      } else if (errors.length) {
        setEntries(loaded);
        setError(`Часть позиций пропущена:\n${errors.join('\n')}`);
      } else {
        setEntries(loaded);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      urlsToRevoke.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* ignore */
        }
      });
    };
  }, [payload]);

  useEffect(() => {
    expectedImagesRef.current = sheets.length;
  }, [sheets.length]);

  const schedulePrintWhenReady = () => {
    imagesLoadedRef.current += 1;
    if (printCalledRef.current) return;
    if (expectedImagesRef.current === 0) return;
    if (imagesLoadedRef.current < expectedImagesRef.current) return;
    printCalledRef.current = true;
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          window.focus();
          window.print();
        } catch {
          /* ignore */
        }
      }, 250);
    });
  };

  if (loading) {
    return <p style={{ padding: 24 }}>Загрузка этикеток…</p>;
  }

  if (!sheets.length && error) {
    return <p style={{ padding: 24, color: '#b00', whiteSpace: 'pre-wrap' }}>{error}</p>;
  }

  return (
    <>
      <style>{`
        html, body, #root {
          margin: 0 !important;
          padding: 0 !important;
        }
        .product-labels-batch-warn {
          padding: 12px 16px;
          color: #92400e;
          background: #fffbeb;
          font-family: system-ui, sans-serif;
          font-size: 13px;
          white-space: pre-wrap;
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
          .product-labels-batch-warn {
            display: none !important;
          }
          html, body, #root {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .product-label-print-sheet {
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
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            object-fit: fill;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
        }
        .product-label-print-sheet {
          overflow: hidden;
          background: #fff;
          line-height: 0;
        }
        .product-label-print-sheet img {
          display: block;
        }
      `}</style>
      {error ? <div className="product-labels-batch-warn">{error}</div> : null}
      {sheets.map((sh) => (
        <div
          key={sh.key}
          className="product-label-print-sheet"
          style={{
            width: `${sh.widthMm}mm`,
            height: `${sh.heightMm}mm`,
          }}
        >
          <img
            src={sh.blobUrl}
            alt=""
            width={sh.widthPx}
            height={sh.heightPx}
            style={{
              width: `${sh.widthMm}mm`,
              height: `${sh.heightMm}mm`,
            }}
            onLoad={schedulePrintWhenReady}
            onError={() => setError((prev) => prev || 'Не удалось отобразить этикетку')}
            ref={(el) => {
              if (el?.complete) schedulePrintWhenReady();
            }}
          />
        </div>
      ))}
    </>
  );
}
