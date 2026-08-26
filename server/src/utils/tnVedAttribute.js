/**
 * Сопоставление кода ТН ВЭД с атрибутами карточки (ERP и маркетплейсы).
 */

import { findTnVedByCode, isKnownTnVedCode } from '../constants/tnVedCodes.js';

export function normalizeTnVedDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

export function normalizeCategoryTnVedCode(raw) {
  if (raw === undefined) return undefined;
  if (raw == null || String(raw).trim() === '') return null;
  const digits = normalizeTnVedDigits(raw);
  if (!digits) return null;
  if (!isKnownTnVedCode(digits)) {
    const err = new Error('Код ТН ВЭД должен быть выбран из справочника');
    err.statusCode = 400;
    throw err;
  }
  return findTnVedByCode(digits)?.code || digits;
}

export function isTnVedAttributeName(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;
  return (
    /тн\s*вэд/.test(n) ||
    /tn\s*ved/.test(n) ||
    /tnved/.test(n) ||
    /код\s*тн/.test(n) ||
    /commodity\s*code/.test(n) ||
    /feacn/.test(n) ||
    /hs\s*code/.test(n)
  );
}

export function isEmptyMpStoredValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return false;
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => isEmptyMpStoredValue(x));
  if (typeof v === 'object') {
    if (Object.keys(v).length === 0) return true;
    const text = v.value ?? v.values;
    if (Array.isArray(text)) return text.length === 0 || text.every((x) => isEmptyMpStoredValue(x));
    if (text != null && String(text).trim() !== '') return false;
    if (v.dictionary_value_id != null && String(v.dictionary_value_id).trim() !== '') return false;
    return true;
  }
  return false;
}

export function mpAttrKey(attr, marketplace) {
  if (!attr || typeof attr !== 'object') return '';
  if (marketplace === 'wb') {
    const id = attr.charcID ?? attr.characteristic_id ?? attr.id ?? attr.attribute_id ?? attr.name;
    return id != null ? String(id) : String(attr.name || '');
  }
  return attr.id != null ? String(attr.id) : '';
}

export function mpAttrName(attr, marketplace) {
  if (!attr || typeof attr !== 'object') return '';
  if (marketplace === 'wb') {
    return String(attr.name ?? attr.charcName ?? attr.characteristic_name ?? '');
  }
  return String(attr.name ?? attr.title ?? '');
}

export function collectTnVedMpKeys(attributes, marketplace) {
  const list = Array.isArray(attributes) ? attributes : [];
  const keys = [];
  const seen = new Set();
  for (const attr of list) {
    if (!isTnVedAttributeName(mpAttrName(attr, marketplace))) continue;
    const key = mpAttrKey(attr, marketplace);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function storedTnVedValueForMarketplace(marketplace, code) {
  const c = normalizeTnVedDigits(code);
  if (!c) return null;
  if (marketplace === 'ozon') return { value: c };
  return c;
}

/**
 * Заполняет пустые ключи в объекте атрибутов. Возвращает тот же объект, если ничего не изменилось.
 */
export function fillEmptyTnVedKeys(attrs, keys, storedValue) {
  if (!storedValue || !Array.isArray(keys) || keys.length === 0) return attrs;
  const src = attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? attrs : {};
  let changed = false;
  const next = { ...src };
  for (const key of keys) {
    if (!key || !isEmptyMpStoredValue(next[key])) continue;
    next[key] = storedValue;
    changed = true;
  }
  return changed ? next : attrs;
}

export function parseMpLinksObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return {};
}

export function mpLinkIds(links, marketplace) {
  const bucket = parseMpLinksObject(links)?.[marketplace];
  const items = Array.isArray(bucket) ? bucket : bucket ? [bucket] : [];
  const ids = [];
  for (const item of items) {
    if (item == null) continue;
    const id = typeof item === 'object' ? item.id : item;
    const s = id != null ? String(id).trim() : '';
    if (s) ids.push(s);
  }
  return ids;
}
