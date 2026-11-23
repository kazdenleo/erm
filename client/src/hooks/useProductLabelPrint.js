/**
 * Печать этикетки: Print Helper (автоматически) или одна соседняя вкладка /print/product-label/:id.
 * Без about:blank — вкладка открывается сразу на странице печати (по клику пользователя).
 */

import { useCallback, useState } from 'react';
import api, { resolveApiBaseUrl } from '../services/api';
import { getStoredLabelSize } from '../pages/Settings/Labels.jsx';
import {
  appendAccessTokenToUrl,
  canReachPrintHelper,
  fetchPrintHelperHealth,
  printViaPrintHelper,
} from '../utils/printHelperClient.js';

const PRINT_HELPER_FETCH_MS = 60000;
const PRINT_HELPER_URL_DEFAULT = 'http://127.0.0.1:9100';
export const PRODUCT_LABELS_BATCH_STORAGE_KEY = 'erm:product-labels-batch';
/** Кэш URL Print Helper — чтобы первые сканы после открытия страницы не уходили во вкладку браузера. */
export const PRINT_HELPER_URL_CACHE_KEY = 'erm:printHelperUrl';
const BATCH_PAYLOAD_TTL_MS = 10 * 60 * 1000;

export function cachePrintHelperUrl(url = '') {
  const v = String(url || '').trim();
  try {
    if (v) sessionStorage.setItem(PRINT_HELPER_URL_CACHE_KEY, v);
  } catch {
    /* ignore */
  }
  return v;
}

