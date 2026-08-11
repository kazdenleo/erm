/**
 * Печать этикеток нескольких товаров в одной вкладке (один диалог печати).
 * Данные передаются через localStorage (см. openProductLabelsBatchPrintTab).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import { readProductLabelsBatchPayload } from '../../hooks/useProductLabelPrint.js';

const MM_TO_PX = 8;
const FETCH_CONCURRENCY = 4;

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
  return err?.message || 'ошибка загрузки';
}

async function mapPool(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await mapper(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function PrintProductLabelsBatch() {
  const payload = useMemo(() => readProductLabelsBatchPayload(), []);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const loadedKeysRef = useRef(new Set());
  const printCalledRef = useRef(false);
  const expectedKeysRef = useRef(new Set());

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
    loadedKeysRef.current = new Set();
    printCalledRef.current = false;
    expectedKeysRef.current = new Set(sheets.map((s) => s.key));
  }, [sheets]);

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
      setProgress({ done: 0, total: items.length });
      let done = 0;

      const settled = await mapPool(items, FETCH_CONCURRENCY, async (raw) => {
        const productId = raw?.productId != null ? String(raw.productId).trim() : '';
        if (!productId) {
          done += 1;
          if (!cancelled) setProgress({ done, total: items.length });
          return { ok: false, skip: true };
        }
        const copies = normalizeCopies(raw.copies);
        const marketplace = raw?.marketplace != null ? String(raw.marketplace).trim() : '';
        try {
          const res = await api.get(`/products/${encodeURIComponent(productId)}/label`, {
            params: {
              format: 'png',
              ...(marketplace ? { marketplace } : {}),
            },
            responseType: 'blob',
            timeout: 60000,
            headers: { Accept: 'image/png' },
          });
          if (cancelled) return { ok: false, cancelled: true };
          if (res.data?.type && String(res.data.type).includes('json')) {
            const text = await res.data.text();
            let msg = 'ошибка загрузки';
            try {
              msg = JSON.parse(text)?.message || msg;
            } catch {
              if (text?.trim()) msg = text.trim();
            }
            done += 1;
            if (!cancelled) setProgress({ done, total: items.length });
            return {
              ok: false,
              productId,
              title: raw.title || productId,
              error: String(msg),
            };
          }
          const blobUrl = URL.createObjectURL(res.data);
          urlsToRevoke.push(blobUrl);
          done += 1;
          if (!cancelled) setProgress({ done, total: items.length });
          return {
            ok: true,
            productId,
            copies,
            title: raw.title || '',
            blobUrl,
            widthMm: readMmHeader(res.headers, 'x-label-width-mm', 58),
            heightMm: readMmHeader(res.headers, 'x-label-height-mm', 40),
          };
        } catch (e) {
          done += 1;
          if (!cancelled) setProgress({ done, total: items.length });
          return {
            ok: false,
            productId,
            title: raw.title || productId,
            error: await messageFromLabelError(e),
          };
        }
      });

      if (cancelled) return;

      const loaded = [];
      const errors = [];
      for (const row of settled) {
        if (!row || row.skip || row.cancelled) continue;
        if (row.ok) loaded.push(row);
        else if (row.error) errors.push(`${row.title || row.productId}: ${row.error}`);
      }

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

  const tryPrint = useCallback(() => {
    if (printCalledRef.current) return;
    const expected = expectedKeysRef.current;
    if (!expected.size) return;
    if (loadedKeysRef.current.size < expected.size) return;
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
  }, []);

  const markSheetReady = useCallback(
    (key) => {
      loadedKeysRef.current.add(key);
      tryPrint();
    },
    [tryPrint]
  );

  if (loading) {
    return (
      <p style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        Загрузка этикеток… {progress.total ? `${progress.done} / ${progress.total}` : ''}
      </p>
    );
  }

  if (!sheets.length && error) {
    return <p style={{ padding: 24, color: '#b00', whiteSpace: 'pre-wrap' }}>{error}</p>;
  }

  const pageSizeCss =
    sheets[0] != null ? `${sheets[0].widthMm}mm ${sheets[0].heightMm}mm` : '58mm 40mm';

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
            onLoad={() => markSheetReady(sh.key)}
            onError={() => {
              setError((prev) => prev || 'Не удалось отобразить часть этикеток');
              markSheetReady(sh.key);
            }}
          />
        </div>
      ))}
    </>
  );
}
