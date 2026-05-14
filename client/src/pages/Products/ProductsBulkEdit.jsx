/**
 * Массовое редактирование товаров: таблица полей + «Заполнить массово» по столбцам.
 */

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { productsApi } from '../../services/products.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { useCategories } from '../../hooks/useCategories';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useBrands } from '../../hooks/useBrands';
import { getPrimaryProductImageUrl } from '../../utils/productImage.js';
import { userCategoriesApi } from '../../services/userCategories.api';
import './ProductsBulkEdit.css';
import './Products.css';

const LOAD_LIMIT_SELECTED = 500;
const LOAD_LIMIT_ALL = 200;
const SESSION_MP_OZON = 'productsBulkShowMpOzon';
const SESSION_MP_WB = 'productsBulkShowMpWb';
const SESSION_MP_YM = 'productsBulkShowMpYm';
/** Старый один тумблер — мигрируем в три флага по МП */
const SESSION_SHOW_MP_ATTRS_LEGACY = 'productsBulkShowMpAttrs';

function readMpBucketVisibility() {
  try {
    if (typeof sessionStorage === 'undefined') return { ozon: true, wb: true, ym: true };
    const leg = sessionStorage.getItem(SESSION_SHOW_MP_ATTRS_LEGACY);
    if (leg === '0') {
      try {
        sessionStorage.removeItem(SESSION_SHOW_MP_ATTRS_LEGACY);
      } catch {
        /* ignore */
      }
      return { ozon: false, wb: false, ym: false };
    }
    if (leg === '1') {
      try {
        sessionStorage.removeItem(SESSION_SHOW_MP_ATTRS_LEGACY);
      } catch {
        /* ignore */
      }
    }
    return {
      ozon: sessionStorage.getItem(SESSION_MP_OZON) !== '0',
      wb: sessionStorage.getItem(SESSION_MP_WB) !== '0',
      ym: sessionStorage.getItem(SESSION_MP_YM) !== '0',
    };
  } catch {
    return { ozon: true, wb: true, ym: true };
  }
}
/** Значение фильтра «товары без ERP-категории» — как на сервере в buildFindAllFilters */
const FILTER_CATEGORY_NONE = '__no_category__';

/** Базовые столбцы: порядок — основная карточка (артикулы → названия/бренд → описание → габариты → прочее),
 *  затем Ozon, затем WB, затем Я.Маркет (в каждом блоке: артикулы → название → описание → бренд и т.д.).
 *  JSON-атрибуты МП добавляются динамически после этих колонок (там же: Ozon, WB, ЯМ). */
const COLUMNS = [
  /* ——— основная карточка (ERP) ——— */
  /* артикулы / идентификаторы */
  { key: 'sku', label: 'Артикул', input: 'text', minW: 120 },
  { key: 'barcodes', label: 'Штрихкоды', input: 'textarea', minW: 140, hint: 'Через запятую или с новой строки' },
  { key: 'id', label: 'ID', readonly: true, noBulk: true, width: 56, minW: 56 },
  { key: '_photo', label: 'Фото', readonly: true, noBulk: true, width: 52, minW: 52 },
  /* названия */
  { key: 'name', label: 'Название', input: 'textarea', minW: 200 },
  { key: 'brand', label: 'Бренд', input: 'text', minW: 100 },
  /* описание */
  { key: 'description', label: 'Описание', input: 'textarea', minW: 220 },
  /* габариты и вес */
  { key: 'weight', label: 'Вес (г)', input: 'number', minW: 72 },
  { key: 'length', label: 'Длина', input: 'number', minW: 64 },
  { key: 'width', label: 'Ширина', input: 'number', minW: 64 },
  { key: 'height', label: 'Высота', input: 'number', minW: 64 },
  { key: 'volume', label: 'Объём (л)', input: 'number', minW: 72 },
  /* остальное */
  { key: 'product_type', label: 'Тип', input: 'select_type', minW: 88 },
  { key: 'categoryId', label: 'Категория', input: 'select_category', minW: 140 },
  { key: 'organizationId', label: 'Организация', input: 'select_org', minW: 140 },
  { key: 'cost', label: 'Себестоимость', input: 'number', minW: 88 },
  { key: 'additionalExpenses', label: 'Доп. расходы', input: 'number', minW: 88 },
  { key: 'minPrice', label: 'Мин. цена', input: 'number', minW: 80 },
  { key: 'buyout_rate', label: 'Выкуп %', input: 'number', minW: 72 },
  { key: 'country_of_origin', label: 'Страна', input: 'text', minW: 90 },
  /* ——— Ozon ——— */
  { key: 'sku_ozon', label: 'Ozon offer_id', input: 'text', minW: 100, mpBucket: 'ozon' },
  { key: 'ozon_product_id', label: 'Ozon product_id', input: 'text', minW: 100, mpBucket: 'ozon' },
  { key: 'mp_ozon_name', label: 'Ozon: название', input: 'textarea', minW: 160, mpBucket: 'ozon' },
  { key: 'mp_ozon_description', label: 'Ozon: описание', input: 'textarea', minW: 200, mpBucket: 'ozon' },
  { key: 'mp_ozon_brand', label: 'Ozon: бренд', input: 'text', minW: 100, mpBucket: 'ozon' },
  /* ——— Wildberries ——— */
  { key: 'sku_wb', label: 'WB nmId', input: 'text', minW: 90, mpBucket: 'wb' },
  { key: 'mp_wb_vendor_code', label: 'WB: артикул продавца', input: 'text', minW: 110, mpBucket: 'wb' },
  { key: 'mp_wb_name', label: 'WB: название', input: 'textarea', minW: 160, mpBucket: 'wb' },
  { key: 'mp_wb_description', label: 'WB: описание', input: 'textarea', minW: 200, mpBucket: 'wb' },
  { key: 'mp_wb_brand', label: 'WB: бренд', input: 'text', minW: 100, mpBucket: 'wb' },
  /* ——— Яндекс.Маркет ——— */
  { key: 'sku_ym', label: 'Я.Маркет offer', input: 'text', minW: 100, mpBucket: 'ym' },
  { key: 'mp_ym_name', label: 'ЯМ: название', input: 'textarea', minW: 160, mpBucket: 'ym' },
  { key: 'mp_ym_description', label: 'ЯМ: описание', input: 'textarea', minW: 200, mpBucket: 'ym' },
];

