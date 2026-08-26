/**
 * Сборка characteristics и sizes для WB /cards/update.
 * ERP — источник правды: пустое/укороченное значение не подменяется карточкой WB.
 */

import { formatWbCertDate } from './wbCertDate.js';
import { WB_PACK_DIM_CHARC } from './marketplaceDimensions.js';
import { coerceBarcodeString, normalizeBarcodeRows } from './productBarcodes.js';

const WB_PACK_DIM_IDS = new Set(
  [Number(WB_PACK_DIM_CHARC.length), Number(WB_PACK_DIM_CHARC.width), Number(WB_PACK_DIM_CHARC.height)].filter(
    (n) => Number.isFinite(n) && n > 0
  )
);

const WB_CHARC_TYPE_STRINGS = 1;
const WB_CHARC_TYPE_NUMBER = 4;
const WB_NUMERIC_CHARC_MAX = 9999999.99;

function parseJsonObject(v) {
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v };
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function asWbStringCharc(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const list = raw.map((x) => String(x ?? '').trim()).filter(Boolean);
    return list.length ? list : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (s.includes(';')) {
    const list = s.split(';').map((x) => x.trim()).filter(Boolean);
    return list.length ? list : null;
  }
  return [s];
}

function asWbNumberCharc(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.').replace(/\s/g, ''));
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > WB_NUMERIC_CHARC_MAX) return null;
  return n;
}

function looksLikeWbStringNotNumber(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/[./-]/.test(t) && /\d/.test(t)) return true;
  if (/^\d{8,}$/.test(t)) return true;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && Math.abs(n) > WB_NUMERIC_CHARC_MAX;
}

function coerceWbCharcValue(raw, existingValue, charcType) {
  if (raw == null) return null;
  const asDate = formatWbCertDate(raw);
  if (asDate) return asWbStringCharc(asDate);
  const type = Number(charcType);
  if (type === WB_CHARC_TYPE_NUMBER) return asWbNumberCharc(raw);
  if (type === WB_CHARC_TYPE_STRINGS || type === 0) return asWbStringCharc(raw);

  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) return asWbStringCharc(raw);

  if (typeof existingValue === 'number') return asWbNumberCharc(raw);
  if (Array.isArray(existingValue) || typeof existingValue === 'string') return asWbStringCharc(raw);
  if (typeof existingValue === 'boolean') {
    const s = String(raw).trim().toLowerCase();
    return s === '1' || s === 'true';
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (Math.abs(raw) > WB_NUMERIC_CHARC_MAX || (Number.isInteger(raw) && String(Math.trunc(raw)).length >= 8)) {
      return asWbStringCharc(raw);
    }
    return raw;
  }

  const s = String(raw).trim();
  if (!s) return null;
  if (looksLikeWbStringNotNumber(s)) return asWbStringCharc(s);
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return asWbNumberCharc(s) ?? asWbStringCharc(s);
  return asWbStringCharc(s);
}

/**
 * Полная перезапись карточки: текущие с WB (типы value) + ERP wb_attributes.
 * Если ключ есть в ERP (в т.ч. пустой) — не подставляем старое значение с WB.
 */
export function buildWbCharacteristics(wbAttrs, existingChars = null, charcTypeById = null) {
  const obj = parseJsonObject(wbAttrs);
  const existingList = Array.isArray(existingChars) ? existingChars : [];
  const existingById = new Map();
  for (const c of existingList) {
    const id = Number(c?.id ?? c?.charcID ?? c?.charcId);
    if (Number.isFinite(id) && id > 0) existingById.set(id, c?.value);
  }
  const typeOf = (id) => (charcTypeById instanceof Map ? charcTypeById.get(id) : undefined);

  const result = [];
  const seen = new Set();

  for (const c of existingList) {
    const id = Number(c?.id ?? c?.charcID ?? c?.charcId);
    if (!Number.isFinite(id) || id <= 0 || WB_PACK_DIM_IDS.has(id)) continue;
    seen.add(id);
    const erpHasKey = Object.prototype.hasOwnProperty.call(obj, String(id));
    const erpRaw = erpHasKey ? obj[String(id)] : undefined;
    if (erpHasKey) {
      if (erpRaw != null && String(erpRaw).trim() !== '') {
        const value = coerceWbCharcValue(erpRaw, c?.value, typeOf(id));
        if (value != null && !(Array.isArray(value) && value.length === 0)) {
          result.push({ id, value });
        }
      }
      continue;
    }
    if (c?.value != null && c.value !== '' && !(Array.isArray(c.value) && c.value.length === 0)) {
      result.push({ id, value: c.value });
    }
  }

  for (const [idStr, raw] of Object.entries(obj)) {
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id) || WB_PACK_DIM_IDS.has(id)) continue;
    if (raw == null || String(raw).trim() === '') continue;
    const value = coerceWbCharcValue(raw, existingById.get(id), typeOf(id));
    if (value == null || (Array.isArray(value) && value.length === 0)) continue;
    result.push({ id, value });
    seen.add(id);
  }

  return result;
}

/** ШК из ERP для sizes WB: сначала с бейджем WB, иначе без бейджей, иначе все. */
export function barcodesForWbSizes(product) {
  const rows = normalizeBarcodeRows(product?.barcodes);
  const pick = (list) =>
    list.map((r) => coerceBarcodeString(r.barcode)).filter(Boolean);
  const tagged = rows.filter((r) => (r.marketplaces || []).includes('wb'));
  if (tagged.length) return pick(tagged);
  const untagged = rows.filter((r) => !(r.marketplaces || []).length);
  if (untagged.length) return pick(untagged);
  return pick(rows);
}

/**
 * Подставить ШК из ERP в sizes карточки WB.
 * Одна размерная линейка (запчасти) — список SKU = оставшиеся в ERP.
 * Несколько sizes (одежда) — убираем только те SKU, которых уже нет в ERP.
 */
export function applyErpBarcodesToWbCardSizes(existingSizes, product) {
  if (!Array.isArray(existingSizes) || existingSizes.length === 0) return null;
  const erpCodes = barcodesForWbSizes(product);
  const erpSet = new Set(
    normalizeBarcodeRows(product?.barcodes)
      .map((r) => coerceBarcodeString(r.barcode))
      .filter(Boolean)
  );
  const singleSize = existingSizes.length === 1;

  return existingSizes.map((s) => {
    const skus = (Array.isArray(s?.skus) ? s.skus : []).map((x) => coerceBarcodeString(x)).filter(Boolean);
    let nextSkus;
    if (singleSize) {
      nextSkus = erpCodes.length ? erpCodes : skus;
    } else {
      nextSkus = skus.filter((sku) => erpSet.has(sku));
      if (nextSkus.length === 0) nextSkus = skus;
    }
    return {
      ...(s?.chrtID != null ? { chrtID: s.chrtID } : {}),
      techSize: s?.techSize ?? s?.tech_size ?? '0',
      wbSize: s?.wbSize ?? s?.wb_size ?? '',
      skus: nextSkus,
    };
  });
}
