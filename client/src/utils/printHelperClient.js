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
  // labelSize нужен только для PNG→PDF; для готового PDF не шлём.
  const labelSize = opts.pdfBuffer ? '' : opts.labelSize || getStoredLabelSize();
  const orderId = opts.orderId != null ? String(opts.orderId) : `label-${Date.now()}`;
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
      if (!body) return { ok: false, message: 'Пустой PDF' };
      const r = await fetch(`${base}/print?${qs.toString()}`, {
        method: 'POST',
        mode: 'cors',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/pdf' },
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