export function readCachedPrintHelperUrl() {
  try {
    return String(sessionStorage.getItem(PRINT_HELPER_URL_CACHE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/** Актуальный URL: проп страницы, кэш с прошлого захода или localhost. */
export function resolvePrintHelperUrl(printHelperUrl = '') {
  const fromProp = String(printHelperUrl || '').trim();
  if (fromProp) return fromProp;
  return readCachedPrintHelperUrl() || PRINT_HELPER_URL_DEFAULT;
}

function readAccessToken() {
  try {
    return localStorage.getItem('token') || '';
  } catch {
    return '';
  }
}

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
  return canReachPrintHelper(printHelperUrl);
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

export function buildPackagingLabelPrintPageUrl(productId, barcode, unitsPerBox) {
  const id = productId != null ? String(productId).trim() : '';
  const code = String(barcode || '').trim();
  const params = new URLSearchParams({ barcode: code });
  const u = Math.floor(Number(unitsPerBox) || 0);
  if (u > 0) params.set('units', String(u));
  return `/api/products/${encodeURIComponent(id)}/packaging-label/print?${params.toString()}`;
}

export function openPackagingLabelPrintTab(productId, barcode, unitsPerBox) {
  const url = buildPackagingLabelPrintPageUrl(productId, barcode, unitsPerBox);
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

/**
 * Печать ШК упаковки: Print Helper (kind=packaging) или вкладка с автопечатью.
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function printPackagingBarcodeLabel(printHelperUrl, productId, barcode, unitsPerBox) {
  const id = productId != null ? String(productId).trim() : '';
  const code = String(barcode || '').trim();
  if (!id || !code) return { ok: false, message: 'Нет товара или штрихкода упаковки' };

  const units = Math.floor(Number(unitsPerBox) || 0);
  const params = { format: 'png', barcode: code, ...(units > 0 ? { units: String(units) } : {}) };

  if (!canUsePrintHelper(printHelperUrl)) {
    return {
      ok: false,
      message:
        'Нужен Print Helper на этом ПК (Настройки → Этикетки). Без него откроется окно печати Windows.',
    };
  }

  const base = resolvePrintHelperUrl(printHelperUrl).replace(/\/$/, '');
  const labelSize = getStoredLabelSize() || '58x40';
  let warmedBlob = null;

  // Прогрев с Bearer → POST blob в Print Helper (без публичного URL без токена).
  try {
    const warm = await api.get(`/products/${encodeURIComponent(id)}/packaging-label`, {
      params,
      responseType: 'blob',
      timeout: PRINT_HELPER_FETCH_MS,
      headers: { Accept: 'image/png' },
    });
    warmedBlob = warm?.data instanceof Blob ? warm.data : null;
  } catch (e) {
    return { ok: false, message: await errorMessageFromLabelRequest(e) };
  }

  const qs = new URLSearchParams({ format: 'png', barcode: code });
  if (units > 0) qs.set('units', String(units));
  const labelPngPath = `/products/${encodeURIComponent(id)}/packaging-label?${qs.toString()}`;
  const labelPngUrl = `${resolveApiBaseUrl()}${labelPngPath}`;
  const labelPngUrlAbs = (() => {
    try {
      return new URL(labelPngUrl, window.location.origin).toString();
    } catch {
      return labelPngUrl;
    }
  })();
  const labelUrlWithToken = appendAccessTokenToUrl(labelPngUrlAbs, readAccessToken());

  let printed = { ok: false, message: '' };
  if (warmedBlob && warmedBlob.size > 0) {
    printed = await printViaPrintHelper({
      printHelperUrl: base,
      kind: 'packaging',
      pdfBuffer: warmedBlob,
      orderId: `packaging-${id}-${Date.now()}`,
      labelSize,
      timeoutMs: PRINT_HELPER_FETCH_MS,
    });
  }
  if (!printed.ok) {
    printed = await printViaPrintHelper({
      printHelperUrl: base,
      kind: 'packaging',
      labelUrl: labelUrlWithToken,
      orderId: `packaging-${id}-${Date.now()}`,
      labelSize,
      timeoutMs: PRINT_HELPER_FETCH_MS,
    });
  }
  if (!printed.ok) {
    printed = await printViaPrintHelper({
      printHelperUrl: base,
      kind: 'product',
      ...(warmedBlob && warmedBlob.size > 0
        ? { pdfBuffer: warmedBlob }
        : { labelUrl: labelUrlWithToken }),
      orderId: `packaging-${id}-${Date.now()}`,
      labelSize,
      timeoutMs: PRINT_HELPER_FETCH_MS,
    });
  }

  if (printed.ok) return { ok: true };

  const health = await fetchPrintHelperHealth(base);
  return {
    ok: false,
    message: health.ok
      ? `Тихая печать не удалась: ${printed.message || 'ошибка Print Helper'}. Проверьте принтер «ШК упаковок».`
      : 'Print Helper не отвечает (http://127.0.0.1:9100). Установите и запустите его на ПК с принтером.',
  };
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
      // По умолчанию не открываем окно печати Windows — только Print Helper.
      // Явный allowBrowserFallback: true — запасной путь (старые сценарии / HTTP).
      const allowBrowserFallback = options.allowBrowserFallback === true;
      const helperUrl = resolvePrintHelperUrl(printHelperUrl);

      if (!canUsePrintHelper(helperUrl)) {
        if (!allowBrowserFallback) {
          setError(
            'Нужен Print Helper на этом ПК (Настройки → Этикетки → скачать и запустить). Иначе откроется окно печати Windows.'
          );
          return false;
        }
        return openProductLabelPrintTab(id, copies, options.marketplace);
      }

      setPrinting(true);
      setError(null);

      const labelFilePath = `/products/${encodeURIComponent(id)}/label`;
      const mp =
        options.marketplace != null && String(options.marketplace).trim() !== ''
          ? String(options.marketplace).trim()
          : '';
      const base = String(helperUrl || PRINT_HELPER_URL_DEFAULT).trim().replace(/\/$/, '');
      cachePrintHelperUrl(base);

      const healthBefore = await fetchPrintHelperHealth(base);
      if (!healthBefore.ok) {
        setPrinting(false);
        if (allowBrowserFallback) {
          return openProductLabelPrintTab(id, copies, options.marketplace);
        }
        setError(
          'Print Helper не отвечает (http://127.0.0.1:9100). Установите/запустите его на ПК с принтером — Настройки → Этикетки.'
        );
        return false;
      }

      let warmedBlob = null;
      try {
        const warm = await api.get(labelFilePath, {
          params: {
            format: 'png',
            ...(mp ? { marketplace: mp } : {}),
          },
          responseType: 'blob',
          timeout: PRINT_HELPER_FETCH_MS,
          headers: { Accept: 'image/png' },
        });
        warmedBlob = warm?.data instanceof Blob ? warm.data : null;
      } catch (e) {
        setError(await errorMessageFromLabelRequest(e));
        setPrinting(false);
        return false;
      }

      const labelSize = getStoredLabelSize();
      const pngQuery = new URLSearchParams({ format: 'png' });
      if (mp) pngQuery.set('marketplace', mp);
      const labelPngUrl = `${resolveApiBaseUrl()}${labelFilePath}?${pngQuery.toString()}`;
      const labelPngUrlAbs = (() => {
        try {
          return new URL(labelPngUrl, window.location.origin).toString();
        } catch {
          return labelPngUrl;
        }
      })();
      const labelUrlWithToken = appendAccessTokenToUrl(labelPngUrlAbs, readAccessToken());

      let printed = { ok: false, message: '' };
      for (let copyIndex = 0; copyIndex < copies; copyIndex += 1) {
        const orderId = `product-${id}-${Date.now()}-c${copyIndex + 1}`;
        printed = { ok: false, message: '' };
        if (warmedBlob && warmedBlob.size > 0) {
          printed = await printViaPrintHelper({
            printHelperUrl: base,
            kind: 'product',
            pdfBuffer: warmedBlob,
            orderId,
            labelSize,
            timeoutMs: PRINT_HELPER_FETCH_MS,
          });
        }
        if (!printed.ok) {
          printed = await printViaPrintHelper({
            printHelperUrl: base,
            kind: 'product',
            labelUrl: labelUrlWithToken,
            orderId: `${orderId}-url`,
            labelSize,
            timeoutMs: PRINT_HELPER_FETCH_MS,
          });
        }
        if (!printed.ok) break;
      }

      setPrinting(false);

      if (printed.ok) {
        return true;
      }

      setError(
        printed.message
          ? `Тихая печать не удалась: ${printed.message}. Проверьте принтер «Стикеры товаров» в Настройки → Этикетки и что Print Helper запущен.`
          : 'Print Helper не напечатал этикетку. Проверьте принтер и что помощник печати запущен.'
      );
      if (allowBrowserFallback) {
        return openProductLabelPrintTab(id, copies, options.marketplace);
      }
      return false;
    },
    [printHelperUrl]
  );

  return { printProductLabel, printing, error, setError };
}
