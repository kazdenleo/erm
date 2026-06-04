/**
 * Поиск товаров: штрихкод, артикул (SKU), название — локально и через API.
 */

import { productsApi } from '../services/products.api';
import {
  barcodeStringsFromProduct,
  isCorruptBarcodeString,
  shouldUseBarcodeDigitFallback,
} from './productBarcodes.js';

export function normalizeProductSearchQuery(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, '')
    .trim();
}

/** Распаковать карточку товара из ответа API (data / data.data / плоский объект). */
export function unwrapProductFromApiResponse(wrap) {
  if (wrap == null) return null;
  if (typeof wrap !== 'object') return null;
  if (wrap.id != null && String(wrap.id).trim() !== '') return wrap;
  const inner = wrap.data;
  if (inner && typeof inner === 'object') {
    if (inner.id != null && String(inner.id).trim() !== '') return inner;
    if (inner.data?.id != null) return inner.data;
  }
  return null;
}

/**
 * Сканер инвентаризации / приёмки: только точный getByBarcode (DT-00229 и EAN).
 * Без fuzzy-поиска по каталогу — он подставлял чужие товары.
 */
export async function fetchProductByScanCode(code) {
  const v = normalizeProductSearchQuery(code);
  if (!v) {
    throw new Error('Введите штрихкод / артикул');
  }
  if (isCorruptBarcodeString(v)) {
    throw new Error(
      'Битый штрихкод (object). Откройте карточку товара, введите правильный код и сохраните.'
    );
  }
  try {
    const wrap = await productsApi.getByBarcode(v);
    const product = unwrapProductFromApiResponse(wrap);
    if (product?.id) return product;
  } catch (e) {
    if (!shouldUseBarcodeDigitFallback(v)) throw e;
  }
  if (!shouldUseBarcodeDigitFallback(v)) {
    throw new Error(`Товар со штрихкодом «${v}» не найден в базе`);
  }
  const matches = await searchProductsCombined(v, { products: [], limit: 5 });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Найдено несколько товаров по коду «${v}» — уточните этикетку`);
  }
  throw new Error(`Товар со штрихкодом «${v}» не найден`);
}

/** Скорее всего ввод со сканера (цифры, без букв). */
export function isLikelyBarcodeScan(raw) {
  const v = normalizeProductSearchQuery(raw);
  if (!v) return false;
  if (/[a-zа-я]/i.test(v)) return false;
  return /^\d{4,}$/.test(v);
}

export function matchProductsLocal(products, query, { limit = 30 } = {}) {
  const q = normalizeProductSearchQuery(query).toLowerCase();
  if (!q) return [];
  const list = Array.isArray(products) ? products.filter(Boolean) : [];

  const exactSku = list.filter((p) => String(p?.sku || '').trim().toLowerCase() === q);
  if (exactSku.length) return exactSku.slice(0, limit);

  const exactBarcode = list.filter((p) =>
    barcodeStringsFromProduct(p.barcodes).some(
      (b) => String(b || '').trim().toLowerCase() === q
    )
  );
  if (exactBarcode.length) return exactBarcode.slice(0, limit);

  const strictCode = !shouldUseBarcodeDigitFallback(q);
  const scored = list
    .map((p) => {
      const sku = String(p?.sku || '').toLowerCase();
      const name = String(p?.name || '').toLowerCase();
      const barcodeList = barcodeStringsFromProduct(p.barcodes).map((b) =>
        String(b || '').toLowerCase()
      );
      const hitSku = strictCode ? sku === q : sku.includes(q);
      const hitName = name.includes(q);
      const hitBarcode = strictCode
        ? barcodeList.some((b) => b === q)
        : barcodeList.some((b) => b.includes(q));
      if (!hitSku && !hitName && !hitBarcode) return null;
      const score =
        (hitSku ? 2 : 0) + (hitName ? 1 : 0) + (hitBarcode ? 2 : 0) + (sku.startsWith(q) ? 1 : 0);
      return { p, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.p).slice(0, limit);
}

export function mergeProductLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const p of list || []) {
      if (p?.id == null) continue;
      map.set(String(p.id), p);
    }
  }
  return [...map.values()];
}

export async function searchProductsRemote(query, { organizationId = null, limit = 40 } = {}) {
  const q = normalizeProductSearchQuery(query);
  if (!q || q.length < 1) return [];
  try {
    const res = await productsApi.getAll({
      search: q,
      organizationId: organizationId || undefined,
      limit,
      listView: 'full',
    });
    return Array.isArray(res?.data) ? res.data.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function searchProductsCombined(query, { products = [], organizationId = null, limit = 40 } = {}) {
  const q = normalizeProductSearchQuery(query);
  if (!q) return [];

  const strictVendorCode = !shouldUseBarcodeDigitFallback(q);
  try {
    const byBarcode = await fetchProductByScanCode(q);
    if (byBarcode?.id) return [byBarcode];
  } catch (err) {
    if (strictVendorCode) throw err;
    /* fallback для чисто цифровых EAN */
  }

  const local = matchProductsLocal(products, q, { limit });
  const remote = await searchProductsRemote(q, { organizationId, limit });
  return mergeProductLists(local, remote).slice(0, limit);
}

/**
 * Один товар или null; при нескольких совпадениях — onPickRequired(matches).
 */
export async function resolveProductByQuery(
  query,
  { products = [], organizationId = null, onPickRequired = null } = {}
) {
  const q = normalizeProductSearchQuery(query);
  if (!q) return null;

  const matches = await searchProductsCombined(q, { products, organizationId, limit: 40 });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    if (typeof onPickRequired === 'function') {
      return onPickRequired(matches);
    }
    return null;
  }
  return null;
}

export function formatProductOptionLabel(p) {
  if (!p) return '—';
  const sku = String(p.sku || '').trim();
  const name = String(p.name || '').trim();
  if (sku && name) return `${sku} — ${name}`;
  return sku || name || `Товар #${p.id}`;
}

/** Строка поставки FBO: название, артикул, штрихкод. */
export function supplyItemSearchHaystack(it) {
  const name = String(it?.productName || it?.name || '').trim().toLowerCase();
  const sku = String(it?.sku || '').trim().toLowerCase();
  const barcode = String(it?.barcode || '').trim().toLowerCase();
  const extraBarcodes = barcodeStringsFromProduct(it?.barcodes)
    .map((b) => String(b || '').trim().toLowerCase())
    .filter(Boolean);
  return { name, sku, barcode, extraBarcodes };
}

export function supplyItemMatchesQuery(it, query) {
  const q = normalizeProductSearchQuery(query).toLowerCase();
  if (!q) return true;
  const { name, sku, barcode, extraBarcodes } = supplyItemSearchHaystack(it);
  if (sku === q || barcode === q || extraBarcodes.includes(q)) return true;
  return name.includes(q) || sku.includes(q) || barcode.includes(q) || extraBarcodes.some((b) => b.includes(q));
}

export function filterSupplyItemsByQuery(items, query) {
  const q = normalizeProductSearchQuery(query);
  if (!q) return Array.isArray(items) ? items : [];
  return (items || []).filter((it) => supplyItemMatchesQuery(it, q));
}