function str(v) {
  if (v == null) return '';
  return String(v);
}

/** Нормализация JSON-атрибутов маркетплейса в плоский объект */
function normalizeJsonAttrs(v) {
  if (v == null) return {};
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? { ...p } : {};
    } catch {
      return {};
    }
  }
  if (typeof v === 'object' && !Array.isArray(v)) return { ...v };
  return {};
}

function stringifyMpAttrValue(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Разбор значения ячейки атрибута МП.
 * Ozon — только string | number; WB/ЯМ — ещё boolean.
 */
function parseMpAttrCellValue(text, bucket) {
  const t = String(text ?? '').trim();
  if (t === '') return undefined;
  const lower = t.toLowerCase();
  if (bucket !== 'ozon' && (lower === 'true' || lower === 'false')) {
    return lower === 'true';
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      /* остаётся строка */
    }
  }
  return t;
}

function stableAttrJson(obj) {
  if (!obj || typeof obj !== 'object') return '{}';
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return JSON.stringify(o);
}

/** Собрать объекты атрибутов из baseline строки и значений видимых столбцов */
function attrsFromRow(row, mpAttrColDefs, bucket) {
  const base = { ...(row._mpAttrBaseline?.[bucket] || {}) };
  for (const c of mpAttrColDefs) {
    if (c.mpAttr?.bucket !== bucket) continue;
    const { attrId } = c.mpAttr;
    const cell = row[c.key];
    const parsed = parseMpAttrCellValue(cell, bucket);
    if (parsed === undefined) delete base[attrId];
    else base[attrId] = parsed;
  }
  return base;
}

function collectAttrKeySets(products) {
  const oz = new Set();
  const wb = new Set();
  const ym = new Set();
  for (const p of products) {
    if (!p) continue;
    Object.keys(normalizeJsonAttrs(p.ozon_attributes)).forEach((k) => oz.add(String(k)));
    Object.keys(normalizeJsonAttrs(p.wb_attributes)).forEach((k) => wb.add(String(k)));
    Object.keys(normalizeJsonAttrs(p.ym_attributes)).forEach((k) => ym.add(String(k)));
  }
  return { oz, wb, ym };
}

function mpAttrSortRankFromHuman(humanName) {
  const h = String(humanName || '').trim().toLowerCase();
  if (!h) return 4;
  if (
    /артикул|штрих|баркод|vendor|nm\b|offer_id|(^|[^а-я])offer\b|ean|идентификатор товара|код товара продавца|barcode/i.test(
      h
    ) &&
    !/название|наименование/.test(h)
  ) {
    return 0;
  }
  if ((/название|наименование|имя товара/.test(h) || h === 'бренд' || h.includes('торговая марк')) && !/описание/.test(h)) {
    return 1;
  }
  if (/описание|аннотация|annotation/.test(h)) return 2;
  if (/вес|габарит|длин|ширин|высот|объём|объем|размер|глубин|толщин|упаковк/i.test(h)) return 3;
  return 4;
}

function sortAttrIdsWithLabels(set, labelMap) {
  const m = labelMap || {};
  return [...set].sort((a, b) => {
    const ida = String(a);
    const idb = String(b);
    const ha = String(m[ida] ?? m[String(ida)] ?? '').trim();
    const hb = String(m[idb] ?? m[String(idb)] ?? '').trim();
    const ra = mpAttrSortRankFromHuman(ha);
    const rb = mpAttrSortRankFromHuman(hb);
    if (ra !== rb) return ra - rb;
    return ida.localeCompare(idb, undefined, { numeric: true });
  });
}

function mergeOzonAttrNameMap(list, into) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const id = a?.id != null ? String(a.id) : '';
    if (!id) continue;
    const name = String(a?.name || '').trim();
    if (name && !into[id]) into[id] = name;
  }
}

function mergeWbAttrNameMap(list, into) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const idRaw = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id;
    if (idRaw == null) continue;
    const id = String(idRaw);
    const name = String(a?.name ?? a?.charcName ?? a?.characteristic_name ?? '').trim();
    if (name && !into[id]) into[id] = name;
  }
}

function mergeYmAttrNameMap(list, into) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const id = a?.id != null ? String(a.id) : '';
    if (!id) continue;
    const name = String(a?.name || '').trim();
    if (name && !into[id]) into[id] = name;
  }
}

/**
 * Подписи характеристик по сопоставлениям ERP→МП (как в карточке товара).
 * Для каждой user_category_id из выборки запрашиваются схемы ozon / wb / ym.
 */
async function fetchMpAttributeLabelMaps(products) {
  const maps = { ozon: {}, wb: {}, ym: {} };
  const catIds = [
    ...new Set(
      products
        .map((p) => String(p?.user_category_id ?? p?.categoryId ?? '').trim())
        .filter(Boolean)
    ),
  ];
  if (catIds.length === 0) return maps;

  const markets = /** @type {const} */ (['ozon', 'wb', 'ym']);
  const tasks = [];
  for (const catId of catIds) {
    for (const mp of markets) {
      tasks.push({ catId, mp });
    }
  }
  const BATCH = 8;
  for (let i = 0; i < tasks.length; i += BATCH) {
    const chunk = tasks.slice(i, i + BATCH);
    const settled = await Promise.all(
      chunk.map(({ catId, mp }) => userCategoriesApi.getMarketplaceAttributes(catId, mp).catch(() => null))
    );
    chunk.forEach(({ mp }, j) => {
      const res = settled[j];
      const body = res?.data ?? res;
      if (mp === 'ozon') mergeOzonAttrNameMap(body, maps.ozon);
      else if (mp === 'wb') mergeWbAttrNameMap(body, maps.wb);
      else mergeYmAttrNameMap(body, maps.ym);
    });
  }
  return maps;
}

function formatMpColumnLabel(marketShort, attrId, humanName) {
  const id = String(attrId);
  const h = humanName && String(humanName).trim() ? String(humanName).trim() : '';
  if (h) return `${marketShort}: ${h}`;
  return `${marketShort} (id ${id})`;
}

