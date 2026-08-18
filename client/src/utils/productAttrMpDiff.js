/**
 * Сравнение значений «Основное» ↔ атрибуты/поля МП (по нормализованному имени).
 */

import {
  getMpDraftCountry,
  getMpDraftDimensionsMm,
  getYmDraftCountry,
} from './productMpFieldLinks.js';

const MP_SHORT = { ozon: 'OZ', wb: 'WB', ym: 'ЯМ' };
const MP_TITLE = { ozon: 'Ozon', wb: 'Wildberries', ym: 'Яндекс.Маркет' };

export function normalizeAttrCompareName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAttrCompareValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** МП пустой — не считаем расхождением (ещё не заполнено). */
export function attrValuesDiffer(mainVal, mpVal) {
  const a = normalizeAttrCompareValue(mainVal);
  const b = normalizeAttrCompareValue(mpVal);
  if (b === '') return false;
  return a !== b;
}

function putByName(map, name, mp, displayValue) {
  const key = normalizeAttrCompareName(name);
  if (!key) return;
  const text = displayValue == null ? '' : String(displayValue).trim();
  if (text === '') return;
  const prev = map.get(key) || {};
  map.set(key, { ...prev, [mp]: text });
}

/**
 * Карта нормализованное_имя → { ozon?, wb?, ym? } (отображаемые строки).
 */
export function buildMpAttrDisplayByName({
  ozonAttributes = [],
  ozonAttributeValues = {},
  resolveOzonDisplay,
  wbAttributes = [],
  wbAttributeValues = {},
  wbAttrKey,
  wbAttrName,
  ymAttributes = [],
  ymAttributeValues = {},
  resolveYmDisplay,
} = {}) {
  const map = new Map();

  for (const attr of ozonAttributes || []) {
    const id = attr?.id;
    if (id == null) continue;
    const raw = ozonAttributeValues[String(id)];
    const display =
      typeof resolveOzonDisplay === 'function'
        ? resolveOzonDisplay(attr, raw)
        : raw == null
          ? ''
          : String(raw);
    putByName(map, attr.name, 'ozon', display);
  }

  for (const attr of wbAttributes || []) {
    const key = typeof wbAttrKey === 'function' ? wbAttrKey(attr) : String(attr?.id ?? '');
    const name = typeof wbAttrName === 'function' ? wbAttrName(attr) : attr?.name;
    const raw = wbAttributeValues[key];
    putByName(map, name, 'wb', raw == null ? '' : String(raw));
  }

  for (const attr of ymAttributes || []) {
    const id = attr?.id;
    if (id == null) continue;
    const raw = ymAttributeValues[String(id)];
    const display =
      typeof resolveYmDisplay === 'function'
        ? resolveYmDisplay(attr, raw)
        : raw == null
          ? ''
          : String(raw);
    putByName(map, attr.name, 'ym', display);
  }

  return map;
}

/**
 * @returns {{ mp: 'ozon'|'wb'|'ym', label: string, title: string, value: string }[]}
 */
export function getMainAttrMpDiffs(attrName, mainValue, byNameMap) {
  if (!byNameMap) return [];
  const entry = byNameMap.get(normalizeAttrCompareName(attrName));
  if (!entry) return [];
  const out = [];
  for (const mp of ['ozon', 'wb', 'ym']) {
    const mpVal = entry[mp];
    if (mpVal == null || !attrValuesDiffer(mainValue, mpVal)) continue;
    out.push({
      mp,
      label: MP_SHORT[mp],
      title: `${MP_TITLE[mp]}: «${mpVal}» (в Основном: «${String(mainValue ?? '').trim() || '—'}»)`,
      value: mpVal,
    });
  }
  return out;
}

function fmtDimPart(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return '—';
  return String(Math.round(x));
}

function formatDimsMm(d) {
  if (!d || typeof d !== 'object') return '';
  const L = fmtDimPart(d.length);
  const W = fmtDimPart(d.width);
  const H = fmtDimPart(d.height);
  const Wt = fmtDimPart(d.weight);
  if (L === '—' && W === '—' && H === '—' && Wt === '—') return '';
  return `${L}×${W}×${H} мм, ${Wt} г`;
}

function dimNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Габариты/вес упаковки отличаются (мм / г). Пустой МП — не расхождение. */
export function dimensionsDiffer(mainDims, mpDims) {
  if (!mpDims || typeof mpDims !== 'object') return false;
  const keys = ['length', 'width', 'height', 'weight'];
  const mpHasAny = keys.some((k) => dimNum(mpDims[k]) != null);
  if (!mpHasAny) return false;
  for (const k of keys) {
    const a = dimNum(mainDims?.[k]);
    const b = dimNum(mpDims[k]);
    if (b == null) continue;
    if (a !== b) return true;
  }
  return false;
}

/**
 * Расхождения dedicated-полей карточки (название, бренд, описание, страна, артикул, габариты).
 * @returns {Record<string, { mp: string, label: string, title: string, value: string }[]>}
 */
export function getMainCardFieldMpDiffs(formData = {}, extra = {}) {
  const mainName = formData.name;
  const mainBrand = formData.brand;
  const mainDesc = formData.description;
  const mainSku = formData.sku;
  const mainCountry = formData.country_of_origin;
  const mainDims = {
    length: formData.length,
    width: formData.width,
    height: formData.height,
    weight: formData.weight,
  };

  const pairs = {
    name: [
      ['ozon', extra.ozonName ?? ''],
      ['wb', formData.mp_wb_name],
      ['ym', formData.mp_ym_name],
    ],
    brand: [
      ['ozon', extra.ozonBrand ?? ''],
      ['wb', formData.mp_wb_brand],
    ],
    description: [
      ['ozon', extra.ozonDescription ?? ''],
      ['wb', formData.mp_wb_description],
      ['ym', formData.mp_ym_description],
    ],
    sku: [
      ['ozon', formData.sku_ozon],
      ['wb', formData.mp_wb_vendor_code],
      ['ym', formData.sku_ym],
    ],
    // Без связи страна МП лежит в draft (WB/YM) или в атрибуте Ozon «Страна-изготовитель».
    country: [
      ['ozon', extra.ozonManufacturerCountry ?? ''],
      ['wb', getMpDraftCountry(formData, 'wb')],
      ['ym', getYmDraftCountry(formData)],
    ],
  };
  const mainByField = {
    name: mainName,
    brand: mainBrand,
    description: mainDesc,
    sku: mainSku,
    country: mainCountry,
  };

  const out = {};
  for (const [field, list] of Object.entries(pairs)) {
    const mainVal = mainByField[field];
    const diffs = [];
    for (const [mp, mpVal] of list) {
      if (!attrValuesDiffer(mainVal, mpVal)) continue;
      const text = String(mpVal ?? '').trim();
      diffs.push({
        mp,
        label: MP_SHORT[mp],
        title: `${MP_TITLE[mp]}: «${text}» (в Основном: «${String(mainVal ?? '').trim() || '—'}»)`,
        value: text,
      });
    }
    out[field] = diffs;
  }

  const dimDiffs = [];
  const mainDimText = formatDimsMm(mainDims) || '—';
  for (const mp of ['ozon', 'wb', 'ym']) {
    const mpDims = getMpDraftDimensionsMm(formData, mp);
    if (!dimensionsDiffer(mainDims, mpDims)) continue;
    const text = formatDimsMm(mpDims);
    dimDiffs.push({
      mp,
      label: MP_SHORT[mp],
      title: `${MP_TITLE[mp]}: ${text || '—'} (в Основном: ${mainDimText})`,
      value: text,
    });
  }
  out.dimensions = dimDiffs;

  return out;
}
