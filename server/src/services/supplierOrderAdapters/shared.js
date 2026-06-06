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
  let candidates = (lines || []).filter((l) => (l.stock ?? 0) >= qty);
  if (!candidates.length) {
    candidates = [...(lines || [])];
  }
  if (warehouseName) {
    const matched = candidates.filter((l) => warehouseNameMatches(l.warehouseName, warehouseName));
    if (matched.length) candidates = matched;
  }
  return candidates.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))[0] || null;
}

export function buildQueryUrl(base, params) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    q.set(key, String(value));
  }
  return `${base}?${q.toString()}`;
}
