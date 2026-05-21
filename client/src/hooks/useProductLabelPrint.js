/**
 * Печать этикетки: Print Helper (автоматически) или одна соседняя вкладка /print/product-label/:id.
 * Без about:blank — вкладка открывается сразу на странице печати (по клику пользователя).
 */

import { useCallback, useState } from 'react';
import api, { resolveApiBaseUrl } from '../services/api';
import { getStoredLabelSize } from '../pages/Settings/Labels.jsx';

const PRINT_HELPER_FETCH_MS = 25000;

async function errorMessageFromLabelRequest(err) {
  const status = err?.response?.status || 0;
  const data = err?.response?.data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      const text = await data.text();
      try {
        const j = text ? JSON.parse(text) : null;
        const msg = j?.message || j?.error || '';
        if (msg) return String(msg);
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
  if (status >= 500) return 'Ошибка сервера при формировании этикетки. Перезапустите API и повторите.';
  return err?.message || 'Не удалось сформировать этикетку.';
}

export function canUsePrintHelper(printHelperUrl = '') {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  return Boolean(String(printHelperUrl || '').trim());
}

export function buildProductLabelPrintPageUrl(productId, copies = 1) {
  const id = productId != null ? String(productId).trim() : '';
  const n = Number(copies);
  const count = Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
  const copiesQuery = count > 1 ? `?copies=${count}` : '';
  return `/print/product-label/${encodeURIComponent(id)}${copiesQuery}`;
}

/** Открыть одну соседнюю вкладку со страницей печати (вызывать синхронно по клику). */
export function openProductLabelPrintTab(productId, copies = 1) {
  const url = buildProductLabelPrintPageUrl(productId, copies);
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (w) {
      w.focus?.();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function useProductLabelPrint(printHelperUrl = '') {
  const [error, setError] = useState(null);
  const [printing, setPrinting] = useState(false);

  const printProductLabel = useCallback(
    async (productId, options = {}) => {
      const id = productId != null ? String(productId).trim() : '';
      if (!id) return false;

      const copiesRaw = Number(options.copies);
      const copies =
        Number.isFinite(copiesRaw) && copiesRaw >= 1
          ? Math.min(99, Math.floor(copiesRaw))
          : 1;

      if (!canUsePrintHelper(printHelperUrl)) {
        setError('Print Helper не настроен. Используйте openProductLabelPrintTab по клику.');
        return false;
      }

      setPrinting(true);
      setError(null);

      const labelPrintPageUrl = buildProductLabelPrintPageUrl(id, copies);
      const labelFilePath = `/products/${encodeURIComponent(id)}/label`;
      const labelQuery = new URLSearchParams({ format: 'pdf' });
      if (copies > 1) labelQuery.set('copies', String(copies));
      const labelFileUrl = `${resolveApiBaseUrl()}${labelFilePath}?${labelQuery.toString()}`;
      const labelPngUrl = `${resolveApiBaseUrl()}${labelFilePath}?format=png`;
      const base = String(printHelperUrl || '').trim().replace(/\/$/, '');

      try {
        await api.get(labelFilePath, {
          params: { format: 'png' },
          responseType: 'blob',
          timeout: PRINT_HELPER_FETCH_MS,
          headers: { Accept: 'image/png' },
        });
      } catch (e) {
        setError(await errorMessageFromLabelRequest(e));
        setPrinting(false);
        return false;
      }

      const labelSize = getStoredLabelSize();
      const labelPngUrlAbs = (() => {
        try {
          return new URL(labelPngUrl, window.location.origin).toString();
        } catch {
          return labelPngUrl;
        }
      })();
      const labelFileUrlAbs = (() => {
        try {
          return new URL(labelFileUrl, window.location.origin).toString();
        } catch {
          return labelFileUrl;
        }
      })();
      const helperLabelUrl = copies > 1 ? labelFileUrlAbs : labelPngUrlAbs;
      const helperUrl = `${base}/print?orderId=product-${encodeURIComponent(id)}&labelUrl=${encodeURIComponent(helperLabelUrl)}&labelSize=${encodeURIComponent(labelSize)}`;

      let helperOk = false;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), PRINT_HELPER_FETCH_MS);
      try {
        const r = await fetch(helperUrl, { method: 'GET', mode: 'cors', signal: ac.signal });
        helperOk = r.ok;
      } catch {
        helperOk = false;
      } finally {
        clearTimeout(t);
      }

      setPrinting(false);

      if (helperOk) {
        return true;
      }

      if (!openProductLabelPrintTab(id, copies)) {
        setError('Print Helper не ответил. Разрешите всплывающие окна для печати в браузере.');
        return false;
      }
      return true;
    },
    [printHelperUrl]
  );

  return { printProductLabel, printing, error, setError };
}
