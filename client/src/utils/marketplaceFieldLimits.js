/**
 * Настраиваемые лимиты длины полей карточки по маркетплейсам.
 * Хранятся в config.field_limits кабинета организации.
 */

import { isMpFieldLinked, normalizeMpFieldLinks } from './productMpFieldLinks.js';
import { findOzonBrandAttrs, isOzonBrandAttr } from './ozonBrandAttr.js';
import {
  findOzonAnnotationAttrs,
  findOzonNameAttrs,
  isOzonAnnotationAttr,
  isOzonNameAttr,
  ozonAttrPlainText,
} from './ozonCardTextAttrs.js';

export const MP_FIELD_LIMIT_MP_LABELS = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  ym: 'Яндекс.Маркет',
};

export const MP_CABINET_TYPE_TO_CODE = {
  ozon: 'ozon',
  wildberries: 'wb',
  yandex: 'ym',
};

export const MP_LIMITABLE_FIELDS = {
  ozon: [
    { key: 'name', label: 'Название' },
    { key: 'description', label: 'Описание (аннотация)' },
    { key: 'brand', label: 'Бренд' },
  ],
  wildberries: [
    { key: 'name', label: 'Название' },
    { key: 'description', label: 'Описание' },
    { key: 'brand', label: 'Бренд' },
    { key: 'vendor_code', label: 'Артикул продавца' },
  ],
  yandex: [
    { key: 'name', label: 'Название' },
    { key: 'description', label: 'Описание' },
  ],
};

const EMPTY_LIMITS = { ozon: [], wb: [], ym: [] };

export function parseCabinetConfig(config) {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
}

export function normalizeFieldLimits(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const field = String(item?.field || item?.key || '').trim();
    const max = Number(item?.max_length ?? item?.maxLength);
    if (!field || !Number.isFinite(max) || max <= 0) continue;
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ field, max_length: Math.floor(max) });
  }
  return out;
}

export function collectFieldLimitsByMp(cabinets) {
  const result = { ozon: [], wb: [], ym: [] };
  for (const cab of cabinets || []) {
    const mp = MP_CABINET_TYPE_TO_CODE[cab?.marketplace_type];
    if (!mp) continue;
    const cfg = parseCabinetConfig(cab.config);
    const rules = normalizeFieldLimits(cfg.field_limits);
    if (!rules.length) continue;
    if (!result[mp].length) {
      result[mp] = rules;
      continue;
    }
    const map = new Map(result[mp].map((r) => [r.field, r.max_length]));
    for (const r of rules) {
      const prev = map.get(r.field);
      if (prev == null || r.max_length < prev) map.set(r.field, r.max_length);
    }
    result[mp] = [...map.entries()].map(([field, max_length]) => ({ field, max_length }));
  }
  return result;
}

export function emptyFieldLimitsByMp() {
  return { ozon: [], wb: [], ym: [] };
}

export function fieldLimitLabel(cabinetTypeOrMp, fieldKey) {
  const catalog =
    MP_LIMITABLE_FIELDS[cabinetTypeOrMp] ||
    MP_LIMITABLE_FIELDS[
      cabinetTypeOrMp === 'wb' ? 'wildberries' : cabinetTypeOrMp === 'ym' ? 'yandex' : cabinetTypeOrMp
    ] ||
    [];
  return catalog.find((f) => f.key === fieldKey)?.label || fieldKey;
}

export function findFieldLimit(limitsByMp, mp, field) {
  const rules = limitsByMp?.[mp] || [];
  return rules.find((r) => r.field === field) || null;
}

export function textCharLength(value) {
  return String(value ?? '').length;
}

function linkFieldForLimit(field) {
  if (field === 'vendor_code') return 'sku';
  return field;
}

function pushViolation(list, { sku, productId, mp, field, value, maxLength }) {
  const length = textCharLength(value);
  if (!maxLength || length <= maxLength) return;
  list.push({
    sku: sku || '',
    productId: productId || null,
    mp,
    mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp] || mp,
    field,
    fieldLabel: fieldLimitLabel(mp, field),
    length,
    maxLength,
  });
}

function ozonAttrText(ozonAttributes, ozonAttributeValues, finder) {
  const attr = finder(ozonAttributes || [])[0];
  if (!attr) return '';
  return ozonAttrPlainText(ozonAttributeValues?.[String(attr.id)] ?? ozonAttributeValues?.[attr.id]);
}

