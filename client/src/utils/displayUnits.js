/**
 * Единицы отображения габаритов/веса (настройки аккаунта).
 * В БД / ERP / ozon_draft / wb_draft всегда мм и г.
 * ym_draft.weightDimensions — см/кг (как в API YM).
 * Push на МП — в единицах маркетплейса (без изменений).
 */

import { cmToMm, gramsToKg, kgToGrams, mmToCm } from './productMpFieldLinks.js';

export const LENGTH_UNITS = ['mm', 'cm'];
export const WEIGHT_UNITS = ['g', 'kg'];

export function normalizeLengthUnit(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase() === 'cm'
    ? 'cm'
    : 'mm';
}

export function normalizeWeightUnit(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase() === 'kg'
    ? 'kg'
    : 'g';
}

export function getProfileLengthUnit(profile) {
  return normalizeLengthUnit(profile?.display_length_unit ?? profile?.displayLengthUnit);
}

export function getProfileWeightUnit(profile) {
  return normalizeWeightUnit(profile?.display_weight_unit ?? profile?.displayWeightUnit);
}

export function lengthUnitLabel(unit) {
  return normalizeLengthUnit(unit) === 'cm' ? 'см' : 'мм';
}

export function weightUnitLabel(unit) {
  return normalizeWeightUnit(unit) === 'kg' ? 'кг' : 'г';
}

/** мм → строка для инпута в выбранных единицах (пусто если нет значения). */
export function lengthMmToDisplay(mm, unit) {
  if (mm == null || mm === '') return '';
  const n = Number(String(mm).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (normalizeLengthUnit(unit) === 'cm') {
    const cm = Math.round((n / 10) * 10) / 10;
    return String(cm);
  }
  return String(Math.round(n));
}

/** значение из инпута → мм (number) или null. */
export function lengthDisplayToMm(raw, unit) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (normalizeLengthUnit(unit) === 'cm') {
    return cmToMm(n) ?? Math.max(1, Math.round(n * 10));
  }
  return Math.max(1, Math.round(n));
}

/** г → строка для инпута. */
export function weightGToDisplay(g, unit) {
  if (g == null || g === '') return '';
  const n = Number(String(g).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (normalizeWeightUnit(unit) === 'kg') {
    const kg = gramsToKg(n);
    return kg != null ? String(kg) : '';
  }
  return String(Math.round(n));
}

/** значение из инпута → г (number) или null. */
export function weightDisplayToG(raw, unit) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (normalizeWeightUnit(unit) === 'kg') {
    return kgToGrams(n) ?? Math.max(1, Math.round(n * 1000));
  }
  return Math.max(1, Math.round(n));
}

export function lengthInputStep(unit) {
  return normalizeLengthUnit(unit) === 'cm' ? '0.1' : '1';
}

export function weightInputStep(unit) {
  return normalizeWeightUnit(unit) === 'kg' ? '0.001' : '1';
}

/** см (как в attrs WB) → отображение в настройках аккаунта. */
export function lengthCmToDisplay(cm, unit) {
  if (cm == null || cm === '') return '';
  const n = Number(String(cm).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (normalizeLengthUnit(unit) === 'cm') return String(n);
  const mm = cmToMm(n);
  return mm != null ? String(mm) : '';
}

/** отображение → см для attrs WB. */
export function lengthDisplayToCm(raw, unit) {
  if (raw == null || raw === '') return null;
  if (normalizeLengthUnit(unit) === 'cm') {
    const n = Number(String(raw).replace(',', '.').replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 10) / 10;
  }
  const mm = lengthDisplayToMm(raw, unit);
  return mm != null ? mmToCm(mm) : null;
}
