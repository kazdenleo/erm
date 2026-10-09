/**
 * Код ОКПД2 товара: нормализация и сопоставление с характеристиками маркетплейсов.
 * Формат ОКПД2: XX, XX.X, XX.XX, XX.XX.X, XX.XX.XX, XX.XX.XX.X … XX.XX.XX.XXX.
 */

import { mpAttrKey, mpAttrName } from './tnVedAttribute.js';

export const OKPD2_FORMAT_HINT = 'ОКПД2 — от 2 до 9 цифр в формате 26.20.11.110';

/** Каноническая запись кода или '' (пусто), null — некорректный ввод. */
export function normalizeOkpd2Code(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^[\d.\s]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 2 || digits.length > 9) return null;
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6), digits.slice(6, 9)];
  return parts.filter(Boolean).join('.');
}

export function isOkpd2AttributeName(name) {
  const compact = String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return compact.includes('окпд') || compact.includes('okpd');
}

export function collectOkpd2MpKeys(attributes, marketplace) {
  const keys = [];
  const seen = new Set();
  for (const attr of Array.isArray(attributes) ? attributes : []) {
    if (!isOkpd2AttributeName(mpAttrName(attr, marketplace))) continue;
    const key = mpAttrKey(attr, marketplace);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function storedOkpd2ValueForMarketplace(marketplace, code) {
  if (!code) return null;
  return marketplace === 'ozon' ? { value: code } : code;
}

/** Код ОКПД2 из сохранённого значения характеристики МП (строка, массив, { value }). */
export function okpd2FromMpStoredValue(raw) {
  let v = raw;
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v.value ?? v.values;
  if (Array.isArray(v)) v = v[0];
  const code = normalizeOkpd2Code(v);
  return code || '';
}