function resolveFormMpText({ formData, mp, field, ozonAttributes, ozonAttributeValues }) {
  const links = normalizeMpFieldLinks(formData?.mp_field_links);
  const linked = isMpFieldLinked(links, linkFieldForLimit(field), mp);
  if (field === 'name') {
    if (mp === 'wb') return String(formData?.mp_wb_name || (linked ? formData?.name : '') || '');
    if (mp === 'ym') return String(formData?.mp_ym_name || (linked ? formData?.name : '') || '');
    const fromAttr = ozonAttrText(ozonAttributes, ozonAttributeValues, findOzonNameAttrs);
    if (fromAttr) return fromAttr;
    return String(formData?.mp_ozon_name || (linked ? formData?.name : '') || '');
  }
  if (field === 'description') {
    if (mp === 'wb') return String(formData?.mp_wb_description || (linked ? formData?.description : '') || '');
    if (mp === 'ym') return String(formData?.mp_ym_description || (linked ? formData?.description : '') || '');
    const fromAttr = ozonAttrText(ozonAttributes, ozonAttributeValues, findOzonAnnotationAttrs);
    if (fromAttr) return fromAttr;
    return String(formData?.mp_ozon_description || (linked ? formData?.description : '') || '');
  }
  if (field === 'brand') {
    if (mp === 'wb') return String(formData?.mp_wb_brand || (linked ? formData?.brand : '') || '');
    if (mp === 'ym') return linked ? String(formData?.brand || '') : '';
    const fromAttr = ozonAttrText(ozonAttributes, ozonAttributeValues, findOzonBrandAttrs);
    if (fromAttr) return fromAttr;
    return String(formData?.mp_ozon_brand || (linked ? formData?.brand : '') || '');
  }
  if (field === 'vendor_code' && mp === 'wb') {
    return String(formData?.mp_wb_vendor_code || (linked ? formData?.sku : '') || '');
  }
  return '';
}

export function collectProductFormLimitViolations({
  formData,
  ozonAttributes,
  ozonAttributeValues,
  limitsByMp,
  marketplaces,
} = {}) {
  const mps = Array.isArray(marketplaces) && marketplaces.length
    ? marketplaces.filter((m) => m === 'ozon' || m === 'wb' || m === 'ym')
    : ['ozon', 'wb', 'ym'];
  const violations = [];
  for (const mp of mps) {
    const rules = limitsByMp?.[mp] || [];
    for (const rule of rules) {
      const value = resolveFormMpText({
        formData,
        mp,
        field: rule.field,
        ozonAttributes,
        ozonAttributeValues,
      });
      pushViolation(violations, {
        sku: formData?.sku,
        productId: formData?.id,
        mp,
        field: rule.field,
        value,
        maxLength: rule.max_length,
      });
    }
  }
  return violations;
}

/** Самый строгий лимит среди связанных МП для поля «Основное». */
export function strictestLinkedMainLimit(limitsByMp, field, links) {
  const linkKey = linkFieldForLimit(field);
  let best = null;
  for (const mp of ['ozon', 'wb', 'ym']) {
    if (!isMpFieldLinked(links, linkKey, mp)) continue;
    const rule = findFieldLimit(limitsByMp, mp, field);
    if (!rule) continue;
    if (!best || rule.max_length < best.maxLength) {
      best = { mp, field, maxLength: rule.max_length, mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp] };
    }
  }
  return best;
}

