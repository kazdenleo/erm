/**
 * Общие хелперы ДРР для рекламы маркетплейсов.
 * Совместимы с ozonAdsPromotion (реэкспорт нормализации).
 */

import {
  normalizeOzonAdsPercent,
  computeDrrPercent,
  applyOzonAdsPromotion,
} from './ozonAdsPromotion.js';

export const normalizeAdsPercent = normalizeOzonAdsPercent;
export { computeDrrPercent, applyOzonAdsPromotion };

/** Применить ДРР к калькулятору (любой МП). */
export function applyAdsPromotion(calculator, adsPercent, source = 'ads') {
  return applyOzonAdsPromotion(calculator, adsPercent, source);
}

export function adsScopeKey(profileId, organizationId) {
  const p =
    profileId != null && Number.isFinite(Number(profileId)) ? Number(profileId) : 0;
  const o =
    organizationId != null && Number.isFinite(Number(organizationId))
      ? Number(organizationId)
      : 0;
  return `${p}:${o}`;
}

export function normalizeSkuKey(raw) {
  const s = String(raw ?? '').trim();
  return s || null;
}

export function parseMoney(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ADS_MARKETPLACES = ['ozon', 'wildberries', 'yandex'];

export function normalizeMarketplace(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'ozon' || s === 'oz') return 'ozon';
  if (s === 'wildberries' || s === 'wb') return 'wildberries';
  if (s === 'yandex' || s === 'ym' || s === 'yandex_market') return 'yandex';
  return null;
}
