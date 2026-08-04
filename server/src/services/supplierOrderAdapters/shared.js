/**
 * Общие утилиты для отправки закупки поставщику по API.
 */

export const MIKADO_BASKET_BASE = 'http://mikado-parts.ru/ws1/basket.asmx';
export const MIKADO_STOCK_BASE = 'http://mikado-parts.ru/ws1/service.asmx';
export const MOSKVORECHIE_API_BASE = 'http://portal.moskvorechie.ru/portal.api';

export async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === 'AbortError') {
      throw new Error(`Таймаут запроса (${timeout}ms)`);
    }
    throw error;
  }
}

/** Извлечь текст первого XML-тега (без namespace). */
export function xmlTag(xml, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = String(xml || '').match(re);
  return m ? m[1].trim() : '';
}

export function normalizeWarehouseName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Сопоставление склада поставщика по имени (частичное совпадение). */
export function warehouseNameMatches(actual, preferred) {
  const a = normalizeWarehouseName(actual);
  const p = normalizeWarehouseName(preferred);
  if (!a || !p) return false;
  return a === p || a.includes(p) || p.includes(a);
}

export function pickWarehouseLine(lines, { warehouseName, quantity } = {}) {
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const pool = (lines || []).filter((l) => l.gid || l.zakazCode || l.orderCode);
  let candidates = pool.filter((l) => (l.stock ?? 0) >= qty);
  if (!candidates.length) {
    candidates = [...pool];
  }
  if (warehouseName) {
    const matched = candidates.filter((l) => warehouseNameMatches(l.warehouseName, warehouseName));
    if (matched.length) candidates = matched;
  }
  return candidates.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))[0] || null;
}

export function buildQueryUrl(base, params, { encodeValue } = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    const k = encodeURIComponent(String(key));
    const raw = String(value);
    const v =
      typeof encodeValue === 'function' ? encodeValue(String(key), raw) : encodeURIComponent(raw);
    parts.push(`${k}=${v}`);
  }
  return `${base}?${parts.join('&')}`;
}

/**
 * Номера заказов МП из source_orders строки закупки.
 * Если есть ещё не отправленные поставщику — берём их (досылка), иначе все.
 */
export function sourceOrderIdsFromPurchaseLine(line) {
  let raw = line?.source_orders ?? line?.sourceOrders;
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const entries = raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const orderId = String(x.orderId ?? x.order_id ?? '').trim();
      if (!orderId) return null;
      const submitted = x.supplierSubmittedAt ?? x.supplier_submitted_at;
      return {
        orderId,
        pending: submitted == null || String(submitted).trim() === '',
      };
    })
    .filter(Boolean);
  const pending = entries.filter((e) => e.pending).map((e) => e.orderId);
  const ids = pending.length ? pending : entries.map((e) => e.orderId);
  return [...new Set(ids)];
}

/**
 * Комментарий к позиции/заказу у поставщика: ERM · закупка · заказ(ы) · артикул.
 * @param {{ purchaseId?: *, orderIds?: string[], sku?: string, brand?: string, ascii?: boolean }} opts
 *   ascii=true — только латиница/цифры (надёжно для Mikado Notes).
 */
export function formatSupplierPurchaseComment({
  purchaseId = null,
  orderIds = [],
  sku = '',
  brand = '',
  ascii = false,
} = {}) {
  const pid = purchaseId != null && String(purchaseId).trim() !== '' ? String(purchaseId).trim() : '';
  const orders = [...new Set((orderIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const product = [String(sku || '').trim(), String(brand || '').trim()].filter(Boolean).join(' ');

  if (ascii) {
    const parts = ['ERM'];
    if (pid) parts.push(`#${pid}`);
    if (orders.length === 1) parts.push(`order ${orders[0]}`);
    else if (orders.length > 1) parts.push(`orders ${orders.join(',')}`);
    if (product) parts.push(product);
    return parts.join(' | ');
  }

  const parts = ['ERM'];
  if (pid) parts.push(`закупка №${pid}`);
  if (orders.length === 1) parts.push(`заказ ${orders[0]}`);
  else if (orders.length > 1) parts.push(`заказы ${orders.join(', ')}`);
  if (product) parts.push(product);
  return parts.join(' · ');
}

/** Байт windows-1251 для BMP-символа (или null, если нет в 1251). */
function windows1251Byte(code) {
  if (code < 0x80) return code;
  if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0; // А-я
  if (code === 0x401) return 0xa8; // Ё
  if (code === 0x451) return 0xb8; // ё
  if (code === 0x2116) return 0xb9; // №
  if (code === 0xb7) return 0xb7; // ·
  if (code === 0xa0) return 0xa0;
  return null;
}

/**
 * Percent-encoding в windows-1251 — Mikado Basket_Add иначе показывает «Р·Р°РєСѓРїРєР°».
 */
export function encodeQueryValueWindows1251(str) {
  let out = '';
  for (const ch of String(str ?? '')) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      out += encodeURIComponent(ch);
      continue;
    }
    const b = windows1251Byte(code);
    if (b == null) {
      out += encodeURIComponent(ch);
      continue;
    }
    if (
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      b === 0x2d ||
      b === 0x2e ||
      b === 0x5f ||
      b === 0x7e
    ) {
      out += String.fromCharCode(b);
    } else if (b === 0x20) {
      out += '+';
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

