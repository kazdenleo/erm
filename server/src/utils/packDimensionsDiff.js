/**
 * Расхождение габаритов упаковки: «Основное» ERP ↔ значения, пришедшие с маркетплейса.
 * Пустой МП не считаем расхождением. Пустой ERP — тоже нет (размеры ещё не заданы у нас).
 * WB/YM сравниваем в см: 55 мм и 60 мм это одно и то же (6 см).
 */

import { mmToCm, ymWeightDimensionsToErp } from './productMpFieldLinks.js';
import { WB_PACK_DIM_CHARC } from './marketplaceDimensions.js';

const DIM_KEYS = ['length', 'width', 'height', 'weight'];

function parseObj(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return {};
}

function dimNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    return dimNum(v.value ?? v.name ?? v.text ?? null);
  }
  const n = Number(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function pickDims(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const k of DIM_KEYS) {
    const n = dimNum(src[k]);
    if (n != null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

function dimLenForCompare(v, mp) {
  const n = dimNum(v);
  if (n == null) return null;
  const code = String(mp || '').toLowerCase();
  if (code === 'ym' || code === 'wb') return mmToCm(n);
  return n;
}

function wbPackFromAttributes(rawAttrs) {
  const attrs = parseObj(rawAttrs);
  const lengthCm = dimNum(attrs[WB_PACK_DIM_CHARC.length]);
  const widthCm = dimNum(attrs[WB_PACK_DIM_CHARC.width]);
  const heightCm = dimNum(attrs[WB_PACK_DIM_CHARC.height]);
  if (lengthCm == null && widthCm == null && heightCm == null) return null;
  const out = {};
  if (lengthCm != null) out.length = Math.round(lengthCm * 10);
  if (widthCm != null) out.width = Math.round(widthCm * 10);
  if (heightCm != null) out.height = Math.round(heightCm * 10);
  return out;
}

/** Габариты упаковки с карточки МП (мм / г), без подстановки ERP. */
export function getMarketplacePackDimsMm(product, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  if (mp === 'ym') {
    const draft = parseObj(product?.ym_draft);
    const fromWd = ymWeightDimensionsToErp(draft.weightDimensions);
    if (fromWd) return fromWd;
    return pickDims(draft.dimensions);
  }
  if (mp === 'ozon') {
    const draft = parseObj(product?.ozon_draft);
    return pickDims(draft.dimensions);
  }
  if (mp === 'wb') {
    const draft = parseObj(product?.wb_draft);
    const fromDraft = pickDims(draft.dimensions);
    if (fromDraft) return fromDraft;
    return wbPackFromAttributes(product?.wb_attributes);
  }
  return null;
}

export function getErpPackDimsMm(product) {
  return pickDims({
    length: product?.length,
    width: product?.width,
    height: product?.height,
    weight: product?.weight,
  });
}

export function packDimensionsDiffer(erpDims, mpDims, marketplace) {
  if (!erpDims || !mpDims) return false;
  for (const k of DIM_KEYS) {
    const aRaw = dimNum(erpDims[k]);
    const bRaw = dimNum(mpDims[k]);
    if (aRaw == null || bRaw == null) continue;
    const a = k === 'weight' ? aRaw : dimLenForCompare(erpDims[k], marketplace);
    const b = k === 'weight' ? bRaw : dimLenForCompare(mpDims[k], marketplace);
    if (a !== b) return true;
  }
  return false;
}

function fmtPart(n) {
  const x = dimNum(n);
  return x == null ? '—' : String(x);
}

export function formatPackDimsMm(d) {
  if (!d) return '—';
  return `${fmtPart(d.length)}×${fmtPart(d.width)}×${fmtPart(d.height)} мм, ${fmtPart(d.weight)} г`;
}

export function describePackDimensionMismatch(product, marketplace) {
  const erp = getErpPackDimsMm(product);
  const mp = getMarketplacePackDimsMm(product, marketplace);
  if (!packDimensionsDiffer(erp, mp, marketplace)) return null;
  return {
    erpText: formatPackDimsMm(erp),
    mpText: formatPackDimsMm(mp),
    erp,
    mp,
  };
}
