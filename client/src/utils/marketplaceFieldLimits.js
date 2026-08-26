/**
 * Настраиваемые лимиты полей карточки по маркетплейсам.
 * Хранятся в config.field_limits кабинета организации.
 *
 * Правило: { field, field_label?, kind: 'chars'|'words', max }
 * Старый формат { field, max_length } читается как kind=chars.
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

const WORD_SPLIT_RE = /[;,\s]+/;

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

export function countWords(value) {
  const s = String(value ?? '').trim();
  if (!s) return 0;
  return s.split(WORD_SPLIT_RE).filter((part) => part.length > 0).length;
}

export function textCharLength(value) {
  return String(value ?? '').length;
}

export function measureLimitValue(value, kind) {
  return kind === 'words' ? countWords(value) : textCharLength(value);
}

export function limitUnitLabel(kind) {
  return kind === 'words' ? 'слов' : 'символов';
}

function parseLimitKind(item) {
  const raw = String(item?.kind || item?.unit || '').trim().toLowerCase();
  if (raw === 'words' || raw === 'word' || raw === 'слова' || raw === 'слов') return 'words';
  if (raw === 'chars' || raw === 'char' || raw === 'characters' || raw === 'символы' || raw === 'символов') {
    return 'chars';
  }
  if (item?.max_words != null && item?.max_length == null && item?.maxLength == null && item?.max == null) {
    return 'words';
  }
  return 'chars';
}

function parseLimitMax(item, kind) {
  if (kind === 'words') {
    const n = Number(item?.max ?? item?.max_words ?? item?.maxWords);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const n = Number(item?.max ?? item?.max_length ?? item?.maxLength);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function normalizeFieldLimits(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const field = String(item?.field || item?.key || '').trim();
    if (!field) continue;
    const fieldLabel = String(item?.field_label || item?.fieldLabel || item?.label || '').trim();

    const hasLegacyBoth =
      !item?.kind &&
      Number(item?.max_length ?? item?.maxLength) > 0 &&
      Number(item?.max_words ?? item?.maxWords) > 0;

    const kinds = hasLegacyBoth ? ['chars', 'words'] : [parseLimitKind(item)];
    for (const kind of kinds) {
      const max = hasLegacyBoth
        ? kind === 'words'
          ? Math.floor(Number(item.max_words ?? item.maxWords))
          : Math.floor(Number(item.max_length ?? item.maxLength))
        : parseLimitMax(item, kind);
      if (!max) continue;
      const dedupe = `${field}::${kind}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        field,
        field_label: fieldLabel,
        kind,
        max,
      });
    }
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
    const map = new Map(result[mp].map((r) => [`${r.field}::${r.kind}`, r]));
    for (const r of rules) {
      const k = `${r.field}::${r.kind}`;
      const prev = map.get(k);
      if (!prev || r.max < prev.max) {
        map.set(k, {
          ...r,
          field_label: r.field_label || prev?.field_label || '',
        });
      }
    }
    result[mp] = [...map.values()];
  }
  return result;
}

export function emptyFieldLimitsByMp() {
  return { ozon: [], wb: [], ym: [] };
}

export function parseLimitFieldKey(field) {
  const raw = String(field || '').trim();
  const m = raw.match(/^(erp|ozon|wb|ym):(.+)$/i);
  if (m) {
    return { type: 'attr', bucket: m[1].toLowerCase(), id: m[2] };
  }
  return { type: 'dedicated', field: raw };
}

export function fieldLimitLabel(cabinetTypeOrMp, fieldKey, fallbackLabel = '') {
  if (fallbackLabel) return fallbackLabel;
  const catalog =
    MP_LIMITABLE_FIELDS[cabinetTypeOrMp] ||
    MP_LIMITABLE_FIELDS[
      cabinetTypeOrMp === 'wb' ? 'wildberries' : cabinetTypeOrMp === 'ym' ? 'yandex' : cabinetTypeOrMp
    ] ||
    [];
  const found = catalog.find((f) => f.key === fieldKey);
  if (found) return found.label;
  const parsed = parseLimitFieldKey(fieldKey);
  if (parsed.type === 'attr') {
    const prefix =
      parsed.bucket === 'erp' ? 'ERP' : MP_FIELD_LIMIT_MP_LABELS[parsed.bucket] || parsed.bucket;
    return `${prefix} · ${parsed.id}`;
  }
  return fieldKey;
}

export function findFieldLimit(limitsByMp, mp, field) {
  const rules = limitsByMp?.[mp] || [];
  const chars = rules.find((r) => r.field === field && r.kind !== 'words');
  if (chars) return { ...chars, max_length: chars.max };
  const any = rules.find((r) => r.field === field);
  return any ? { ...any, max_length: any.kind === 'chars' ? any.max : undefined } : null;
}

export function findRulesForField(limitsByMp, mp, field) {
  return (limitsByMp?.[mp] || []).filter((r) => r.field === field);
}

export function evaluateLimitRule(rule, value, mp) {
  const kind = rule?.kind === 'words' ? 'words' : 'chars';
  const max = Number(rule?.max);
  const length = measureLimitValue(value, kind);
  return {
    field: rule?.field,
    fieldLabel: rule?.field_label || fieldLimitLabel(mp, rule?.field),
    kind,
    max,
    length,
    over: Number.isFinite(max) && max > 0 && length > max,
    unitLabel: limitUnitLabel(kind),
    mp,
    mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp] || mp,
  };
}

function linkFieldForLimit(field) {
  if (field === 'vendor_code') return 'sku';
  return field;
}

function stringifyAttrValue(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((item) => stringifyAttrValue(item))
      .filter(Boolean)
      .join('; ');
  }
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

function normalizeAttrName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function ozonAttrText(ozonAttributes, ozonAttributeValues, finder) {
  const attr = finder(ozonAttributes || [])[0];
  if (!attr) return '';
  return ozonAttrPlainText(ozonAttributeValues?.[String(attr.id)] ?? ozonAttributeValues?.[attr.id]);
}

function valueFromAttrMap(values, id) {
  if (!values || id == null) return '';
  const key = String(id);
  if (values[key] !== undefined) return stringifyAttrValue(values[key]);
  if (values[id] !== undefined) return stringifyAttrValue(values[id]);
  return '';
}

function valueByAttrName(attrs, values, getId, getName, label) {
  const want = normalizeAttrName(label);
  if (!want) return '';
  for (const attr of attrs || []) {
    if (normalizeAttrName(getName(attr)) !== want) continue;
    const id = getId(attr);
    const text = valueFromAttrMap(values, id);
    if (text) return text;
  }
  return '';
}


function attrNameFromExtras(bucket, id, extras) {
  const list =
    bucket === 'erp'
      ? extras?.erpAttributes
      : bucket === 'ozon'
        ? extras?.ozonAttributes
        : bucket === 'wb'
          ? extras?.wbAttributes
          : extras?.ymAttributes;
  for (const attr of list || []) {
    const aid =
      bucket === 'wb'
        ? attr?.charcID ?? attr?.characteristic_id ?? attr?.id ?? attr?.attribute_id
        : attr?.id;
    if (String(aid) !== String(id)) continue;
    return bucket === 'wb'
      ? attr?.name ?? attr?.charcName ?? attr?.characteristic_name
      : attr?.name;
  }
  return '';
}

function ruleMatchesAlias(rule, alias, extras, col) {
  if (!rule?.field || !alias?.field) return false;
  if (rule.field === alias.field) return true;
  const parsedRule = parseLimitFieldKey(rule.field);
  const parsedAlias = parseLimitFieldKey(alias.field);
  if (parsedRule.type !== 'attr' || parsedAlias.type !== 'attr') return false;
  if (parsedRule.bucket !== parsedAlias.bucket) return false;
  const want = normalizeAttrName(rule.field_label);
  if (!want) return false;
  if (col) {
    const colName = normalizeAttrName(col._humanName || col.label);
    if (colName && colName === want) return true;
  }
  const aliasName = attrNameFromExtras(parsedAlias.bucket, parsedAlias.id, extras || {});
  return Boolean(aliasName) && normalizeAttrName(aliasName) === want;
}

function resolveFormMpText({
  formData,
  mp,
  field,
  fieldLabel,
  ozonAttributes,
  ozonAttributeValues,
  wbAttributes,
  wbAttributeValues,
  ymAttributes,
  ymAttributeValues,
  erpAttributes,
}) {
  const parsed = parseLimitFieldKey(field);
  if (parsed.type === 'attr') {
    if (parsed.bucket === 'erp') {
      const fromId = valueFromAttrMap(formData?.attributeValues, parsed.id);
      if (fromId) return fromId;
      return valueByAttrName(
        erpAttributes,
        formData?.attributeValues,
        (a) => a?.id,
        (a) => a?.name,
        fieldLabel
      );
    }
    if (parsed.bucket === 'ozon') {
      const fromId = ozonAttrPlainText(
        ozonAttributeValues?.[parsed.id] ?? ozonAttributeValues?.[String(parsed.id)]
      );
      if (fromId) return fromId;
      return valueByAttrName(
        ozonAttributes,
        ozonAttributeValues,
        (a) => a?.id,
        (a) => a?.name,
        fieldLabel
      );
    }
    if (parsed.bucket === 'wb') {
      const fromId = valueFromAttrMap(wbAttributeValues, parsed.id);
      if (fromId) return fromId;
      return valueByAttrName(
        wbAttributes,
        wbAttributeValues,
        (a) => a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name,
        (a) => a?.name ?? a?.charcName ?? a?.characteristic_name,
        fieldLabel
      );
    }
    if (parsed.bucket === 'ym') {
      const fromId = valueFromAttrMap(ymAttributeValues, parsed.id);
      if (fromId) return fromId;
      return valueByAttrName(
        ymAttributes,
        ymAttributeValues,
        (a) => a?.id,
        (a) => a?.name,
        fieldLabel
      );
    }
  }

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

function controlAliases(controlKey, extras = {}) {
  const { ozonAttributes } = extras;
  if (controlKey === 'name' || controlKey === 'description' || controlKey === 'brand' || controlKey === 'sku') {
    return [{ mp: null, field: controlKey === 'sku' ? 'vendor_code' : controlKey, dedicated: true }];
  }
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
  if (dedicated[controlKey]) return [{ ...dedicated[controlKey], dedicated: true }];

  const m = String(controlKey || '').match(/^(ozon|wb|ym|erp)-attr:(.+)$/);
  if (!m) return [];
  const bucket = m[1];
  const id = m[2];
  const aliases = [{ mp: bucket === 'erp' ? null : bucket, field: `${bucket}:${id}` }];
  if (bucket === 'ozon') {
    const attr = (ozonAttributes || []).find((a) => String(a.id) === String(id));
    if (isOzonNameAttr(attr)) aliases.push({ mp: 'ozon', field: 'name', dedicated: true });
    if (isOzonAnnotationAttr(attr)) aliases.push({ mp: 'ozon', field: 'description', dedicated: true });
    if (isOzonBrandAttr(attr)) aliases.push({ mp: 'ozon', field: 'brand', dedicated: true });
  }
  return aliases;
}

function controlDisplayValue(controlKey, formData, extras = {}) {
  const dedicated = {
    name: formData?.name,
    description: formData?.description,
    brand: formData?.brand,
    sku: formData?.sku,
    mp_wb_name: formData?.mp_wb_name,
    mp_wb_description: formData?.mp_wb_description,
    mp_wb_brand: formData?.mp_wb_brand,
    mp_wb_vendor_code: formData?.mp_wb_vendor_code,
    mp_ym_name: formData?.mp_ym_name,
    mp_ym_description: formData?.mp_ym_description,
    mp_ozon_name: formData?.mp_ozon_name,
    mp_ozon_description: formData?.mp_ozon_description,
    mp_ozon_brand: formData?.mp_ozon_brand,
  };
  if (controlKey in dedicated) return dedicated[controlKey];
  const m = String(controlKey || '').match(/^(ozon|wb|ym|erp)-attr:(.+)$/);
  if (!m) return '';
  const bucket = m[1];
  const id = m[2];
  if (bucket === 'erp') return valueFromAttrMap(formData?.attributeValues, id);
  if (bucket === 'ozon') {
    return ozonAttrPlainText(extras.ozonAttributeValues?.[id] ?? extras.ozonAttributeValues?.[String(id)]);
  }
  if (bucket === 'wb') return valueFromAttrMap(extras.wbAttributeValues, id);
  if (bucket === 'ym') return valueFromAttrMap(extras.ymAttributeValues, id);
  return '';
}

export function limitItemsForControl(limitsByMp, formData, controlKey, extras = {}) {
  const aliases = controlAliases(controlKey, extras);
  if (!aliases.length) return [];
  const value = controlDisplayValue(controlKey, formData, extras);
  const links = normalizeMpFieldLinks(formData?.mp_field_links);
  const items = [];
  const seen = new Set();

  for (const alias of aliases) {
    const mps = alias.mp ? [alias.mp] : ['ozon', 'wb', 'ym'];
    for (const mp of mps) {
      if (alias.dedicated && !alias.mp) {
        const linkKey = linkFieldForLimit(alias.field);
        if (!isMpFieldLinked(links, linkKey, mp)) continue;
      }
      for (const rule of limitsByMp?.[mp] || []) {
        if (!ruleMatchesAlias(rule, alias, extras)) continue;
        const key = `${mp}::${rule.field}::${rule.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(evaluateLimitRule(rule, value, mp));
      }
    }
  }
  return items;
}

export function formControlLimitHit(limitsByMp, formData, controlKey, extras = {}) {
  const items = limitItemsForControl(limitsByMp, formData, controlKey, extras).filter((i) => i.over);
  if (!items.length) return null;
  const first = items[0];
  return {
    ...first,
    items,
    maxLength: first.kind === 'chars' ? first.max : undefined,
  };
}

export function collectProductFormLimitViolations({
  formData,
  ozonAttributes,
  ozonAttributeValues,
  wbAttributes,
  wbAttributeValues,
  ymAttributes,
  ymAttributeValues,
  erpAttributes,
  limitsByMp,
  marketplaces,
} = {}) {
  const mps = Array.isArray(marketplaces) && marketplaces.length
    ? marketplaces.filter((m) => m === 'ozon' || m === 'wb' || m === 'ym')
    : ['ozon', 'wb', 'ym'];
  const ctx = {
    formData,
    ozonAttributes,
    ozonAttributeValues,
    wbAttributes,
    wbAttributeValues,
    ymAttributes,
    ymAttributeValues,
    erpAttributes,
  };
  const violations = [];
  for (const mp of mps) {
    for (const rule of limitsByMp?.[mp] || []) {
      const value = resolveFormMpText({ ...ctx, mp, field: rule.field, fieldLabel: rule.field_label });
      const evaluated = evaluateLimitRule(rule, value, mp);
      if (!evaluated.over) continue;
      violations.push({
        sku: formData?.sku,
        productId: formData?.id,
        mp,
        mpLabel: evaluated.mpLabel,
        field: rule.field,
        fieldLabel: evaluated.fieldLabel,
        kind: evaluated.kind,
        length: evaluated.length,
        max: evaluated.max,
        maxLength: evaluated.kind === 'chars' ? evaluated.max : undefined,
        unitLabel: evaluated.unitLabel,
      });
    }
  }
  return violations;
}

export function strictestLinkedMainLimit(limitsByMp, field, links) {
  const items = [];
  const linkKey = linkFieldForLimit(field);
  for (const mp of ['ozon', 'wb', 'ym']) {
    if (!isMpFieldLinked(links, linkKey, mp)) continue;
    for (const rule of findRulesForField(limitsByMp, mp, field)) {
      items.push({
        mp,
        field,
        kind: rule.kind,
        maxLength: rule.kind === 'chars' ? rule.max : undefined,
        max: rule.max,
        mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp],
        field_label: rule.field_label,
      });
    }
  }
  const chars = items.filter((i) => i.kind !== 'words').sort((a, b) => a.max - b.max)[0];
  return chars || items.sort((a, b) => a.max - b.max)[0] || null;
}

export function strictestFieldLimit(limitsByMp, field) {
  let best = null;
  for (const mp of ['ozon', 'wb', 'ym']) {
    for (const rule of findRulesForField(limitsByMp, mp, field)) {
      if (rule.kind === 'words') continue;
      if (!best || rule.max < best.maxLength) {
        best = { mp, field, maxLength: rule.max, max: rule.max, mpLabel: MP_FIELD_LIMIT_MP_LABELS[mp] };
      }
    }
  }
  return best;
}

export function limitClassName(base, hit) {
  if (!hit) return base;
  return `${base} mp-field-over-limit`.trim();
}

function stringifyBulkAttr(v) {
  return stringifyAttrValue(v);
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

function resolveBulkMpText(row, mp, field, fieldLabel, mpAttrColumnDefs) {
  const parsed = parseLimitFieldKey(field);
  if (parsed.type === 'attr') {
    if (parsed.bucket === 'erp') {
      const key = `__erpAttr__${parsed.id}`;
      if (row?.[key] != null) return stringifyBulkAttr(row[key]);
      return stringifyBulkAttr(row?._erpAttrBaseline?.[parsed.id]);
    }
    const colKey = `__mpAttr__${parsed.bucket}__${parsed.id}`;
    if (row?.[colKey] != null && String(row[colKey]).trim() !== '') {
      return stringifyBulkAttr(row[colKey]);
    }
    if (fieldLabel) {
      const want = normalizeAttrName(fieldLabel);
      for (const col of mpAttrColumnDefs || []) {
        if (col?.mpAttr?.bucket !== parsed.bucket) continue;
        if (normalizeAttrName(col._humanName || col.label) !== want) continue;
        return stringifyBulkAttr(row?.[col.key]);
      }
    }
    return '';
  }

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
    for (const rule of limitsByMp?.[mp] || []) {
      const value = resolveBulkMpText(row, mp, rule.field, rule.field_label, mpAttrColumnDefs);
      const evaluated = evaluateLimitRule(rule, value, mp);
      if (!evaluated.over) continue;
      violations.push({
        sku: row.sku,
        productId: row.id,
        mp,
        mpLabel: evaluated.mpLabel,
        field: rule.field,
        fieldLabel: evaluated.fieldLabel,
        kind: evaluated.kind,
        length: evaluated.length,
        max: evaluated.max,
        maxLength: evaluated.kind === 'chars' ? evaluated.max : undefined,
        unitLabel: evaluated.unitLabel,
      });
    }
  }
  return violations;
}

function bulkColumnFieldAliases(col) {
  const k = String(col?.key || '');
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
  if (dedicated[k]) return [{ ...dedicated[k], dedicated: true }];
  if (k === 'name' || k === 'description' || k === 'brand') {
    return [{ mp: null, field: k, dedicated: true }];
  }
  if (k === 'sku') return [{ mp: 'wb', field: 'vendor_code', dedicated: true, requireLink: true }];
  const erpId = k.match(/^__erpAttr__(.+)$/);
  if (erpId) return [{ mp: null, field: `erp:${erpId[1]}` }];
  const mpAttr = k.match(/^__mpAttr__(ozon|wb|ym)__(.+)$/);
  if (mpAttr) {
    const aliases = [{ mp: mpAttr[1], field: `${mpAttr[1]}:${mpAttr[2]}` }];
    if (mpAttr[1] === 'ozon') {
      const attr = { id: mpAttr[2], name: col?._humanName || col?.label };
      if (isOzonNameAttr(attr)) aliases.push({ mp: 'ozon', field: 'name', dedicated: true });
      if (isOzonAnnotationAttr(attr)) aliases.push({ mp: 'ozon', field: 'description', dedicated: true });
      if (isOzonBrandAttr(attr)) aliases.push({ mp: 'ozon', field: 'brand', dedicated: true });
    }
    return aliases;
  }
  if (col?.mpAttr?.bucket) {
    return [{ mp: col.mpAttr.bucket, field: `${col.mpAttr.bucket}:${col.mpAttr.attrId}` }];
  }
  return [];
}

export function bulkCellLimitInfo(row, col, limitsByMp, displayedValue) {
  const value = displayedValue !== undefined ? displayedValue : row?.[col?.key];
  const aliases = bulkColumnFieldAliases(col);
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  const items = [];
  const seen = new Set();
  for (const alias of aliases) {
    const mps = alias.mp ? [alias.mp] : ['ozon', 'wb', 'ym'];
    for (const mp of mps) {
      if (alias.dedicated && !alias.mp) {
        if (!isMpFieldLinked(links, linkFieldForLimit(alias.field), mp)) continue;
      }
      if (alias.requireLink && !isMpFieldLinked(links, 'sku', mp)) continue;
      for (const rule of limitsByMp?.[mp] || []) {
        if (!ruleMatchesAlias(rule, alias, {}, col)) continue;
        const key = `${mp}::${rule.field}::${rule.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(evaluateLimitRule(rule, value, mp));
      }
    }
  }
  const overItems = items.filter((i) => i.over);
  const first = overItems[0] || items[0] || null;
  return {
    length: textCharLength(value),
    maxLength: first?.kind === 'chars' ? first.max : items.find((i) => i.kind === 'chars')?.max || null,
    mpLabel: first?.mpLabel || '',
    over: overItems.length > 0,
    items,
    kind: first?.kind,
    max: first?.max,
    unitLabel: first?.unitLabel,
  };
}

export function bulkCellLimitHit(row, col, limitsByMp, displayedValue) {
  const info = bulkCellLimitInfo(row, col, limitsByMp, displayedValue);
  if (!info?.over) return null;
  return info;
}

export function formatLimitHitTitle(info) {
  const items = (info?.items || []).filter((i) => i.over);
  if (!items.length) return '';
  return items
    .map((i) => `${i.mpLabel}: ${i.length} из ${i.max} ${i.unitLabel}`)
    .join('; ');
}

export function formatLimitCountLabel(info, fallbackValue) {
  const items = Array.isArray(info?.items) ? info.items : [];
  if (!items.length) return String(textCharLength(fallbackValue));
  return items
    .map((i) => `${i.length} / ${i.max}${i.kind === 'words' ? ' сл.' : ''}`)
    .join(' · ');
}

export function formatFieldLimitViolations(violations, { maxItems = 8 } = {}) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return '';
  const lines = list.slice(0, maxItems).map((v) => {
    const sku = v.sku ? `${v.sku} · ` : '';
    const unit = v.unitLabel || (v.kind === 'words' ? 'слов' : 'символов');
    const max = v.max ?? v.maxLength;
    return `• ${sku}${v.mpLabel} · ${v.fieldLabel}: ${v.length} из ${max} ${unit}`;
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
