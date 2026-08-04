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
  } catch (err) {
    if (err?.response?.status === 404) {
      throw new Error(`Товар со штрихкодом «${v}» не найден в базе`);
    }
    const msg = err?.response?.data?.message || err?.message;
    if (msg) throw new Error(msg);
    throw new Error('Не удалось найти товар по штрихкоду');
  }
  throw new Error(`Товар со штрихкодом «${v}» не найден в базе`);
}

/** Скорее всего ввод со сканера (цифры, без букв). */
export function isLikelyBarcodeScan(raw) {
  const v = normalizeProductSearchQuery(raw);
  if (!v) return false;
  if (/[a-zа-я]/i.test(v)) return false;
  return /^\d{4,}$/.test(v);
}

/** Релевантность для сортировки: точный артикул > префикс/хвост > название. */
export function scoreProductSearchMatch(product, query) {
  const q = normalizeProductSearchQuery(query).toLowerCase();
  if (!q || !product) return 0;
  const sku = String(product?.sku || '').trim().toLowerCase();
  const name = String(product?.name || '').toLowerCase();
  const barcodeList = barcodeStringsFromProduct(product.barcodes).map((b) =>
    String(b || '').trim().toLowerCase()
  );
  let score = 0;
  if (sku === q) score += 100;
  if (barcodeList.some((b) => b === q)) score += 90;
  if (sku.startsWith(q)) score += 50;
  if (sku.endsWith(q)) score += 45;
  if (sku.includes(q)) score += 30;
  const skuDigits = sku.replace(/\D/g, '');
  if (/^\d+$/.test(q) && skuDigits === q) score += 40;
  if (skuDigits.includes(q) && /^\d+$/.test(q)) score += 20;
  if (name.includes(q)) score += 10;
  if (shouldUseBarcodeDigitFallback(q) && barcodeList.some((b) => b.includes(q))) score += 15;
  return score;
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

  const strictBarcode = !shouldUseBarcodeDigitFallback(q);
  const scored = list
    .map((p) => {
      const sku = String(p?.sku || '').toLowerCase();
      const name = String(p?.name || '').toLowerCase();
      const barcodeList = barcodeStringsFromProduct(p.barcodes).map((b) =>
        String(b || '').toLowerCase()
      );
      const hitSku = sku.includes(q);
      const hitName = name.includes(q);
      const hitBarcode = strictBarcode
        ? barcodeList.some((b) => b === q)
        : barcodeList.some((b) => b.includes(q));
      if (!hitSku && !hitName && !hitBarcode) return null;
      return { p, score: scoreProductSearchMatch(p, q) };
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

export async function searchProductsRemote(
  query,
  { organizationId = null, warehouseId = null, limit = 40 } = {}
) {
  const q = normalizeProductSearchQuery(query);
  if (!q || q.length < 1) return [];
  try {
    const wh = warehouseId != null && String(warehouseId).trim() !== '' ? String(warehouseId).trim() : null;
    // typeahead / привязка ШК: только лёгкий listView=stock (без images, цен МП, supplier_stocks).
    // full тянет p.* + цены/остатки поставщиков и заметно тормозит приёмку.
    const res = await productsApi.getAll({
      search: q,
      organizationId: organizationId || undefined,
      warehouseId: wh || undefined,
      limit,
      listView: 'stock',
    });
    return Array.isArray(res?.data) ? res.data.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function searchProductsCombined(
  query,
  { products = [], organizationId = null, warehouseId = null, limit = 40 } = {}
) {
  const q = normalizeProductSearchQuery(query);
  if (!q) return [];

  let barcodeHit = null;
  if (isLikelyBarcodeScan(q)) {
    try {
      barcodeHit = await fetchProductByScanCode(q);
    } catch {
      /* не точный ШК — продолжаем поиск по артикулу и названию */
    }
  }

  // Не останавливаемся на одном совпадении по ШК: «2490» должно находить DTSN2490
  // через ILIKE, даже если getByBarcode вернул другой товар (например, по Ozon id).
  const local = matchProductsLocal(products, q, { limit });
  const remote = await searchProductsRemote(q, { organizationId, warehouseId, limit });
  const merged = mergeProductLists(barcodeHit ? [barcodeHit] : [], local, remote);
  return merged
    .map((p) => ({ p, score: scoreProductSearchMatch(p, q) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p)
    .slice(0, limit);
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
