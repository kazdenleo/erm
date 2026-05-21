/**
 * Печать этикетки товара: Print Helper или страница /print/product-label/:id
 */

import { useCallback, useState } from 'react';
import api, { resolveApiBaseUrl } from '../services/api';
import { getStoredLabelSize } from '../pages/Settings/Labels.jsx';

const PRINT_HELPER_FETCH_MS = 25000;

function openPrintFallbackPage(url) {
  try {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;border:0';
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => {
      try {
        iframe.contentWindow?.print();
      } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      setTimeout(() => iframe.remove(), 60000);
    }, 1500);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function useProductLabelPrint(printHelperUrl = '') {
  const [error, setError] = useState(null);
  const [printing, setPrinting] = useState(false);

  const printProductLabel = useCallback(
    async (productId) => {
      const id = productId != null ? String(productId).trim() : '';
      if (!id) return;

      setPrinting(true);
      setError(null);

      const labelPrintPageUrl = `/print/product-label/${encodeURIComponent(id)}`;
      const labelFilePath = `/products/${encodeURIComponent(id)}/label`;
      const labelFileUrl = `${resolveApiBaseUrl()}${labelFilePath}?format=png`;

      let printWindow = null;
      const labelFileUrlAbs = (() => {
        try {
          return new URL(labelFileUrl, window.location.origin).toString();
        } catch {
          return labelFileUrl;
        }
      })();

      const canUseLocalHelper = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false;
      const base = canUseLocalHelper ? (printHelperUrl || '').trim().replace(/\/$/, '') : '';
      const willUseHelper = Boolean(base);

      if (!willUseHelper) {
        try {
          printWindow = window.open('about:blank', '_blank', 'noopener,noreferrer');
        } catch {
          printWindow = null;
        }
      }

      try {
        await api.get(labelFilePath, {
          responseType: 'blob',
          timeout: PRINT_HELPER_FETCH_MS,
          headers: { Accept: 'image/png' },
        });
      } catch (e) {
        const status = e?.response?.status || 0;
        const msg =
          e?.response?.data?.message ||
          (status === 400
            ? 'У товара нет категории или шаблона этикетки.'
            : status === 404
              ? 'Товар не найден.'
              : 'Не удалось сформировать этикетку.');
        setError(String(msg));
        setPrinting(false);
        try {
          if (printWindow && !printWindow.closed) printWindow.close();
        } catch {
          /* ignore */
        }
        return;
      }

      if (!willUseHelper) {
        try {
          if (printWindow && !printWindow.closed) {
            printWindow.location.href = labelPrintPageUrl;
            setPrinting(false);
            return;
          }
        } catch {
          /* ignore */
        }
        openPrintFallbackPage(labelPrintPageUrl);
        setPrinting(false);
        return;
      }

      const labelSize = getStoredLabelSize();
      const helperUrl = `${base}/print?orderId=product-${encodeURIComponent(id)}&labelUrl=${encodeURIComponent(labelFileUrlAbs)}&labelSize=${encodeURIComponent(labelSize)}`;

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), PRINT_HELPER_FETCH_MS);
      try {
        const r = await fetch(helperUrl, { method: 'GET', mode: 'cors', signal: ac.signal });
        if (r.ok) {
          setPrinting(false);
          return;
        }
        throw new Error((await r.json().catch(() => ({})))?.message || 'Принтер не ответил');
      } catch {
        try {
          if (printWindow && !printWindow.closed) printWindow.close();
        } catch {
          /* ignore */
        }
        openPrintFallbackPage(labelPrintPageUrl);
      } finally {
        clearTimeout(t);
        setPrinting(false);
      }
    },
    [printHelperUrl]
  );

  return { printProductLabel, printing, error, setError };
}