export function formControlLimitHit(limitsByMp, formData, controlKey, extras = {}) {
  const links = normalizeMpFieldLinks(formData?.mp_field_links);
  const { ozonAttributes, ozonAttributeValues } = extras;

  const dedicated = {
    mp_wb_name: { mp: 'wb', field: 'name', value: formData?.mp_wb_name },
    mp_wb_description: { mp: 'wb', field: 'description', value: formData?.mp_wb_description },
    mp_wb_brand: { mp: 'wb', field: 'brand', value: formData?.mp_wb_brand },
    mp_wb_vendor_code: { mp: 'wb', field: 'vendor_code', value: formData?.mp_wb_vendor_code },
    mp_ym_name: { mp: 'ym', field: 'name', value: formData?.mp_ym_name },
    mp_ym_description: { mp: 'ym', field: 'description', value: formData?.mp_ym_description },
    mp_ozon_name: { mp: 'ozon', field: 'name', value: formData?.mp_ozon_name },
    mp_ozon_description: { mp: 'ozon', field: 'description', value: formData?.mp_ozon_description },
    mp_ozon_brand: { mp: 'ozon', field: 'brand', value: formData?.mp_ozon_brand },
  };

  if (dedicated[controlKey]) {
    const { mp, field, value } = dedicated[controlKey];
    const rule = findFieldLimit(limitsByMp, mp, field);
    if (!rule) return null;
    const length = textCharLength(value);
    if (length <= rule.max_length) return null;
    return { mp, field, length, maxLength: rule.max_length, mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp] };
  }

  if (controlKey === 'name' || controlKey === 'description' || controlKey === 'brand') {
    const linked = strictestLinkedMainLimit(limitsByMp, controlKey, links);
    if (!linked) return null;
    const length = textCharLength(formData?.[controlKey]);
    if (length <= linked.maxLength) return null;
    return { ...linked, length };
  }

  if (controlKey === 'sku') {
    const linked = strictestLinkedMainLimit(limitsByMp, 'vendor_code', links);
    if (!linked) return null;
    const length = textCharLength(formData?.sku);
    if (length <= linked.maxLength) return null;
    return { ...linked, length };
  }

  if (controlKey?.startsWith('ozon-attr:')) {
    const attrId = controlKey.slice('ozon-attr:'.length);
    const attr = (ozonAttributes || []).find((a) => String(a.id) === String(attrId));
    if (!attr) return null;
    let field = null;
    if (isOzonNameAttr(attr)) field = 'name';
    else if (isOzonAnnotationAttr(attr)) field = 'description';
    else if (isOzonBrandAttr(attr)) field = 'brand';
    if (!field) return null;
    const rule = findFieldLimit(limitsByMp, 'ozon', field);
    if (!rule) return null;
    const value = ozonAttrPlainText(ozonAttributeValues?.[String(attrId)] ?? ozonAttributeValues?.[attrId]);
    const length = textCharLength(value);
    if (length <= rule.max_length) return null;
    return { mp: 'ozon', field, length, maxLength: rule.max_length, mpLabel: MP_FIELD_LIMIT_MP_LABELS.ozon };
  }

  return null;
}

export function limitClassName(base, hit) {
  if (!hit) return base;
  return `${base} mp-field-over-limit`.trim();
}

