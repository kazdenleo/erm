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
  const compact = n.replace(/\s+/g, '');
  return (
    /тн\s*вэд/.test(n) ||
    compact.includes('тнвэд') ||
    /tn\s*ved/.test(n) ||
    compact.includes('tnved') ||
    /код\s*тн/.test(n) ||
    /commodity\s*code/.test(n) ||
    /feacn/.test(n) ||
    /hs\s*code/.test(n)
  );
}

/**
 * Подставляет код ТН ВЭД в пустые ERP-значения атрибутов.
 * @param {object|null|undefined} attributeValues
 * @param {Array<string|number>} attrIds
 * @param {string} code
 */
export function fillEmptyErpTnVedAttributeValues(attributeValues, attrIds, code) {
  const digits = normalizeTnVedDigits(code);
  if (!digits || !Array.isArray(attrIds) || attrIds.length === 0) return attributeValues;
  const values =
    attributeValues && typeof attributeValues === 'object' && !Array.isArray(attributeValues)
      ? { ...attributeValues }
      : {};
  let changed = false;
  for (const attrId of attrIds) {
    const key = String(attrId);
    if (!key || key === 'undefined' || key === 'null') continue;
    const cur = values[key] ?? values[attrId];
    if (cur != null && String(cur).trim() !== '') continue;
    values[key] = digits;
    changed = true;
  }
  return changed ? values : attributeValues;
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

/** Ведущие цифры кода ТН ВЭД из текста справочника Ozon («8421310000 – Воздушные фильтры…»). */
export function leadingTnVedDigits(raw) {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{6,14})/);
  return m ? m[1] : '';
}

export function ozonDictEntryTnVedDigits(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const text = String(entry.value ?? entry.name ?? entry.info ?? entry.title ?? '').trim();
  const lead = leadingTnVedDigits(text);
  if (lead) return lead;
  return normalizeTnVedDigits(text);
}

/**
 * Код для поиска в справочнике Ozon: 10-значный ТН ВЭД из сохранённого значения.
 * Уже выбранный dictionary_value_id (не 10 цифр) не трогаем.
 */
export function ozonStoredTnVedSearchCode(raw, categoryCode) {
  const fallback = normalizeTnVedDigits(categoryCode);
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const did = Number(raw.dictionary_value_id ?? raw.id);
    const didStr = Number.isFinite(did) && did > 0 ? String(did) : '';
    if (didStr && didStr.length !== 10) return '';
    const text = String(raw.value ?? '').trim();
    const fromText = leadingTnVedDigits(text) || normalizeTnVedDigits(text);
    if (fromText.length === 10) return fromText;
    if (didStr.length === 10) return didStr;
    return fallback;
  }
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!s) return fallback;
  if (/^\d{10}$/.test(s)) return s;
  const lead = leadingTnVedDigits(s);
  if (lead.length === 10) return lead;
  const compact = normalizeTnVedDigits(s);
  if (compact.length === 10) return compact;
  return '';
}

/**
 * Элемент справочника Ozon, у которого значение начинается с нужного кода ТН ВЭД.
 * Справочник разный у разных type_id — не хардкодим подпись.
 */
export function matchOzonTnVedDictEntry(entries, code) {
  const digits = normalizeTnVedDigits(code);
  if (!digits || !Array.isArray(entries) || entries.length === 0) return null;
  const hits = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const text = String(entry.value ?? entry.name ?? entry.info ?? '').trim();
    const lead = leadingTnVedDigits(text);
    const compact = normalizeTnVedDigits(text);
    const startsWithCode =
      text.startsWith(digits) && (text.length === digits.length || !/\d/.test(text.charAt(digits.length)));
    if (lead === digits || compact === digits || startsWithCode) hits.push(entry);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.value ?? b.name ?? '').length - String(a.value ?? a.name ?? '').length);
  return hits[0];
}

export function ozonTnVedApiValuesFromDictEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = Number(entry.id ?? entry.value_id ?? entry.dictionary_value_id);
  const text = String(entry.value ?? entry.name ?? '').trim();
  if (Number.isFinite(id) && id > 0) {
    const v = { dictionary_value_id: id };
    if (text) v.value = text;
    return [v];
  }
  if (text) return [{ value: text }];
  return null;
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
