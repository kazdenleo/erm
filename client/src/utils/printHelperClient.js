/**
 * Клиент локального Print Helper: список принтеров и тихая печать на выбранный.
 */

import { getStoredLabelSize } from '../pages/Settings/Labels.jsx';
import { getLabelPrinter } from './labelPrinterSettings.js';

const PRINT_HELPER_FETCH_MS = 25000;

export function normalizePrintHelperBase(printHelperUrl = '') {
  return String(printHelperUrl || '').trim().replace(/\/$/, '');
}

export function canReachPrintHelper(printHelperUrl = '') {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  return Boolean(normalizePrintHelperBase(printHelperUrl));
}

/**
 * HTTP-сайт (не secure context) не может fetch на 127.0.0.1 (Private Network Access).
 * Top-level/iframe-навигация на Print Helper всё ещё доходит — helper сам качает этикетку.
 * @returns {{ ok: boolean, mode: 'navigate' }}
 */
export function printViaPrintHelperNavigation(opts = {}) {
  const base = normalizePrintHelperBase(opts.printHelperUrl) || 'http://127.0.0.1:9100';
  if (typeof document === 'undefined') return { ok: false, mode: 'navigate', message: 'Нет document' };

  const orderIdRaw = opts.orderId != null ? String(opts.orderId) : `label-${Date.now()}`;
  const orderId =
    orderIdRaw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 80) ||
    `label-${Date.now()}`;
  const printer =
    opts.printer != null ? String(opts.printer).trim() : getLabelPrinter(opts.kind);
  const labelSize =
    opts.labelSize != null && String(opts.labelSize).trim() !== ''
      ? String(opts.labelSize).trim()
      : getStoredLabelSize();

  if (!opts.labelUrl) return { ok: false, mode: 'navigate', message: 'Нет URL этикетки' };

  const qs = new URLSearchParams();
  qs.set('orderId', orderId);
  qs.set('labelUrl', String(opts.labelUrl));
  if (labelSize) qs.set('labelSize', labelSize);
  if (printer) qs.set('printer', printer);

  const href = `${base}/print?${qs.toString()}`;
  // Top-level навигация на 127.0.0.1 обычно проходит при HTTP-сайте; iframe/fetch — нет (PNA).
  try {
    const w = window.open(href, 'erm-print-helper', 'noopener,noreferrer,width=320,height=200');
    if (w) {
      setTimeout(() => {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }, 8000);
      return { ok: true, mode: 'navigate' };
    }
  } catch {
    /* ignore — пробуем iframe */
  }
  try {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.title = 'ERM Print Helper';
    iframe.style.cssText =
      'position:fixed;width:0;height:0;border:0;left:0;top:0;clip:rect(0,0,0,0);visibility:hidden';
    iframe.src = href;
    document.body.appendChild(iframe);
    setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    }, 120000);
    return { ok: true, mode: 'navigate' };
  } catch (e) {
    return { ok: false, mode: 'navigate', message: e?.message || 'Не удалось вызвать Print Helper' };
  }
}

/** Токен в query — чтобы Print Helper скачал /orders/.../label без Bearer. */
export function appendAccessTokenToUrl(url, token) {
  const t = token != null ? String(token).trim() : '';
  if (!t || !url) return String(url || '');
  try {
    const u = new URL(String(url), typeof window !== 'undefined' ? window.location.origin : undefined);
    u.searchParams.set('access_token', t);
    return u.toString();
  } catch {
    const sep = String(url).includes('?') ? '&' : '?';
    return `${url}${sep}access_token=${encodeURIComponent(t)}`;
  }
}

/**
 * @returns {Promise<{ printers: string[], message?: string }>}
 */
export async function fetchPrintHelperPrinters(printHelperUrl = '') {
  const base = normalizePrintHelperBase(printHelperUrl);
  if (!base) return { printers: [], message: 'Print Helper URL не задан' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(`${base}/printers`, { method: 'GET', mode: 'cors', signal: ac.signal });
    const body = await r.json().catch(() => ({}));
    const list = Array.isArray(body?.printers) ? body.printers : Array.isArray(body?.data) ? body.data : [];
    const printers = list.map((x) => String(x || '').trim()).filter(Boolean);
    if (!r.ok && !printers.length) {
      return { printers: [], message: body?.message || `Print Helper HTTP ${r.status}` };
    }
    return {
      printers,
      message: printers.length ? undefined : body?.message || undefined,
    };
  } catch (e) {
    if (e?.name === 'AbortError') {
      return { printers: [], message: 'Таймаут запроса списка принтеров' };
    }
    return { printers: [], message: e?.message || 'Print Helper недоступен' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {{
 *   printHelperUrl: string,
 *   kind: string,
 *   labelUrl?: string,
 *   pdfBuffer?: ArrayBuffer|Blob|Uint8Array,
 *   orderId?: string,
 *   labelSize?: string,
 *   printer?: string,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function printViaPrintHelper(opts = {}) {
  const base = normalizePrintHelperBase(opts.printHelperUrl);
  if (!base) return { ok: false, message: 'Print Helper не настроен' };

  const printer =
    opts.printer != null ? String(opts.printer).trim() : getLabelPrinter(opts.kind);
  // labelSize: для PNG→PDF в Print Helper; явный opts.labelSize всегда передаём.
  const labelSize =
    opts.labelSize != null && String(opts.labelSize).trim() !== ''
      ? String(opts.labelSize).trim()
      : opts.pdfBuffer
        ? ''
        : getStoredLabelSize();
  // orderId попадает в имя temp-файла — только безопасные символы (ШК в имени ломает Sumatra).
  const orderIdRaw = opts.orderId != null ? String(opts.orderId) : `label-${Date.now()}`;
  const orderId = orderIdRaw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 80) || `label-${Date.now()}`;
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || PRINT_HELPER_FETCH_MS);

  const qs = new URLSearchParams();
  qs.set('orderId', orderId);
  if (labelSize) qs.set('labelSize', labelSize);
  if (printer) qs.set('printer', printer);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    if (opts.pdfBuffer) {
      const body =
        opts.pdfBuffer instanceof Blob
          ? opts.pdfBuffer
          : opts.pdfBuffer instanceof ArrayBuffer
            ? opts.pdfBuffer
            : opts.pdfBuffer?.buffer
              ? opts.pdfBuffer
              : null;
      if (!body) return { ok: false, message: 'Пустой файл этикетки' };
      const contentType =
        body instanceof Blob && body.type
          ? body.type
          : 'application/pdf';
      const r = await fetch(`${base}/print?${qs.toString()}`, {
        method: 'POST',
        mode: 'cors',
        signal: ac.signal,
        headers: { 'Content-Type': contentType.includes('png') ? 'image/png' : 'application/pdf' },
        body,
      });
      if (r.ok) return { ok: true };
      const errBody = await r.json().catch(() => ({}));
      return { ok: false, message: errBody?.message || `HTTP ${r.status}` };
    }

    if (!opts.labelUrl) return { ok: false, message: 'Нет URL этикетки' };
    qs.set('labelUrl', String(opts.labelUrl));
    const r = await fetch(`${base}/print?${qs.toString()}`, {
      method: 'GET',
      mode: 'cors',
      signal: ac.signal,
    });
    if (r.ok) return { ok: true };
    const errBody = await r.json().catch(() => ({}));
    return { ok: false, message: errBody?.message || `HTTP ${r.status}` };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, message: 'Таймаут Print Helper' };
    return { ok: false, message: e?.message || 'Print Helper недоступен' };
  } finally {
    clearTimeout(t);
  }
}