function mpColumnTitleAttr(bucket, attrId, humanName) {
  const id = String(attrId);
  const h = humanName && String(humanName).trim() ? String(humanName).trim() : '';
  const ru = bucket === 'ozon' ? 'Ozon' : bucket === 'wb' ? 'Wildberries' : 'Яндекс.Маркет';
  return h ? `${ru} · ${h}\nID: ${id}` : `${ru}\nID: ${id}`;
}

/** Совпадение подписи с колонками карточки mp_* (плоские поля), чтобы не дублировать JSON-атрибуты */
const DUPLICATE_MP_CARD_ATTR_LABELS = new Set([
  'ozon: название',
  'ozon: описание',
  'ozon: бренд',
  'wb: название',
  'wb: описание',
  'wb: бренд',
  'wb: артикул продавца',
  'ям: название',
  'ям: описание',
]);

/**
 * Пропускать ключ ozon_attributes / wb_attributes / ym_attributes, если он дублирует mp_* (то же по смыслу, что в карточке МП).
 * Имена — как в схеме категории (подписи из API); плюс эвристики как в ProductForm для Ozon.
 */
function isDuplicateMpCardJsonAttr(bucket, humanName) {
  const raw = String(humanName || '').trim();
  if (!raw) return false;
  const h = raw.toLowerCase();
  const short = bucket === 'ozon' ? 'Ozon' : bucket === 'wb' ? 'WB' : 'ЯМ';
  const flat = `${short}: ${raw}`.toLowerCase();
  if (DUPLICATE_MP_CARD_ATTR_LABELS.has(flat)) return true;

  if (bucket === 'ozon') {
    if (h === 'название' || (h.startsWith('название') && !h.includes('модели') && !h.includes('группы') && !h.includes('файла') && !h.includes('видео'))) {
      return true;
    }
    if (h.includes('аннотация') || (h.includes('описание') && h.includes('маркетинг'))) return true;
    if (h === 'бренд' || h.includes('торговая марк')) return true;
    return false;
  }

  if (bucket === 'wb') {
    if (h.includes('артикул продавца')) return true;
    if (h === 'бренд' || h.includes('бренд продавца') || h.includes('торговая марк')) return true;
    if (h === 'название' || (h.includes('наименование') && h.includes('товар'))) return true;
    if (h.includes('описание') && (h.includes('товар') || h.includes('продавца'))) return true;
    return false;
  }

  if (bucket === 'ym') {
    if (h === 'название' || h === 'название товара' || (h.startsWith('название') && !h.includes('модели') && !h.includes('группы'))) {
      return true;
    }
    if ((h.includes('описание') && (h.includes('товар') || h.includes('карточк'))) || h === 'описание товара') return true;
    return false;
  }

  return false;
}

/** Столбцы по объединению ключей атрибутов по всем загруженным товарам */
function buildMpAttrColumnDefs(products, labelMaps = { ozon: {}, wb: {}, ym: {} }) {
  const { oz, wb, ym } = collectAttrKeySets(products);
  const ozM = labelMaps?.ozon || {};
  const wbM = labelMaps?.wb || {};
  const ymM = labelMaps?.ym || {};
  const cols = [];
  for (const id of sortAttrIdsWithLabels(oz, ozM)) {
    const human = ozM[id] || ozM[String(id)];
    if (isDuplicateMpCardJsonAttr('ozon', human)) continue;
    cols.push({
      key: `__mpAttr__ozon__${id}`,
      label: formatMpColumnLabel('Ozon', id, human),
      title: mpColumnTitleAttr('ozon', id, human),
      headerClass: 'mp-attr-head',
      input: 'textarea',
      minW: 120,
      mpAttr: { bucket: 'ozon', attrId: id },
    });
  }
  for (const id of sortAttrIdsWithLabels(wb, wbM)) {
    const human = wbM[id] || wbM[String(id)];
    if (isDuplicateMpCardJsonAttr('wb', human)) continue;
    cols.push({
      key: `__mpAttr__wb__${id}`,
      label: formatMpColumnLabel('WB', id, human),
      title: mpColumnTitleAttr('wb', id, human),
      headerClass: 'mp-attr-head',
      input: 'textarea',
      minW: 120,
      mpAttr: { bucket: 'wb', attrId: id },
    });
  }
  for (const id of sortAttrIdsWithLabels(ym, ymM)) {
    const human = ymM[id] || ymM[String(id)];
    if (isDuplicateMpCardJsonAttr('ym', human)) continue;
    cols.push({
      key: `__mpAttr__ym__${id}`,
      label: formatMpColumnLabel('ЯМ', id, human),
      title: mpColumnTitleAttr('ym', id, human),
      headerClass: 'mp-attr-head',
      input: 'textarea',
      minW: 120,
      mpAttr: { bucket: 'ym', attrId: id },
    });
  }
  return cols;
}