function stringifyBulkAttr(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if (v.dictionary_value_id != null || v.value != null) {
      const text = v.value != null && String(v.value).trim() !== '' ? String(v.value).trim() : '';
      const did = v.dictionary_value_id != null ? String(v.dictionary_value_id).trim() : '';
      if (text) return text;
      return did;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function bulkOzonAttrValue(row, mpAttrColumnDefs, predicate) {
  const cols = mpAttrColumnDefs || [];
  for (const col of cols) {
    if (col?.mpAttr?.bucket !== 'ozon') continue;
    const attr = { id: col.mpAttr.attrId, name: col._humanName || col.label };
    if (!predicate(attr)) continue;
    return stringifyBulkAttr(row?.[col.key]);
  }
  return '';
}

function resolveBulkMpText(row, mp, field, mpAttrColumnDefs) {
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  const linked = isMpFieldLinked(links, linkFieldForLimit(field), mp);
  if (field === 'name') {
    if (mp === 'wb') return String(row?.mp_wb_name || (linked ? row?.name : '') || '');
    if (mp === 'ym') return String(row?.mp_ym_name || (linked ? row?.name : '') || '');
    const fromAttr = bulkOzonAttrValue(row, mpAttrColumnDefs, isOzonNameAttr);
    if (fromAttr) return fromAttr;
    return String(row?.mp_ozon_name || (linked ? row?.name : '') || '');
  }
  if (field === 'description') {
    if (mp === 'wb') return String(row?.mp_wb_description || (linked ? row?.description : '') || '');
    if (mp === 'ym') return String(row?.mp_ym_description || (linked ? row?.description : '') || '');
    const fromAttr = bulkOzonAttrValue(row, mpAttrColumnDefs, isOzonAnnotationAttr);
    if (fromAttr) return fromAttr;
    return String(row?.mp_ozon_description || (linked ? row?.description : '') || '');
  }
  if (field === 'brand') {
    if (mp === 'wb') return String(row?.mp_wb_brand || (linked ? row?.brand : '') || '');
    const fromAttr = bulkOzonAttrValue(row, mpAttrColumnDefs, isOzonBrandAttr);
    if (fromAttr) return fromAttr;
    return String(row?.mp_ozon_brand || (linked ? row?.brand : '') || '');
  }
  if (field === 'vendor_code' && mp === 'wb') {
    return String(row?.mp_wb_vendor_code || (linked ? row?.sku : '') || '');
  }
  return '';
}

export function collectBulkRowLimitViolations(row, limitsByMp, { mpAttrColumnDefs } = {}) {
  const violations = [];
  if (!row) return violations;
  for (const mp of ['ozon', 'wb', 'ym']) {
    const rules = limitsByMp?.[mp] || [];
    for (const rule of rules) {
      const value = resolveBulkMpText(row, mp, rule.field, mpAttrColumnDefs);
      pushViolation(violations, {
        sku: row.sku,
        productId: row.id,
        mp,
        field: rule.field,
        value,
        maxLength: rule.max_length,
      });
    }
  }
  return violations;
}

export function bulkCellLimitHit(row, col, limitsByMp, displayedValue) {
  if (!col) return null;
  const k = String(col.key || '');
  const value = displayedValue !== undefined ? displayedValue : row?.[k];
  const links = normalizeMpFieldLinks(row?.mp_field_links);

  const dedicated = {
    mp_wb_name: { mp: 'wb', field: 'name' },
    mp_wb_description: { mp: 'wb', field: 'description' },
    mp_wb_brand: { mp: 'wb', field: 'brand' },
    mp_wb_vendor_code: { mp: 'wb', field: 'vendor_code' },
    mp_ym_name: { mp: 'ym', field: 'name' },
    mp_ym_description: { mp: 'ym', field: 'description' },
    mp_ozon_name: { mp: 'ozon', field: 'name' },
    mp_ozon_description: { mp: 'ozon', field: 'description' },
    mp_ozon_brand: { mp: 'ozon', field: 'brand' },
  };

  if (dedicated[k]) {
    const { mp, field } = dedicated[k];
    const rule = findFieldLimit(limitsByMp, mp, field);
    if (!rule) return null;
    const length = textCharLength(value);
    if (length <= rule.max_length) return null;
    return { mp, field, length, maxLength: rule.max_length, mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp] };
  }

  if (k === 'name' || k === 'description' || k === 'brand') {
    const linked = strictestLinkedMainLimit(limitsByMp, k, links);
    if (!linked) return null;
    const length = textCharLength(value);
    if (length <= linked.maxLength) return null;
    return { ...linked, length };
  }

  if (k === 'sku') {
    const linked = strictestLinkedMainLimit(limitsByMp, 'vendor_code', links);
    if (!linked) return null;
    const length = textCharLength(value);
    if (length <= linked.maxLength) return null;
    return { ...linked, length };
  }

  if (col.mpAttr?.bucket === 'ozon') {
    const attr = { id: col.mpAttr.attrId, name: col._humanName || col.label };
    let field = null;
    if (isOzonNameAttr(attr)) field = 'name';
    else if (isOzonAnnotationAttr(attr)) field = 'description';
    else if (isOzonBrandAttr(attr)) field = 'brand';
    if (!field) return null;
    const rule = findFieldLimit(limitsByMp, 'ozon', field);
    if (!rule) return null;
    const length = textCharLength(value);
    if (length <= rule.max_length) return null;
    return { mp: 'ozon', field, length, maxLength: rule.max_length, mpLabel: MP_FIELD_LIMIT_MP_LABELS.ozon };
  }

  return null;
}

export function formatFieldLimitViolations(violations, { maxItems = 8 } = {}) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return '';
  const lines = list.slice(0, maxItems).map((v) => {
    const sku = v.sku ? `${v.sku} · ` : '';
    return `• ${sku}${v.mpLabel} · ${v.fieldLabel}: ${v.length} из ${v.maxLength} символов`;
  });
  const more = list.length > maxItems ? `\n… и ещё ${list.length - maxItems}` : '';
  return `Превышены лимиты заполнения полей:\n\n${lines.join('\n')}${more}`;
}

export function confirmFieldLimitViolations(violations, actionLabel = 'продолжить') {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return true;
  const text = `${formatFieldLimitViolations(list)}\n\nВсё равно ${actionLabel}?`;
  return window.confirm(text);
}

export function expandPushMarketplaces(marketplaces) {
  if (marketplaces === 'all' || marketplaces == null) return ['ozon', 'wb', 'ym'];
  if (marketplaces === 'ozon' || marketplaces === 'wb' || marketplaces === 'ym') return [marketplaces];
  if (Array.isArray(marketplaces)) {
    return marketplaces.filter((m) => m === 'ozon' || m === 'wb' || m === 'ym');
  }
  return ['ozon', 'wb', 'ym'];
}

export { EMPTY_LIMITS };
