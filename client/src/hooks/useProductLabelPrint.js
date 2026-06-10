/**
 * Печать этикетки: Print Helper (автоматически) или одна соседняя вкладка /print/product-label/:id.
 * Без about:blank — вкладка открывается сразу на странице печати (по клику пользователя).
 */

import { useCallback, useState } from 'react';
import api, { resolveApiBaseUrl } from '../services/api';
import { getStoredLabelSize } from '../pages/Settings/Labels.jsx';

const PRINT_HELPER_FETCH_MS = 25000;
export const PRODUCT_LABELS_BATCH_STORAGE_KEY = 'erm:product-labels-batch';
const BATCH_PAYLOAD_TTL_MS = 10 * 60 * 1000;

function normalizeBatchItem(raw) {
  const productId = raw?.productId != null ? String(raw.productId).trim() : '';
  if (!productId) return null;
  const copiesRaw = Number(raw.copies);
  const copies =
    Number.isFinite(copiesRaw) && copiesRaw >= 1
      ? Math.min(99, Math.floor(copiesRaw))
      : 1;
  const title = raw.title != null ? String(raw.title).trim() : '';
  const marketplace = raw?.marketplace != null ? String(raw.marketplace).trim() : '';
  return {
    productId,
    copies,
    title: title || undefined,
    marketplace: marketplace || undefined,
  };
}

function batchStorageGet() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Сохранить очередь печати (localStorage — общий для всех вкладок одного origin). */
export function stashProductLabelsBatch(items = []) {
  const normalized = (items || []).map(normalizeBatchItem).filter(Boolean);
  if (!normalized.length) return false;
  const storage = batchStorageGet();
  if (!storage) return false;
  try {
    const payload = JSON.stringify({ ts: Date.now(), items: normalized });
    storage.setItem(PRODUCT_LABELS_BATCH_STORAGE_KEY, payload);
    // sessionStorage не виден в новой вкладке — убираем устаревшие данные
    try {
      sessionStorage.removeItem(PRODUCT_LABELS_BATCH_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

export function readProductLabelsBatchPayload() {
  const storages = [batchStorageGet(), (() => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  })()].filter(Boolean);

  for (const storage of storages) {
    try {
      const raw = storage.getItem(PRODUCT_LABELS_BATCH_STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const ts = Number(parsed?.ts);
      if (!Number.isFinite(ts) || Date.now() - ts > BATCH_PAYLOAD_TTL_MS) {
        storage.removeItem(PRODUCT_LABELS_BATCH_STORAGE_KEY);
        continue;
      }
      const items = (parsed?.items || []).map(normalizeBatchItem).filter(Boolean);
      if (items.length) return { items };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Одна вкладка — все выбранные этикетки (по количеству в каждой строке). */
export function openProductLabelsBatchPrintTab(items = []) {
  if (!stashProductLabelsBatch(items)) return false;
  const url = '/print/product-labels-batch';
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

export function buildProductLabelPrintPageUrl(productId, copies = 1, marketplace = null) {
  const id = productId != null ? String(productId).trim() : '';
  const n = Number(copies);
  const count = Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
  const params = new URLSearchParams();
  if (count > 1) params.set('copies', String(count));
  const mp = marketplace != null ? String(marketplace).trim() : '';
  if (mp) params.set('marketplace', mp);
  const qs = params.toString();
  return `/print/product-label/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
}

/** Открыть одну соседнюю вкладку со страницей печати (вызывать синхронно по клику). */
export function openProductLabelPrintTab(productId, copies = 1, marketplace = null) {
  const url = buildProductLabelPrintPageUrl(productId, copies, marketplace);
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

      // Несколько копий — вкладка /print/product-label (дублирует листы); Print Helper печатает 1 PNG.
      if (copies > 1) {
        const ok = openProductLabelPrintTab(id, copies, options.marketplace);
        if (!ok) {
          setError('Не удалось открыть вкладку печати. Разрешите всплывающие окна для этого сайта.');
        }
        return ok;
      }

      if (!canUsePrintHelper(printHelperUrl)) {
        return openProductLabelPrintTab(id, copies, options.marketplace);
      }

      setPrinting(true);
      setError(null);

      const labelPrintPageUrl = buildProductLabelPrintPageUrl(id, copies, options.marketplace);
      const labelFilePath = `/products/${encodeURIComponent(id)}/label`;
      const labelQuery = new URLSearchParams({ format: 'pdf' });
      if (copies > 1) labelQuery.set('copies', String(copies));
      if (options.marketplace) labelQuery.set('marketplace', String(options.marketplace));
      const labelFileUrl = `${resolveApiBaseUrl()}${labelFilePath}?${labelQuery.toString()}`;
      const labelPngUrl = `${resolveApiBaseUrl()}${labelFilePath}?format=png`;
      const base = String(printHelperUrl || '').trim().replace(/\/$/, '');

      try {
        await api.get(labelFilePath, {
          params: {
            format: 'png',
            ...(options.marketplace ? { marketplace: String(options.marketplace) } : {}),
          },
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

      if (!openProductLabelPrintTab(id, copies, options.marketplace)) {
        setError('Print Helper не ответил. Разрешите всплывающие окна для печати в браузере.');
        return false;
      }
      return true;
    },
    [printHelperUrl]
  );

  return { printProductLabel, printing, error, setError };
}