function productToRow(p, mpAttrColDefs = []) {
  const orgRaw = p.organization_id ?? p.organizationId;
  const barcodes = Array.isArray(p.barcodes) ? p.barcodes : [];
  const oz = normalizeJsonAttrs(p.ozon_attributes);
  const wb = normalizeJsonAttrs(p.wb_attributes);
  const ym = normalizeJsonAttrs(p.ym_attributes);
  const row = {
    id: str(p.id),
    name: str(p.name),
    sku: str(p.sku),
    product_type: p.product_type === 'kit' ? 'kit' : 'product',
    categoryId: p.categoryId != null && p.categoryId !== '' ? str(p.categoryId) : '',
    organizationId: orgRaw != null && orgRaw !== '' ? str(orgRaw) : '',
    brand: str(p.brand ?? p.brand_name ?? ''),
    cost: p.cost != null && p.cost !== '' && !Number.isNaN(Number(p.cost)) ? str(p.cost) : '',
    additionalExpenses:
      p.additionalExpenses != null && p.additionalExpenses !== ''
        ? str(p.additionalExpenses)
        : p.additional_expenses != null && p.additional_expenses !== ''
          ? str(p.additional_expenses)
          : '',
    minPrice:
      p.minPrice != null && p.minPrice !== ''
        ? str(p.minPrice)
        : p.min_price != null && p.min_price !== ''
          ? str(p.min_price)
          : '',
    buyout_rate:
      p.buyout_rate != null && p.buyout_rate !== '' ? str(p.buyout_rate) : '95',
    description: str(p.description),
    country_of_origin: str(p.country_of_origin),
    barcodes: barcodes.map((b) => str(b).trim()).filter(Boolean).join(', '),
    sku_ozon: str(p.sku_ozon ?? p.marketplace_skus?.ozon ?? ''),
    ozon_product_id: str(p.ozon_product_id ?? p.marketplace_ozon_product_id ?? ''),
    sku_wb: str(p.sku_wb ?? p.marketplace_skus?.wb ?? ''),
    sku_ym: str(p.sku_ym ?? p.marketplace_skus?.ym ?? ''),
    mp_ozon_name: str(p.mp_ozon_name),
    mp_ozon_description: str(p.mp_ozon_description),
    mp_ozon_brand: str(p.mp_ozon_brand),
    mp_wb_vendor_code: str(p.mp_wb_vendor_code),
    mp_wb_name: str(p.mp_wb_name),
    mp_wb_description: str(p.mp_wb_description),
    mp_wb_brand: str(p.mp_wb_brand),
    mp_ym_name: str(p.mp_ym_name),
    mp_ym_description: str(p.mp_ym_description),
    weight: p.weight != null && p.weight !== '' ? str(p.weight) : '',
    length: p.length != null && p.length !== '' ? str(p.length) : '',
    width: p.width != null && p.width !== '' ? str(p.width) : '',
    height: p.height != null && p.height !== '' ? str(p.height) : '',
    volume: p.volume != null && p.volume !== '' ? str(p.volume) : '',
    _mpAttrBaseline: { ozon: { ...oz }, wb: { ...wb }, ym: { ...ym } },
    _productRef: p,
  };
  for (const c of mpAttrColDefs) {
    if (!c.mpAttr) continue;
    const { bucket, attrId } = c.mpAttr;
    const src = bucket === 'ozon' ? oz : bucket === 'wb' ? wb : ym;
    row[c.key] = stringifyMpAttrValue(src[attrId]);
  }
  return row;
}

function parseBarcodesCell(text) {
  const raw = str(text);
  if (!raw.trim()) return [];
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normTextOrNull(s) {
  const t = str(s).trim();
  return t === '' ? null : t;
}

function parseOptionalNumber(s) {
  const t = str(s).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseBuyout(s) {
  const t = str(s).trim();
  if (t === '') return 95;
  const n = Number(t);
  if (!Number.isFinite(n)) return 95;
  return Math.min(100, Math.max(0, n));
}

/** Собрать тело PUT только для изменённых полей */
function buildUpdatePayload(original, current, mpAttrColDefs = []) {
  const payload = {};
  const touch = (apiKey, value) => {
    payload[apiKey] = value;
  };

  const eq = (a, b) => str(a) === str(b);

  if (!eq(original.name, current.name)) touch('name', str(current.name).trim());
  if (!eq(original.sku, current.sku)) touch('sku', str(current.sku).trim());

  if (!eq(original.product_type, current.product_type)) {
    touch('product_type', current.product_type === 'kit' ? 'kit' : 'product');
  }

  if (!eq(original.categoryId, current.categoryId)) {
    touch('categoryId', str(current.categoryId).trim() === '' ? null : str(current.categoryId).trim());
  }
  if (!eq(original.organizationId, current.organizationId)) {
    touch('organizationId', str(current.organizationId).trim() === '' ? null : str(current.organizationId).trim());
  }

  if (!eq(original.brand, current.brand)) touch('brand', normTextOrNull(current.brand));

  if (!eq(original.cost, current.cost)) touch('cost', parseOptionalNumber(current.cost));
  if (!eq(original.additionalExpenses, current.additionalExpenses)) {
    touch('additionalExpenses', parseOptionalNumber(current.additionalExpenses));
  }
  if (!eq(original.minPrice, current.minPrice)) {
    const mp = parseOptionalNumber(current.minPrice);
    touch('minPrice', mp == null ? 50 : mp);
  }
  if (!eq(original.buyout_rate, current.buyout_rate)) touch('buyout_rate', parseBuyout(current.buyout_rate));

  if (!eq(original.description, current.description)) touch('description', normTextOrNull(current.description));
  if (!eq(original.country_of_origin, current.country_of_origin)) {
    touch('country_of_origin', normTextOrNull(current.country_of_origin));
  }

  const ob = parseBarcodesCell(original.barcodes).join('\u0001');
  const cb = parseBarcodesCell(current.barcodes).join('\u0001');
  if (ob !== cb) touch('barcodes', parseBarcodesCell(current.barcodes));

  if (!eq(original.sku_ozon, current.sku_ozon)) touch('sku_ozon', normTextOrNull(current.sku_ozon));
  if (!eq(original.sku_wb, current.sku_wb)) touch('sku_wb', normTextOrNull(current.sku_wb));
  if (!eq(original.sku_ym, current.sku_ym)) touch('sku_ym', normTextOrNull(current.sku_ym));

  if (!eq(original.ozon_product_id, current.ozon_product_id)) {
    const t = str(current.ozon_product_id).trim().replace(/\D/g, '').slice(0, 19);
    touch('marketplace_ozon_product_id', t === '' ? null : Number(t));
  }

  const mpText = (k) => {
    if (!eq(original[k], current[k])) touch(k, normTextOrNull(current[k]));
  };
  mpText('mp_ozon_name');
  mpText('mp_ozon_description');
  mpText('mp_ozon_brand');
  mpText('mp_wb_vendor_code');
  mpText('mp_wb_name');
  mpText('mp_wb_description');
  mpText('mp_wb_brand');
  mpText('mp_ym_name');
  mpText('mp_ym_description');

  if (!eq(original.weight, current.weight)) touch('weight', parseOptionalNumber(current.weight));
  if (!eq(original.length, current.length)) touch('length', parseOptionalNumber(current.length));
  if (!eq(original.width, current.width)) touch('width', parseOptionalNumber(current.width));
  if (!eq(original.height, current.height)) touch('height', parseOptionalNumber(current.height));
  if (!eq(original.volume, current.volume)) touch('volume', parseOptionalNumber(current.volume));

  if (mpAttrColDefs.length > 0) {
    const map = { ozon: 'ozon_attributes', wb: 'wb_attributes', ym: 'ym_attributes' };
    for (const bucket of ['ozon', 'wb', 'ym']) {
      const defs = mpAttrColDefs.filter((c) => c.mpAttr?.bucket === bucket);
      if (defs.length === 0) continue;
      const before = attrsFromRow(original, mpAttrColDefs, bucket);
      const after = attrsFromRow(current, mpAttrColDefs, bucket);
      if (stableAttrJson(before) !== stableAttrJson(after)) {
        touch(map[bucket], after);
      }
    }
  }

  return payload;
}

function cloneRow(r) {
  const { _productRef, ...rest } = r;
  return { ...rest };
}

export function ProductsBulkEdit() {
  const location = useLocation();
  const navigate = useNavigate();
  const { categories, loadCategories } = useCategories();
  const { organizations } = useOrganizations();
  const { brands } = useBrands();

  const [rows, setRows] = useState([]);
  const [originals, setOriginals] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);

  const [filterOrganizationId, setFilterOrganizationId] = useState(() => {
    const f = location.state?.filters;
    return f?.organizationId != null && f.organizationId !== '' ? String(f.organizationId) : '';
  });
  const [filterBrandId, setFilterBrandId] = useState(() => {
    const f = location.state?.filters;
    return f?.brandId != null && f.brandId !== '' ? String(f.brandId) : '';
  });
  const [filterCategoryId, setFilterCategoryId] = useState(() => {
    const f = location.state?.filters;
    return f?.categoryId != null && f.categoryId !== '' ? String(f.categoryId) : '';
  });
  const [filterProductType, setFilterProductType] = useState(() => {
    const f = location.state?.filters;
    return f?.productType != null && String(f.productType).trim() !== '' ? String(f.productType).trim() : '';
  });
  const [listSearch, setListSearch] = useState(() => {
    const f = location.state?.filters;
    return f?.search != null ? String(f.search) : '';
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** null — до первой загрузки; при выборке с «Товаров» учитываются только выбранные id */
  const [showUncategorizedCategoryOption, setShowUncategorizedCategoryOption] = useState(null);
  const [appliedSelectedIds] = useState(() =>
    Array.isArray(location.state?.selectedIds)
      ? [...new Set(location.state.selectedIds.map((x) => str(x)).filter(Boolean))]
      : []
  );

  const listSearchDebounceRef = useRef(null);
  const loadGenRef = useRef(0);

  const [bulkModal, setBulkModal] = useState({ open: false, column: null });
  const [bulkDraft, setBulkDraft] = useState('');

  const [mpAttrColumnDefs, setMpAttrColumnDefs] = useState([]);
  const [showMpOzon, setShowMpOzon] = useState(() => readMpBucketVisibility().ozon);
  const [showMpWb, setShowMpWb] = useState(() => readMpBucketVisibility().wb);
  const [showMpYm, setShowMpYm] = useState(() => readMpBucketVisibility().ym);

  useEffect(() => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_MP_OZON, showMpOzon ? '1' : '0');
      }
    } catch {
      /* ignore */
    }
  }, [showMpOzon]);
  useEffect(() => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_MP_WB, showMpWb ? '1' : '0');
      }
    } catch {
      /* ignore */
    }
  }, [showMpWb]);
  useEffect(() => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_MP_YM, showMpYm ? '1' : '0');
      }
    } catch {
      /* ignore */
    }
  }, [showMpYm]);

  const visibleMpAttrColumnDefs = useMemo(
    () =>
      mpAttrColumnDefs.filter((c) => {
        const b = c.mpAttr?.bucket;
        if (b === 'ozon') return showMpOzon;
        if (b === 'wb') return showMpWb;
        if (b === 'ym') return showMpYm;
        return false;
      }),
    [mpAttrColumnDefs, showMpOzon, showMpWb, showMpYm]
  );

  const visibleColumns = useMemo(() => {
    const base = COLUMNS.filter((c) => {
      const b = c.mpBucket;
      if (b == null) return true;
      if (b === 'ozon') return showMpOzon;
      if (b === 'wb') return showMpWb;
      if (b === 'ym') return showMpYm;
      return false;
    });
    return [...base, ...visibleMpAttrColumnDefs];
  }, [visibleMpAttrColumnDefs, showMpOzon, showMpWb, showMpYm]);

  const activeFiltersCount =
    (filterOrganizationId ? 1 : 0) +
    (filterBrandId ? 1 : 0) +
    (filterCategoryId ? 1 : 0) +
    (filterProductType ? 1 : 0);

  useEffect(() => {
    return () => {
      if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    };
  }, []);

  const clearListFilters = () => {
    setFilterOrganizationId('');
    setFilterBrandId('');
    setFilterCategoryId('');
    setFilterProductType('');
    setListSearch('');
  };

  const loadProducts = useCallback(async (partial = {}) => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setLoadError(null);
    setSaveMessage(null);
    try {
      await loadCategories({ silent: true });

      const org = partial.organizationId !== undefined ? partial.organizationId : filterOrganizationId;
      const brand = partial.brandId !== undefined ? partial.brandId : filterBrandId;
      const cat = partial.categoryId !== undefined ? partial.categoryId : filterCategoryId;
      const pt = partial.productType !== undefined ? partial.productType : filterProductType;
      const searchRaw = partial.search !== undefined ? partial.search : listSearch;
      const search = typeof searchRaw === 'string' ? searchRaw.trim() : '';
      const ptTrim = typeof pt === 'string' ? pt.trim() : '';

      const baseParams = {
        organizationId: org || undefined,
        brandId: brand || undefined,
        categoryId: cat || undefined,
        productType: ptTrim || undefined,
        search: search || undefined,
        cacheBust: true,
      };

      const selectedIds = [...new Set((appliedSelectedIds || []).map((x) => str(x)).filter(Boolean))];

      let list = [];
      if (selectedIds.length > 0) {
        const res = await productsApi.getAll({
          ...baseParams,
          limit: LOAD_LIMIT_SELECTED,
          offset: 0,
        });
        if (gen !== loadGenRef.current) return;
        const all = Array.isArray(res?.data) ? res.data : [];
        const setSel = new Set(selectedIds);
        list = all.filter((p) => p && setSel.has(str(p.id)));
        const have = new Set(list.map((p) => str(p.id)));
        const missing = selectedIds.filter((id) => !have.has(str(id)));
        for (const id of missing) {
          if (gen !== loadGenRef.current) return;
          try {
            const wrap = await productsApi.getById(id);
            const p = wrap?.data ?? wrap;
            if (p?.id != null) list.push(p);
          } catch {
            /* пропускаем */
          }
        }
      } else {
        const res = await productsApi.getAll({
          ...baseParams,
          limit: LOAD_LIMIT_ALL,
          offset: 0,
        });
        if (gen !== loadGenRef.current) return;
        list = Array.isArray(res?.data) ? res.data : [];
      }

      let showUncat = false;
      try {
        const resU = await productsApi.getAll({
          organizationId: org || undefined,
          brandId: brand || undefined,
          categoryId: FILTER_CATEGORY_NONE,
          productType: ptTrim || undefined,
          search: search || undefined,
          cacheBust: true,
          limit: selectedIds.length > 0 ? LOAD_LIMIT_SELECTED : 1,
          offset: 0,
        });
        if (gen !== loadGenRef.current) return;
        const uncat = Array.isArray(resU?.data) ? resU.data.filter(Boolean) : [];
        if (selectedIds.length > 0) {
          const setSel = new Set(selectedIds.map((x) => str(x)));
          showUncat = uncat.some((p) => p?.id != null && setSel.has(str(p.id)));
        } else {
          const total = Number(resU?.meta?.total);
          showUncat = uncat.length > 0 || (Number.isFinite(total) && total > 0);
        }
      } catch {
        showUncat = false;
      }
      if (gen !== loadGenRef.current) return;
      setShowUncategorizedCategoryOption(showUncat);

      const mpColsInitial = buildMpAttrColumnDefs(list, { ozon: {}, wb: {}, ym: {} });
      if (gen !== loadGenRef.current) return;
      setMpAttrColumnDefs(mpColsInitial);
      const nextRows = list.filter(Boolean).map((p) => productToRow(p, mpColsInitial));
      const orig = {};
      for (const r of nextRows) {
        orig[r.id] = cloneRow(r);
      }
      setRows(nextRows);
      setOriginals(orig);

      queueMicrotask(() => {
        fetchMpAttributeLabelMaps(list)
          .then((maps) => {
            if (gen !== loadGenRef.current) return;
            const mpColsLabeled = buildMpAttrColumnDefs(list, maps);
            setMpAttrColumnDefs(mpColsLabeled);
          })
          .catch(() => {
            /* оставляем подписи по id */
          });
      });
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setLoadError(e?.response?.data?.message || e?.message || 'Ошибка загрузки');
      setRows([]);
      setOriginals({});
      setMpAttrColumnDefs([]);
      setShowUncategorizedCategoryOption(false);
    } finally {
      if (gen === loadGenRef.current) {
        setLoading(false);
      }
    }
  }, [
    loadCategories,
    filterOrganizationId,
    filterBrandId,
    filterCategoryId,
    filterProductType,
    listSearch,
    appliedSelectedIds,
  ]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const showNoneCategoryOption = useMemo(
    () =>
      showUncategorizedCategoryOption === true ||
      (filterCategoryId === FILTER_CATEGORY_NONE && showUncategorizedCategoryOption !== false),
    [showUncategorizedCategoryOption, filterCategoryId]
  );

  useEffect(() => {
    if (showUncategorizedCategoryOption === false && filterCategoryId === FILTER_CATEGORY_NONE) {
      setFilterCategoryId('');
    }
  }, [showUncategorizedCategoryOption, filterCategoryId]);

  const handleFilterOrganizationChange = (e) => {
    const v = e.target.value;
    setFilterOrganizationId(v);
    void loadProducts({ organizationId: v });
  };

  const handleFilterBrandChange = (e) => {
    const v = e.target.value;
    setFilterBrandId(v);
    void loadProducts({ brandId: v });
  };

  const handleFilterCategoryChange = (e) => {
    const v = e.target.value;
    setFilterCategoryId(v);
    void loadProducts({ categoryId: v });
  };

  const handleFilterProductTypeChange = (e) => {
    const v = e.target.value;
    setFilterProductType(v);
    void loadProducts({ productType: v });
  };

  const handleListSearchChange = (e) => {
    const v = e.target.value;
    setListSearch(v);
    if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    listSearchDebounceRef.current = setTimeout(() => {
      void loadProducts({ search: v });
    }, 400);
  };

  const applyClearListFilters = () => {
    clearListFilters();
    void loadProducts({
      organizationId: '',
      brandId: '',
      categoryId: '',
      productType: '',
      search: '',
    });
  };

  const openBulk = (col) => {
    if (col.readonly || col.noBulk) return;
    setBulkDraft('');
    setBulkModal({ open: true, column: col });
  };

  const applyBulk = () => {
    const col = bulkModal.column;
    if (!col) return;
    const key = col.key;
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        [key]: bulkDraft,
      }))
    );
    setBulkModal({ open: false, column: null });
  };

  const updateCell = (id, key, value) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    const errors = [];
    let ok = 0;
    try {
      for (const r of rows) {
        const orig = originals[r.id];
        if (!orig) continue;
        const payload = buildUpdatePayload(orig, r, mpAttrColumnDefs);
        if (Object.keys(payload).length === 0) continue;
        try {
          const wrap = await productsApi.update(r.id, payload);
          const u = wrap?.data !== undefined ? wrap.data : wrap;
          const nextRow = productToRow(u, mpAttrColumnDefs);
          setOriginals((o) => ({ ...o, [r.id]: cloneRow(nextRow) }));
          setRows((list) => list.map((row) => (row.id === r.id ? { ...nextRow, _productRef: u } : row)));
          ok += 1;
        } catch (e) {
          const msg = e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Ошибка';
          errors.push({ id: r.id, sku: r.sku, msg });
        }
      }
      if (errors.length === 0) {
        setSaveMessage(ok > 0 ? `Сохранено изменений: ${ok}.` : 'Нет изменений для сохранения.');
      } else {
        setSaveMessage(
          `Сохранено: ${ok}. Ошибок: ${errors.length}. ` +
            errors.slice(0, 5).map((e) => `#${e.id} (${e.sku}): ${e.msg}`).join('; ')
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const subtitle = useMemo(() => {
    const n = rows.length;
    const sel = appliedSelectedIds.length;
    if (sel > 0) return `Редактирование выбранных товаров (${n} шт.). Фильтры ниже сужают выборку; выбранные id с «Товаров» по-прежнему ограничивают список.`;
    return `До ${LOAD_LIMIT_ALL} товаров по фильтрам ниже. Отметьте строки на странице «Товары» и откройте массовое редактирование, чтобы править только выбранные.`;
  }, [rows.length, appliedSelectedIds.length]);

  const renderInput = (col, row) => {
    const v = row[col.key];
    const common = {
      className: `products-bulk-cell-input ${col.input === 'textarea' || col.mpAttr ? 'products-bulk-cell-textarea' : ''}`,
      value: v,
      onChange: (e) => updateCell(row.id, col.key, e.target.value),
    };

    if (col.input === 'textarea' || col.mpAttr) {
      return <textarea {...common} rows={2} />;
    }
    if (col.input === 'number') {
      return <input {...common} type="text" inputMode="decimal" autoComplete="off" />;
    }
    if (col.input === 'select_type') {
      return (
        <select
          className="products-bulk-cell-input"
          value={v}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
        >
          <option value="product">Товар</option>
          <option value="kit">Комплект</option>
        </select>
      );
    }
    if (col.input === 'select_category') {
      return (
        <select
          className="products-bulk-cell-input"
          value={v}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    if (col.input === 'select_org') {
      return (
        <select
          className="products-bulk-cell-input"
          value={v}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="">—</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    }
    return <input {...common} type="text" autoComplete="off" />;
  };

  const bulkModalCol = bulkModal.column;

  return (
    <div key={location.key} className="products-bulk-page">
      <PageTitle
        iconClass="pe-7s-box2"
        iconBgClass="bg-mean-fruit"
        title="Массовое редактирование"
        subtitle={subtitle}
        actions={(
          <Link to="/products" className="btn btn-secondary btn-sm btn-shadow">
            ← К списку товаров
          </Link>
        )}
      />

      {loadError ? (
        <div className="alert alert-danger mb-0" role="alert">
          {loadError}
        </div>
      ) : null}
      {saveMessage ? (
        <div className={`alert ${saveMessage.includes('Ошибок') ? 'alert-warning' : 'alert-success'} mb-0`} role="status">
          {saveMessage}
        </div>
      ) : null}

      <div className="main-card mb-0 card products-bulk-main-card">
            <div className="card-body p-0">
              <div className="products-list-toolbar">
                <div className="products-bulk-toolbar-inner">
                  <div className="d-flex flex-wrap align-items-end gap-2 gap-md-3">
                    <div className="products-bulk-toolbar-search">
                      <label className="text-muted small mb-1 d-block" htmlFor="bulk-products-search">
                        Поиск по списку
                      </label>
                      <input
                        id="bulk-products-search"
                        type="search"
                        className="form-control form-control-sm products-list-search-input"
                        placeholder="Название, артикул, штрихкод…"
                        value={listSearch}
                        onChange={handleListSearchChange}
                        autoComplete="off"
                        aria-label="Поиск по названию, артикулу или штрихкоду"
                        aria-busy={loading}
                      />
                    </div>
                    <div className="d-flex align-items-end gap-2 ms-md-auto flex-wrap">
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        className="btn-shadow"
                        onClick={() => setFiltersOpen((o) => !o)}
                        aria-expanded={filtersOpen}
                        title="Организация, бренд, категория, тип товара"
                      >
                        {filtersOpen ? '▼ Фильтры' : '▶ Фильтры'}
                        {activeFiltersCount > 0 ? (
                          <span className="badge bg-primary ms-1 rounded-pill">{activeFiltersCount}</span>
                        ) : null}
                      </Button>
                    </div>
                  </div>
                  {filtersOpen ? (
                    <div className="products-filters-panel">
                      <div className="row g-2 g-md-3 align-items-end">
                        <div className="col-12 col-md-6 col-lg-3">
                          <label className="text-muted small mb-1 d-block" htmlFor="bulk-filter-org">
                            Организация
                          </label>
                          <select
                            id="bulk-filter-org"
                            className="form-select form-select-sm"
                            value={filterOrganizationId}
                            onChange={handleFilterOrganizationChange}
                          >
                            <option value="">Все организации</option>
                            {organizations.map((org) => (
                              <option key={org.id} value={org.id}>
                                {org.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-12 col-md-6 col-lg-3">
                          <label className="text-muted small mb-1 d-block" htmlFor="bulk-filter-brand">
                            Бренд
                          </label>
                          <select
                            id="bulk-filter-brand"
                            className="form-select form-select-sm"
                            value={filterBrandId}
                            onChange={handleFilterBrandChange}
                          >
                            <option value="">Все бренды</option>
                            {[...brands]
                              .filter((b) => b && b.name)
                              .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'))
                              .map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}
                                </option>
                              ))}
                          </select>
                        </div>
                        <div className="col-12 col-md-6 col-lg-3">
                          <label className="text-muted small mb-1 d-block" htmlFor="bulk-filter-cat">
                            Категория
                          </label>
                          <select
                            id="bulk-filter-cat"
                            className="form-select form-select-sm"
                            value={filterCategoryId}
                            onChange={handleFilterCategoryChange}
                          >
                            <option value="">Все категории</option>
                            {showNoneCategoryOption ? (
                              <option value={FILTER_CATEGORY_NONE}>Без категории</option>
                            ) : null}
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-12 col-md-6 col-lg-3">
                          <label className="text-muted small mb-1 d-block" htmlFor="bulk-filter-type">
                            Тип товара
                          </label>
                          <select
                            id="bulk-filter-type"
                            className="form-select form-select-sm"
                            value={filterProductType}
                            onChange={handleFilterProductTypeChange}
                          >
                            <option value="">Все типы</option>
                            <option value="product">Товар</option>
                            <option value="kit">Комплект</option>
                          </select>
                        </div>
                      </div>
                      {activeFiltersCount > 0 ? (
                        <div className="mt-2">
                          <button type="button" className="btn btn-link btn-sm p-0 text-decoration-none" onClick={applyClearListFilters}>
                            Сбросить фильтры
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="products-bulk-mp-toggles-row d-flex flex-wrap align-items-center gap-2 gap-md-3">
                    <div className="form-check form-switch mb-0">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        role="switch"
                        id="bulk-show-mp-ozon"
                        checked={showMpOzon}
                        onChange={(e) => setShowMpOzon(e.target.checked)}
                      />
                      <label className="form-check-label small mb-0 text-nowrap" htmlFor="bulk-show-mp-ozon" title="Столбцы JSON-атрибутов Ozon">
                        Атрибуты Ozon
                      </label>
                    </div>
                    <div className="form-check form-switch mb-0">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        role="switch"
                        id="bulk-show-mp-wb"
                        checked={showMpWb}
                        onChange={(e) => setShowMpWb(e.target.checked)}
                      />
                      <label className="form-check-label small mb-0 text-nowrap" htmlFor="bulk-show-mp-wb" title="Столбцы JSON-атрибутов Wildberries">
                        Атрибуты WB
                      </label>
                    </div>
                    <div className="form-check form-switch mb-0">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        role="switch"
                        id="bulk-show-mp-ym"
                        checked={showMpYm}
                        onChange={(e) => setShowMpYm(e.target.checked)}
                      />
                      <label className="form-check-label small mb-0 text-nowrap" htmlFor="bulk-show-mp-ym" title="Столбцы JSON-атрибутов Яндекс.Маркет">
                        Атрибуты Я.Маркет
                      </label>
                    </div>
                    {mpAttrColumnDefs.length > 0 ? (
                      <span
                        className="text-muted small text-nowrap"
                        title="Число видимых столбцов по JSON-атрибутам маркетплейсов (включённые тумблеры)"
                      >
                        {visibleMpAttrColumnDefs.length > 0
                          ? `столбцов МП: ${visibleMpAttrColumnDefs.length}`
                          : 'атрибуты МП скрыты'}
                      </span>
                    ) : (
                      <span className="text-muted small text-nowrap">атрибуты МП не найдены</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

      <div className="products-bulk-scroll-region">

          {loading ? (
            <p className="text-muted mb-0">Загрузка товаров…</p>
          ) : rows.length === 0 ? (
            <p className="text-muted mb-0">
              Нет товаров для отображения.{' '}
              <button
                type="button"
                className="btn btn-link btn-sm p-0 align-baseline"
                onClick={() => navigate('/products')}
              >
                Перейти в «Товары»
              </button>
              {', при необходимости выберите строки или задайте фильтры.'}
            </p>
          ) : (
            <div className="products-bulk-table-xclip">
            <div className="products-bulk-table-wrap">
          <table className="products-bulk-table">
            <thead>
              <tr>
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    className={`${col.key === 'sku' ? 'sticky-col-sku' : ''} ${col.headerClass || ''}`.trim()}
                    style={{ minWidth: col.minW }}
                    title={col.title || undefined}
                  >
                    {col.label}
                    {col.hint ? (
                      <span className="text-muted fw-normal d-block" style={{ fontSize: 10 }}>
                        {col.hint}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
              <tr className="bulk-actions-row">
                {visibleColumns.map((col) => (
                  <th
                    key={`bulk-${col.key}`}
                    className={`${col.key === 'sku' ? 'sticky-col-sku' : ''} ${col.headerClass || ''}`.trim()}
                    style={{ minWidth: col.minW }}
                    title={col.title || undefined}
                  >
                    {col.readonly || col.noBulk ? (
                      <span className="text-muted" style={{ fontSize: 10 }}>
                        —
                      </span>
                    ) : (
                      <button type="button" className="products-bulk-fill-btn" onClick={() => openBulk(col)}>
                        Заполнить массово
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {visibleColumns.map((col) => {
                    if (col.key === 'id') {
                      return (
                        <td key={col.key} className="text-muted">
                          {row.id}
                        </td>
                      );
                    }
                    if (col.key === '_photo') {
                      const url = getPrimaryProductImageUrl(row._productRef);
                      return (
                        <td key={col.key}>
                          <div className="products-bulk-thumb">
                            {url ? <img src={url} alt="" loading="lazy" /> : <span>∅</span>}
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} className={col.key === 'sku' ? 'sticky-col-sku' : undefined} style={{ minWidth: col.minW }}>
                        {renderInput(col, row)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
            </div>
            </div>
      )}
      </div>

      <Modal
        isOpen={bulkModal.open && bulkModalCol != null}
        onClose={() => setBulkModal({ open: false, column: null })}
        title={bulkModalCol ? `Массово: ${bulkModalCol.label}` : ''}
        size="large"
      >
        {bulkModalCol ? (
          <div>
            <p className="text-muted small">
              Значение будет применено ко <strong>всем</strong> строкам в таблице ({rows.length} товаров).
            </p>
            {bulkModalCol.input === 'textarea' || bulkModalCol.mpAttr ? (
              <textarea
                className="form-control products-bulk-modal-field"
                value={bulkDraft}
                onChange={(e) => setBulkDraft(e.target.value)}
                rows={6}
                autoFocus
              />
            ) : bulkModalCol.input === 'number' ? (
              <input
                className="form-control products-bulk-modal-field"
                type="text"
                inputMode="decimal"
                value={bulkDraft}
                onChange={(e) => setBulkDraft(e.target.value)}
                autoFocus
              />
            ) : bulkModalCol.input === 'select_type' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="">— не менять тип (выберите)</option>
                <option value="product">Товар</option>
                <option value="kit">Комплект</option>
              </select>
            ) : bulkModalCol.input === 'select_category' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="">— без категории</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : bulkModalCol.input === 'select_org' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="">— без организации</option>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="form-control products-bulk-modal-field"
                type="text"
                value={bulkDraft}
                onChange={(e) => setBulkDraft(e.target.value)}
                autoFocus
              />
            )}
            <div className="d-flex justify-content-end gap-2 mt-3">
              <Button type="button" variant="secondary" size="small" onClick={() => setBulkModal({ open: false, column: null })}>
                Отмена
              </Button>
              <Button
                type="button"
                variant="primary"
                size="small"
                onClick={applyBulk}
                disabled={bulkModalCol.input === 'select_type' && bulkDraft === ''}
              >
                Применить ко всем строкам
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {!loading && rows.length > 0 ? (
        <div className="products-bulk-floating-save">
          <div className="products-bulk-floating-save-inner">
            <span className="text-muted small">
              Строк в таблице: <strong>{rows.length}</strong>
            </span>
            <Button
              className="btn-shadow ms-auto"
              variant="primary"
              size="small"
              type="button"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Сохранение…' : 'Сохранить изменения'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
