/**
 * Массовое редактирование товаров: таблица полей + «Заполнить» по столбцам.
 */

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { productsApi } from '../../services/products.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { useCategories } from '../../hooks/useCategories';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useBrands } from '../../hooks/useBrands';
import {
  getPrimaryProductImageUrl,
  parseProductImages,
  normalizeProductImagesOrder,
  extractImagesFromApiPayload,
  filterDroppedImageFiles,
  resolveProductImageUrl,
} from '../../utils/productImage.js';
import { barcodeStringsFromProduct } from '../../utils/productBarcodes.js';
import {
  getMpDraftDimensionsMm,
  getYmDraftWeightDimensions,
  ymWeightDimensionsToErp,
  gramsToKg,
  kgToGrams,
  normalizeMpFieldLinks,
  isMpFieldLinked,
  setMpFieldLink,
  emptyMpFieldLinks,
  getMpDraftProductDimensionsMm,
} from '../../utils/productMpFieldLinks.js';
import {
  isOzonPackagingDimensionsLocked,
  OZON_DIMS_LOCK_TITLE,
} from '../../utils/ozonDimensionsLock.js';
import { MarketplaceToggle } from '../../components/common/MarketplaceToggle/MarketplaceToggle.jsx';
import { MpFieldLinkToggles } from '../../components/common/MpFieldLinkToggles/MpFieldLinkToggles.jsx';
import {
  getProfileLengthUnit,
  getProfileWeightUnit,
  lengthMmToDisplay,
  lengthDisplayToMm,
  weightGToDisplay,
  weightDisplayToG,
  lengthUnitLabel,
  weightUnitLabel,
  lengthCmToDisplay,
  lengthDisplayToCm,
} from '../../utils/displayUnits.js';
import {
  WB_ITEM_DIM_CHARC,
  WB_PACK_DIM_CHARC,
  classifyMarketplaceDimAttrName,
} from '../../utils/marketplaceDimensions.js';
import { userCategoriesApi } from '../../services/userCategories.api';
import { integrationsApi } from '../../services/integrations.api.js';
import {
  FILTER_CATEGORY_NONE,
  fetchHasUncategorizedProducts,
} from '../../utils/uncategorizedCategoryFilter.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { isProfileKitsEnabled, isProfileProductSupplierBindingEnabled } from '../../utils/profileFlags.js';
import { useSuppliers } from '../../hooks/useSuppliers';
import './ProductsBulkEdit.css';
import './Products.css';

/** Тумблеры фильтра связи с МП (как на странице «Товары»). */
const MP_LINK_FILTER_TOGGLES = [
  { code: 'ozon', label: 'OZ', name: 'Ozon', color: '#005bff' },
  { code: 'wb', label: 'WB', name: 'Wildberries', color: '#cb11ab' },
  { code: 'ym', label: 'ЯМ', name: 'Яндекс.Маркет', color: '#fc3f1d' },
];

function mpFilterSetFromState(raw) {
  if (raw instanceof Set) return new Set([...raw].map((x) => String(x).toLowerCase()));
  if (Array.isArray(raw)) {
    return new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  }
  if (raw != null && String(raw).trim() !== '') {
    return new Set(
      String(raw)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return new Set();
}

/** Алиасы габаритов товара (ERP + зеркала во вкладках МП) — одно значение на все. */
const PRODUCT_DIM_ALIAS = {
  product_length: [
    'product_length',
    'ozon_product_length',
    'wb_product_length',
    'ym_product_length',
  ],
  product_width: [
    'product_width',
    'ozon_product_width',
    'wb_product_width',
    'ym_product_width',
  ],
  product_height: [
    'product_height',
    'ozon_product_height',
    'wb_product_height',
    'ym_product_height',
  ],
  product_weight: [
    'product_weight',
    'ozon_product_weight',
    'wb_product_weight',
    'ym_product_weight',
  ],
};

function productDimBaseKey(key) {
  const k = String(key || '');
  if (k.endsWith('product_length') || k === 'product_length') return 'product_length';
  if (k.endsWith('product_width') || k === 'product_width') return 'product_width';
  if (k.endsWith('product_height') || k === 'product_height') return 'product_height';
  if (k.endsWith('product_weight') || k === 'product_weight') return 'product_weight';
  return null;
}

function productDimMpFromAlias(aliasKey) {
  const k = String(aliasKey || '');
  if (k.startsWith('ozon_')) return 'ozon';
  if (k.startsWith('wb_')) return 'wb';
  if (k.startsWith('ym_')) return 'ym';
  return null;
}

function withSyncedProductDims(row, key, value) {
  const base = productDimBaseKey(key);
  if (!base) return { ...row, [key]: value };
  const next = { ...row, [key]: value };
  const links = normalizeMpFieldLinks(next.mp_field_links);
  const editedMp = productDimMpFromAlias(key);
  const aliases = PRODUCT_DIM_ALIAS[base] || [];

  if (!editedMp) {
    next[base] = value;
    for (const alias of aliases) {
      if (alias === base) continue;
      const mp = productDimMpFromAlias(alias);
      if (mp && isMpFieldLinked(links, 'product_dimensions', mp)) {
        next[alias] = value;
      }
    }
    return next;
  }

  if (!isMpFieldLinked(links, 'product_dimensions', editedMp)) {
    return next;
  }
  next[base] = value;
  for (const alias of aliases) {
    if (alias === key) continue;
    const mp = productDimMpFromAlias(alias);
    if (!mp) {
      next[alias] = value;
      continue;
    }
    if (mp === editedMp || isMpFieldLinked(links, 'product_dimensions', mp)) {
      next[alias] = value;
    }
  }
  return next;
}

/** Колонки «Основное» ↔ МП для связанных полей (как в карточке). */
const BULK_NAME_COLS = {
  main: 'name',
  ozon: 'mp_ozon_name',
  wb: 'mp_wb_name',
  ym: 'mp_ym_name',
};
const BULK_DESC_COLS = {
  main: 'description',
  ozon: 'mp_ozon_description',
  wb: 'mp_wb_description',
  ym: 'mp_ym_description',
};
const BULK_BRAND_COLS = {
  main: 'brand',
  ozon: 'mp_ozon_brand',
  wb: 'mp_wb_brand',
};
const BULK_COUNTRY_COLS = {
  main: 'country_of_origin',
  ozon: 'ozon_country',
  wb: 'wb_country',
  ym: 'ym_country',
};
const BULK_DIM_KEYS = ['length', 'width', 'height', 'weight'];
const BULK_PACK_COLS = {
  ozon: {
    length: 'ozon_pack_length',
    width: 'ozon_pack_width',
    height: 'ozon_pack_height',
    weight: 'ozon_pack_weight',
  },
  wb: {
    length: 'wb_pack_length',
    width: 'wb_pack_width',
    height: 'wb_pack_height',
    weight: 'wb_pack_weight',
  },
  ym: {
    length: 'ym_pack_length',
    width: 'ym_pack_width',
    height: 'ym_pack_height',
    weight: 'ym_pack_weight',
  },
};

function bulkLinkFieldForColumn(colKey) {
  const k = String(colKey || '');
  if (k === 'name' || k === 'mp_ozon_name' || k === 'mp_wb_name' || k === 'mp_ym_name') return 'name';
  if (
    k === 'description' ||
    k === 'mp_ozon_description' ||
    k === 'mp_wb_description' ||
    k === 'mp_ym_description'
  ) {
    return 'description';
  }
  if (k === 'brand' || k === 'mp_ozon_brand' || k === 'mp_wb_brand') return 'brand';
  if (
    k === 'country_of_origin' ||
    k === 'ozon_country' ||
    k === 'wb_country' ||
    k === 'ym_country'
  ) {
    return 'country';
  }
  if (productDimBaseKey(k)) return 'product_dimensions';
  if (BULK_DIM_KEYS.includes(k)) return 'dimensions';
  for (const mp of ['ozon', 'wb', 'ym']) {
    const pack = BULK_PACK_COLS[mp];
    if (Object.values(pack).includes(k)) return 'dimensions';
  }
  return null;
}

function bulkMpCodeForColumn(colKey) {
  const k = String(colKey || '');
  if (
    k.startsWith('mp_ozon_') ||
    k.startsWith('ozon_pack_') ||
    k.startsWith('ozon_product_') ||
    k === 'ozon_country'
  ) {
    return 'ozon';
  }
  if (
    k.startsWith('mp_wb_') ||
    k.startsWith('wb_pack_') ||
    k.startsWith('wb_product_') ||
    k === 'wb_country'
  ) {
    return 'wb';
  }
  if (
    k.startsWith('mp_ym_') ||
    k.startsWith('ym_pack_') ||
    k.startsWith('ym_product_') ||
    k === 'ym_country'
  ) {
    return 'ym';
  }
  return null;
}

/** Ячейка МП связана с «Основным» — в UI показываем зеркало Main, правка отвязывает. */
function isBulkLinkedMpReadonly(row, colKey) {
  const fieldKey = bulkLinkFieldForColumn(colKey);
  const mp = bulkMpCodeForColumn(colKey);
  if (!fieldKey || !mp) return false;
  return isMpFieldLinked(normalizeMpFieldLinks(row?.mp_field_links), fieldKey, mp);
}

/** Значение колонки МП при включённой связи: как на «Основном». */
function bulkLinkedMirrorValue(row, colKey) {
  const fieldKey = bulkLinkFieldForColumn(colKey);
  if (fieldKey === 'name') return row.name ?? '';
  if (fieldKey === 'description') return row.description ?? '';
  if (fieldKey === 'brand') return row.brand ?? '';
  if (fieldKey === 'country') return row.country_of_origin ?? '';
  if (fieldKey === 'dimensions') {
    const dimKey = BULK_DIM_KEYS.find((d) => colKey === d || String(colKey).endsWith(`_pack_${d}`));
    return dimKey ? row[dimKey] ?? '' : row[colKey];
  }
  if (fieldKey === 'product_dimensions') {
    const base = productDimBaseKey(colKey);
    return base ? row[base] ?? '' : row[colKey];
  }
  return row[colKey];
}

function copyMainNameToMp(row, mp) {
  const col = BULK_NAME_COLS[mp];
  if (!col) return row;
  return { ...row, [col]: row.name ?? '' };
}

function copyMainDescToMp(row, mp) {
  const col = BULK_DESC_COLS[mp];
  if (!col) return row;
  return { ...row, [col]: row.description ?? '' };
}

function copyMainBrandToMp(row, mp) {
  const col = BULK_BRAND_COLS[mp];
  if (!col) return row;
  return { ...row, [col]: row.brand ?? '' };
}

function copyMainCountryToMp(row, mp) {
  const col = BULK_COUNTRY_COLS[mp];
  if (!col) return row;
  return { ...row, [col]: row.country_of_origin ?? '' };
}

function copyMainDimsToMp(row, mp) {
  const pack = BULK_PACK_COLS[mp];
  if (!pack) return row;
  const next = { ...row };
  for (const dim of BULK_DIM_KEYS) {
    next[pack[dim]] = row[dim] ?? '';
  }
  return next;
}

function copyMainProductDimsToMp(row, mp) {
  const next = { ...row };
  for (const base of Object.keys(PRODUCT_DIM_ALIAS)) {
    const aliases = PRODUCT_DIM_ALIAS[base];
    const mpAlias = aliases.find((a) => productDimMpFromAlias(a) === mp);
    if (mpAlias) next[mpAlias] = row[base] ?? '';
  }
  return next;
}

function copyMainFieldToMp(row, fieldKey, mp) {
  if (fieldKey === 'name') return copyMainNameToMp(row, mp);
  if (fieldKey === 'description') return copyMainDescToMp(row, mp);
  if (fieldKey === 'brand') return copyMainBrandToMp(row, mp);
  if (fieldKey === 'country') return copyMainCountryToMp(row, mp);
  if (fieldKey === 'dimensions') return copyMainDimsToMp(row, mp);
  if (fieldKey === 'product_dimensions') return copyMainProductDimsToMp(row, mp);
  return row;
}

/**
 * После правки ячейки: при активной связи копируем значение в «Основное» и связанные МП.
 * Единицы в таблице уже display — ozon/wb/ym pack совпадают с ERP-колонками.
 */
function withSyncedLinkedFields(row, key, value) {
  const fieldKey = bulkLinkFieldForColumn(key);
  const editedMp = bulkMpCodeForColumn(key);
  const links0 = normalizeMpFieldLinks(row.mp_field_links);

  // Правка колонки МП при связи — отвязать этот МП и писать только в него (как «свои» название/описание).
  if (fieldKey && editedMp && isMpFieldLinked(links0, fieldKey, editedMp)) {
    const next = {
      ...row,
      mp_field_links: setMpFieldLink(row.mp_field_links, fieldKey, editedMp, false),
      [key]: value,
    };
    if (fieldKey === 'product_dimensions') return withSyncedProductDims(next, key, value);
    return next;
  }

  let next = withSyncedProductDims(row, key, value);
  if (!fieldKey || fieldKey === 'product_dimensions') return next;
  const links = normalizeMpFieldLinks(next.mp_field_links);

  const syncScalar = (mainKey, colsByMp) => {
    if (!editedMp) {
      for (const mp of Object.keys(colsByMp)) {
        if (mp === 'main') continue;
        if (isMpFieldLinked(links, fieldKey, mp)) next[colsByMp[mp]] = value;
      }
    } else if (isMpFieldLinked(links, fieldKey, editedMp)) {
      next[mainKey] = value;
      for (const mp of Object.keys(colsByMp)) {
        if (mp === 'main' || mp === editedMp) continue;
        if (isMpFieldLinked(links, fieldKey, mp)) next[colsByMp[mp]] = value;
      }
    }
  };

  if (fieldKey === 'name') {
    syncScalar('name', BULK_NAME_COLS);
    return next;
  }

  if (fieldKey === 'description') {
    syncScalar('description', BULK_DESC_COLS);
    return next;
  }

  if (fieldKey === 'brand') {
    syncScalar('brand', BULK_BRAND_COLS);
    return next;
  }

  if (fieldKey === 'country') {
    syncScalar('country_of_origin', BULK_COUNTRY_COLS);
    return next;
  }

  if (fieldKey === 'dimensions') {
    const dimKey = BULK_DIM_KEYS.find((d) => key === d || key.endsWith(`_pack_${d}`));
    if (!dimKey) return next;
    if (!editedMp) {
      for (const mp of ['ozon', 'wb', 'ym']) {
        if (isMpFieldLinked(links, 'dimensions', mp)) {
          next[BULK_PACK_COLS[mp][dimKey]] = value;
        }
      }
    } else if (isMpFieldLinked(links, 'dimensions', editedMp)) {
      next[dimKey] = value;
      for (const mp of ['ozon', 'wb', 'ym']) {
        if (mp !== editedMp && isMpFieldLinked(links, 'dimensions', mp)) {
          next[BULK_PACK_COLS[mp][dimKey]] = value;
        }
      }
    }
  }
  return next;
}

function linksSignature(links) {
  return JSON.stringify(normalizeMpFieldLinks(links));
}

const BULK_PAGE_SIZES = [100, 200, 300, 500, 1000];
const BULK_PAGE_SIZE_LS = 'productsBulkEditPageSize';
const SESSION_MP_OZON = 'productsBulkShowMpOzon';
const SESSION_MP_WB = 'productsBulkShowMpWb';
const SESSION_MP_YM = 'productsBulkShowMpYm';
/** Закреплённые столбцы (ключи), сразу справа от артикула */
const SESSION_PINNED_COLS = 'productsBulkPinnedCols';
/** Скрытые столбцы (ключи) */
const SESSION_HIDDEN_COLS = 'productsBulkHiddenCols';
/** Базовый sticky-столбец — всегда слева, пользовательские пины не левее него */
const DEFAULT_STICKY_COL_KEY = 'sku';
/** Выбор строк для выгрузки/загрузки с МП (всегда первый sticky) */
const SELECT_COL_KEY = '_select';
const SELECT_COL = {
  key: SELECT_COL_KEY,
  label: '',
  readonly: true,
  noBulk: true,
  width: 42,
  minW: 42,
  headerClass: 'products-bulk-select-col',
};
/** Столбцы, которые нельзя скрыть */
const ALWAYS_VISIBLE_COL_KEYS = new Set([SELECT_COL_KEY, DEFAULT_STICKY_COL_KEY]);
const PACK_DIM_COL_KEYS = new Set([
  'length',
  'width',
  'height',
  'weight',
  'ozon_pack_length',
  'ozon_pack_width',
  'ozon_pack_height',
  'ozon_pack_weight',
]);

function columnSearchHaystack(col) {
  const mp =
    col?.mpBucket === 'ozon'
      ? 'ozon'
      : col?.mpBucket === 'wb'
        ? 'wb wildberries'
        : col?.mpBucket === 'ym'
          ? 'ym яндекс ям'
          : '';
  return [col?.label, col?.title, col?.key, mp].filter(Boolean).join(' ').toLowerCase();
}

function columnMatchesSearchQuery(col, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return true;
  return columnSearchHaystack(col).includes(q);
}

function isPackDimColumnKey(key) {
  return PACK_DIM_COL_KEYS.has(String(key || ''));
}
/** Старый один тумблер — мигрируем в три флага по МП */
const SESSION_SHOW_MP_ATTRS_LEGACY = 'productsBulkShowMpAttrs';
/** Стартовый выбор категории: ещё не выбрано / все категории */
const CATEGORY_SCOPE_UNSET = '__unset__';
const CATEGORY_SCOPE_ALL = '__all__';

function readBulkPageSize() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BULK_PAGE_SIZE_LS) : null;
    const n = parseInt(raw, 10);
    return BULK_PAGE_SIZES.includes(n) ? n : 100;
  } catch {
    return 100;
  }
}

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

function readPinnedColumnKeys() {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(SESSION_PINNED_COLS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((k) => String(k || '').trim())
      .filter((k) => k && k !== DEFAULT_STICKY_COL_KEY && k !== SELECT_COL_KEY);
  } catch {
    return [];
  }
}

function readHiddenColumnKeys() {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(SESSION_HIDDEN_COLS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((k) => String(k || '').trim())
      .filter((k) => k && !ALWAYS_VISIBLE_COL_KEYS.has(k));
  } catch {
    return [];
  }
}

function colStickyWidthPx(col) {
  const w = Number(col?.width);
  if (Number.isFinite(w) && w > 0) return w;
  const m = Number(col?.minW);
  if (Number.isFinite(m) && m > 0) return m;
  return 120;
}

/**
 * Артикул всегда слева; закреплённые — сразу после него; остальные в исходном порядке.
 */
function orderColumnsWithPins(cols, pinnedKeys) {
  const list = Array.isArray(cols) ? cols : [];
  const byKey = new Map(list.map((c) => [c.key, c]));
  const base = byKey.get(DEFAULT_STICKY_COL_KEY);
  const pinned = [];
  const pinnedSet = new Set([DEFAULT_STICKY_COL_KEY]);
  for (const key of pinnedKeys || []) {
    if (!key || pinnedSet.has(key)) continue;
    const col = byKey.get(key);
    if (!col) continue;
    pinned.push(col);
    pinnedSet.add(key);
  }
  const rest = list.filter((c) => !pinnedSet.has(c.key));
  const out = [];
  if (base) out.push(base);
  out.push(...pinned);
  out.push(...rest);
  return out;
}

function buildStickyLeftMap(displayCols, pinnedKeys) {
  const pinnedSet = new Set(
    (pinnedKeys || []).filter((k) => k && k !== DEFAULT_STICKY_COL_KEY && k !== SELECT_COL_KEY)
  );
  const stickyKeys = [];
  for (const col of displayCols || []) {
    if (
      col.key === SELECT_COL_KEY ||
      col.key === DEFAULT_STICKY_COL_KEY ||
      pinnedSet.has(col.key)
    ) {
      stickyKeys.push(col.key);
    } else {
      break; // sticky-блок всегда префикс: галочка + артикул + пины
    }
  }
  const map = new Map();
  let left = 0;
  stickyKeys.forEach((key, i) => {
    const col = displayCols.find((c) => c.key === key);
    const width = colStickyWidthPx(col);
    map.set(key, {
      left,
      width,
      /* выше обычных ячеек (0) и thead без pin (3), левее — выше соседей */
      zIndex: 40 - i,
      isLast: i === stickyKeys.length - 1,
      isBase: key === DEFAULT_STICKY_COL_KEY,
    });
    left += width;
  });
  return map;
}

/** Базовые столбцы: порядок — основная карточка (артикулы → названия/бренд → описание → габариты → прочее),
 *  затем Ozon, затем WB, затем Я.Маркет (в каждом блоке: артикулы → название → описание → бренд и т.д.).
 *  JSON-атрибуты МП добавляются динамически после этих колонок (там же: Ozon, WB, ЯМ). */
const COLUMNS = [
  /* ——— основная карточка (ERP) ——— */
  /* артикулы / идентификаторы */
  { key: 'sku', label: 'Артикул', input: 'text', minW: 120 },
  { key: 'barcodes', label: 'ШК', title: 'Штрихкоды', input: 'textarea', minW: 120, hint: 'Через запятую или с новой строки' },
  { key: 'id', label: 'ID', readonly: true, noBulk: true, width: 56, minW: 56 },
  {
    key: '_photo',
    label: 'Фото',
    title: 'Изображения · в окне фото: OZ/WB/ЯМ — на какие МП отправлять при выгрузке',
    readonly: true,
    noBulk: true,
    width: 64,
    minW: 64,
  },
  /* названия */
  { key: 'name', label: 'Название', input: 'textarea', minW: 160, linkFieldKey: 'name' },
  { key: 'brand', label: 'Бренд', title: 'Основное · Бренд. Тумблеры OZ/WB связывают бренд с МП', input: 'text', minW: 90, linkFieldKey: 'brand' },
  /* описание */
  { key: 'description', label: 'Описание', input: 'textarea', minW: 160, linkFieldKey: 'description' },
  /* габариты товара (без упаковки) — вкладка «Основное» */
  { key: 'product_length', label: 'Дл. тов.', title: 'Основное · Длина товара. Тумблеры OZ/WB/ЯМ связывают размеры товара с МП', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'product_dimensions' },
  { key: 'product_width', label: 'Ш. тов.', title: 'Основное · Ширина товара. Тумблеры OZ/WB/ЯМ связывают размеры товара с МП', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'product_dimensions' },
  { key: 'product_height', label: 'В. тов.', title: 'Основное · Высота товара. Тумблеры OZ/WB/ЯМ связывают размеры товара с МП', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'product_dimensions' },
  { key: 'product_weight', label: 'Вес тов.', title: 'Основное · Вес товара. Тумблеры OZ/WB/ЯМ связывают размеры товара с МП', input: 'number', minW: 88, dimKind: 'weight', linkFieldKey: 'product_dimensions' },
  /* габариты упаковки — связь с МП через тумблеры OZ/WB/ЯМ в заголовке */
  { key: 'length', label: 'Дл. уп.', title: 'Основное · Длина упаковки. Тумблеры OZ/WB/ЯМ связывают все габариты упаковки (Д×Ш×В×вес) с МП', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'width', label: 'Ш. уп.', title: 'Основное · Ширина упаковки. Тумблеры OZ/WB/ЯМ связывают все габариты упаковки с МП', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'height', label: 'В. уп.', title: 'Основное · Высота упаковки. Тумблеры OZ/WB/ЯМ связывают все габариты упаковки с МП', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'weight', label: 'Вес уп.', title: 'Основное · Вес с упаковкой. Тумблеры OZ/WB/ЯМ связывают все габариты упаковки с МП', input: 'number', minW: 88, dimKind: 'weight', linkFieldKey: 'dimensions' },
  /* остальное */
  { key: 'product_type', label: 'Тип', input: 'select_type', minW: 80 },
  { key: 'categoryId', label: 'Кат.', title: 'Категория', input: 'select_category', minW: 120 },
  { key: 'organizationId', label: 'Орг.', title: 'Организация', input: 'select_org', minW: 120 },
  { key: 'supplierId', label: 'Пост.', title: 'Поставщик', input: 'select_supplier', minW: 120 },
  { key: 'cost', label: 'Себест.', title: 'Себестоимость', input: 'number', minW: 80 },
  { key: 'additionalExpenses', label: 'Доп. р.', title: 'Доп. расходы', input: 'number', minW: 80 },
  { key: 'minPrice', label: 'Мин. ц.', title: 'Мин. цена', input: 'number', minW: 72 },
  { key: 'buyout_rate', label: 'Выкуп %', input: 'number', minW: 72 },
  { key: 'country_of_origin', label: 'Страна', title: 'Основное · Страна производителя. Тумблеры OZ/WB/ЯМ связывают страну с МП', input: 'text', minW: 80, linkFieldKey: 'country' },
  /* ——— Ozon ——— */
  { key: 'mp_ozon_name', label: 'Название', title: 'Ozon · Название', input: 'textarea', minW: 140, mpBucket: 'ozon', linkFieldKey: 'name' },
  { key: 'mp_ozon_description', label: 'Описание', title: 'Ozon · Описание', input: 'textarea', minW: 140, mpBucket: 'ozon', linkFieldKey: 'description' },
  { key: 'sku_ozon', label: 'offer_id', title: 'Ozon · offer_id', input: 'text', minW: 90, mpBucket: 'ozon' },
  { key: 'ozon_product_id', label: 'product_id', title: 'Ozon · product_id', input: 'text', minW: 90, mpBucket: 'ozon' },
  { key: 'ozon_product_length', label: 'Дл. тов.', title: 'Ozon · Длина товара', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length' },
  { key: 'ozon_product_width', label: 'Ш. тов.', title: 'Ozon · Ширина товара', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length' },
  { key: 'ozon_product_height', label: 'В. тов.', title: 'Ozon · Высота товара', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length' },
  { key: 'ozon_product_weight', label: 'Вес тов.', title: 'Ozon · Вес товара', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'weight' },
  { key: 'ozon_pack_length', label: 'Дл. уп.', title: 'Ozon · Длина упаковки', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length' },
  { key: 'ozon_pack_width', label: 'Ш. уп.', title: 'Ozon · Ширина упаковки', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length' },
  { key: 'ozon_pack_height', label: 'В. уп.', title: 'Ozon · Высота упаковки', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length' },
  { key: 'ozon_pack_weight', label: 'Вес уп.', title: 'Ozon · Вес с упаковкой', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'weight' },
  { key: 'mp_ozon_brand', label: 'Бренд', title: 'Ozon · Бренд', input: 'text', minW: 90, mpBucket: 'ozon' },
  { key: 'ozon_country', label: 'Страна', title: 'Ozon · Страна производителя', input: 'text', minW: 80, mpBucket: 'ozon' },
  /* ——— Wildberries ——— */
  { key: 'mp_wb_name', label: 'Название', title: 'Wildberries · Название', input: 'textarea', minW: 140, mpBucket: 'wb', linkFieldKey: 'name' },
  { key: 'mp_wb_description', label: 'Описание', title: 'Wildberries · Описание', input: 'textarea', minW: 140, mpBucket: 'wb', linkFieldKey: 'description' },
  { key: 'sku_wb', label: 'nmId', title: 'Wildberries · nmId', input: 'text', minW: 80, mpBucket: 'wb' },
  { key: 'mp_wb_vendor_code', label: 'Арт. прод.', title: 'Wildberries · Артикул продавца', input: 'text', minW: 100, mpBucket: 'wb' },
  { key: 'wb_product_length', label: 'Дл. тов.', title: 'Wildberries · Длина товара', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length' },
  { key: 'wb_product_width', label: 'Ш. тов.', title: 'Wildberries · Ширина товара', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length' },
  { key: 'wb_product_height', label: 'В. тов.', title: 'Wildberries · Высота товара', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length' },
  { key: 'wb_product_weight', label: 'Вес тов.', title: 'Wildberries · Вес товара', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'weight' },
  { key: 'wb_pack_length', label: 'Дл. уп.', title: 'Wildberries · Длина упаковки', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length' },
  { key: 'wb_pack_width', label: 'Ш. уп.', title: 'Wildberries · Ширина упаковки', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length' },
  { key: 'wb_pack_height', label: 'В. уп.', title: 'Wildberries · Высота упаковки', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length' },
  { key: 'wb_pack_weight', label: 'Вес уп.', title: 'Wildberries · Вес с упаковкой', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'weight' },
  { key: 'mp_wb_brand', label: 'Бренд', title: 'Wildberries · Бренд', input: 'text', minW: 90, mpBucket: 'wb' },
  { key: 'wb_country', label: 'Страна', title: 'Wildberries · Страна производителя', input: 'text', minW: 80, mpBucket: 'wb' },
  /* ——— Яндекс.Маркет ——— */
  { key: 'mp_ym_name', label: 'Название', title: 'Яндекс.Маркет · Название', input: 'textarea', minW: 140, mpBucket: 'ym', linkFieldKey: 'name' },
  { key: 'mp_ym_description', label: 'Описание', title: 'Яндекс.Маркет · Описание', input: 'textarea', minW: 140, mpBucket: 'ym', linkFieldKey: 'description' },
  { key: 'sku_ym', label: 'offerId', title: 'Яндекс.Маркет · offerId', input: 'text', minW: 90, mpBucket: 'ym' },
  { key: 'ym_product_length', label: 'Дл. тов.', title: 'Яндекс.Маркет · Длина товара', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length' },
  { key: 'ym_product_width', label: 'Ш. тов.', title: 'Яндекс.Маркет · Ширина товара', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length' },
  { key: 'ym_product_height', label: 'В. тов.', title: 'Яндекс.Маркет · Высота товара', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length' },
  { key: 'ym_product_weight', label: 'Вес тов.', title: 'Яндекс.Маркет · Вес товара', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'weight' },
  { key: 'ym_pack_length', label: 'Дл. уп.', title: 'Яндекс.Маркет · Длина упаковки', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length' },
  { key: 'ym_pack_width', label: 'Ш. уп.', title: 'Яндекс.Маркет · Ширина упаковки', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length' },
  { key: 'ym_pack_height', label: 'В. уп.', title: 'Яндекс.Маркет · Высота упаковки', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length' },
  { key: 'ym_pack_weight', label: 'Вес уп.', title: 'Яндекс.Маркет · Вес с упаковкой', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'weight' },
  { key: 'ym_country', label: 'Страна', title: 'Яндекс.Маркет · Страна производителя', input: 'text', minW: 80, mpBucket: 'ym' },
];

function withDisplayUnitLabels(cols, lengthUnit, weightUnit) {
  const L = lengthUnitLabel(lengthUnit);
  const W = weightUnitLabel(weightUnit);
  return (cols || []).map((c) => {
    const strip = (s) =>
      String(s || '')
        .replace(/\s*\((мм|см|г|кг)\)\s*$/i, '')
        .trim();
    if (c.dimKind === 'length') {
      const base = strip(c.label);
      const baseTitle = strip(c.title || c.label);
      return {
        ...c,
        label: `${base} (${L})`,
        title: `${baseTitle} (${L})`,
      };
    }
    if (c.dimKind === 'weight') {
      const base = strip(c.label);
      const baseTitle = strip(c.title || c.label);
      return {
        ...c,
        label: `${base} (${W})`,
        title: `${baseTitle} (${W})`,
      };
    }
    // JSON-атрибуты габаритов/веса — тоже с единицами
    const human = String(c._humanName || c.label || '');
    const h = human.toLowerCase();
    if (!c.mpAttr) return c;
    const base = strip(c.label);
    if (/(длина|ширина|высота|глубина)/.test(h) && !/вес/.test(h)) {
      return { ...c, label: `${base} (${L})`, title: `${strip(c.title || base)} (${L})` };
    }
    if (/вес/.test(h)) {
      return { ...c, label: `${base} (${W})`, title: `${strip(c.title || base)} (${W})` };
    }
    return c;
  });
}

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
  if (typeof v === 'object') {
    if (v.dictionary_value_id != null || v.value != null) {
      const text =
        v.value != null && String(v.value).trim() !== ''
          ? String(v.value).trim()
          : '';
      const did =
        v.dictionary_value_id != null
          ? String(v.dictionary_value_id).trim()
          : '';
      if (text && did && text !== did) return text;
      if (text) return text;
      return did;
    }
    return JSON.stringify(v);
  }
  return formatOzonAttrDisplayValue(String(v));
}

/** Для ячеек Ozon: «Китай->90296» → «Китай»; голый id оставляем. */
function formatOzonAttrDisplayValue(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  const arrow = t.indexOf('->');
  if (arrow > 0) {
    const label = t.slice(0, arrow).trim();
    if (label) return label;
  }
  const compound = t.match(/^\d+\s*[—–-]\s*(.+)$/);
  if (compound) return compound[1].trim();
  return t;
}

/**
 * Разбор значения ячейки атрибута МП.
 * Ozon — только string | number; WB/ЯМ — ещё boolean.
 * Если в baseline было «Текст->id», а пользователь оставил тот же текст — сохраняем составное значение.
 */
function parseMpAttrCellValue(text, bucket, baselineRaw) {
  const t = String(text ?? '').trim();
  if (t === '') return undefined;
  const lower = t.toLowerCase();
  if (bucket !== 'ozon' && (lower === 'true' || lower === 'false')) {
    return lower === 'true';
  }
  if (bucket === 'ozon') {
    const base = String(baselineRaw ?? '').trim();
    const arrow = base.indexOf('->');
    if (arrow > 0) {
      const baseLabel = base.slice(0, arrow).trim();
      const baseId = base.slice(arrow + 2).trim();
      if (baseLabel && baseId && (t === baseLabel || t === base)) {
        return `${baseLabel}->${baseId}`;
      }
    }
    // Пользователь мог вставить «Текст->id» вручную
    if (t.includes('->')) return t;
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
    const parsed = parseMpAttrCellValue(cell, bucket, base[attrId]);
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
  if (!h) return 6;
  // название / описание обычно скрыты как дубли mp_* — на всякий случай
  if (
    (h === 'название' ||
      (h.startsWith('название') && !/модели|группы|файла|видео/.test(h)) ||
      /наименование|имя товара/.test(h)) &&
    !/описание/.test(h)
  ) {
    return 0;
  }
  if (/описание|аннотация|annotation/.test(h)) return 1;
  if (
    /артикул|штрих|баркод|vendor|nm\b|offer_id|(^|[^а-я])offer\b|ean|идентификатор товара|код товара продавца|код продавца|barcode/i.test(
      h
    ) &&
    !/название|наименование|oem/.test(h)
  ) {
    return 2;
  }
  if (/вес|габарит|длин|ширин|высот|объём|объем|размер|глубин|толщин|упаковк/i.test(h)) return 3;
  if (/страна/.test(h)) return 4;
  if (h === 'бренд' || h.includes('торговая марк') || /бренд продавца/.test(h)) return 5;
  return 6;
}

function dedicatedMpColSortRank(col) {
  const k = String(col?.key || '');
  if (/_name$/.test(k) || k.endsWith('_name')) return 0;
  if (/description/.test(k)) return 1;
  if (/^sku_|vendor_code|product_id|offer/.test(k) || k.includes('product_id')) return 2;
  if (/_product_(length|width|height|weight)$/.test(k)) return 3;
  if (/_pack_/.test(k)) return 4;
  if (/_brand$/.test(k)) return 5;
  if (/_country$/.test(k) || k.endsWith('_country')) return 6;
  return 7;
}

function sortMpSectionColumns(dedicatedCols, attrCols) {
  const tagged = [
    ...dedicatedCols.map((c) => ({ c, rank: dedicatedMpColSortRank(c), tie: String(c.key) })),
    ...attrCols.map((c) => ({
      c,
      rank: mpAttrSortRankFromHuman(c._humanName || c.label || ''),
      tie: String(c.mpAttr?.attrId || c.key),
    })),
  ];
  tagged.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // внутри одного ранга: сначала dedicated, потом attrs
    const ad = a.c.mpAttr ? 1 : 0;
    const bd = b.c.mpAttr ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return a.tie.localeCompare(b.tie, undefined, { numeric: true });
  });
  return tagged.map((x) => {
    const { _humanName, ...rest } = x.c;
    return _humanName !== undefined ? rest : x.c;
  });
}

function sortAttrIdsWithLabels(set, labelMap) {
  const m = labelMap || {};
  return [...set].sort((a, b) => {
    const ida = String(a);
    const idb = String(b);
    const ha = schemaAttrName(m[ida] ?? m[String(ida)]);
    const hb = schemaAttrName(m[idb] ?? m[String(idb)]);
    const ra = mpAttrSortRankFromHuman(ha);
    const rb = mpAttrSortRankFromHuman(hb);
    if (ra !== rb) return ra - rb;
    return ida.localeCompare(idb, undefined, { numeric: true });
  });
}

function mergeOzonAttrSchema(list, into, ozonPair, ozonPairsOut) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const id = a?.id != null ? String(a.id) : '';
    if (!id) continue;
    const name = String(a?.name || '').trim();
    const dictionaryIdRaw = a?.dictionary_id ?? a?.dictionaryId;
    const dictionaryId =
      dictionaryIdRaw != null && Number(dictionaryIdRaw) !== 0 ? Number(dictionaryIdRaw) : 0;
    const prev = into[id];
    if (!prev) {
      into[id] = { name, dictionaryId };
    } else {
      if (!prev.name && name) prev.name = name;
      if (!prev.dictionaryId && dictionaryId) prev.dictionaryId = dictionaryId;
    }
  }
  if (ozonPair && ozonPairsOut) {
    const descId = Number(ozonPair.description_category_id);
    const typeId = Number(ozonPair.type_id);
    if (Number.isFinite(descId) && descId > 0 && Number.isFinite(typeId) && typeId > 0) {
      const key = `${descId}_${typeId}`;
      if (!ozonPairsOut.some((p) => p.key === key)) {
        ozonPairsOut.push({ key, descId, typeId });
      }
    }
  }
}

function extractWbCharcOptions(attr) {
  if (!attr || typeof attr !== 'object') return null;
  const raw =
    (Array.isArray(attr.charcValues) && attr.charcValues) ||
    (Array.isArray(attr.values) && attr.values) ||
    (Array.isArray(attr.allowedValues) && attr.allowedValues) ||
    null;
  if (!raw?.length) return null;
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    if (x == null) continue;
    let id = null;
    let label = '';
    if (typeof x === 'string' || typeof x === 'number') {
      label = String(x).trim();
    } else if (typeof x === 'object') {
      id = x.id ?? x.valueId ?? x.charcValueId ?? x.charcValueID ?? null;
      if (id != null) id = String(id).trim();
      let lab = x.value ?? x.name ?? x.wbName ?? x.objectName ?? x.valueName;
      if (lab != null && typeof lab === 'object') lab = lab.name ?? lab.value ?? lab.text;
      label = lab != null ? String(lab).trim() : '';
      if (!label && id) label = id;
    }
    if (!label) continue;
    const k = label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: id || label, label, value: label });
  }
  return out.length ? out : null;
}

function mergeWbAttrSchema(list, into) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const idRaw = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id;
    if (idRaw == null) continue;
    const id = String(idRaw);
    const name = String(a?.name ?? a?.charcName ?? a?.characteristic_name ?? '').trim();
    const options = extractWbCharcOptions(a);
    const prev = into[id];
    if (!prev) {
      into[id] = { name, options };
    } else {
      if (!prev.name && name) prev.name = name;
      if ((!prev.options || !prev.options.length) && options) prev.options = options;
    }
  }
}

function mergeYmAttrSchema(list, into) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const id = a?.id != null ? String(a.id) : '';
    if (!id) continue;
    const name = String(a?.name || '').trim();
    const rawOpts = Array.isArray(a?.dictionary_options) ? a.dictionary_options : [];
    const options =
      a?.type === 'dictionary' && rawOpts.length
        ? rawOpts
            .filter((o) => o && o.id != null)
            .map((o) => ({
              id: String(o.id),
              label: String(o.label ?? o.value ?? o.id).trim() || String(o.id),
              value: String(o.id),
            }))
        : null;
    const prev = into[id];
    if (!prev) {
      into[id] = { name, options };
    } else {
      if (!prev.name && name) prev.name = name;
      if ((!prev.options || !prev.options.length) && options) prev.options = options;
    }
  }
}

function schemaAttrName(meta) {
  if (meta == null) return '';
  if (typeof meta === 'string') return meta;
  return String(meta.name || '').trim();
}

/**
 * Подписи + мета справочников по сопоставлениям ERP→МП.
 * Ozon: dictionary_id + пары desc/type для подгрузки значений.
 * YM/WB: options из схемы, если есть.
 */
async function fetchMpAttributeLabelMaps(products) {
  const maps = { ozon: {}, wb: {}, ym: {}, ozonPairs: [] };
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
      if (mp === 'ozon') mergeOzonAttrSchema(body, maps.ozon, res?.ozon_pair, maps.ozonPairs);
      else if (mp === 'wb') mergeWbAttrSchema(body, maps.wb);
      else mergeYmAttrSchema(body, maps.ym);
    });
  }
  return maps;
}

function ozonDictOptionLabel(opt) {
  if (!opt || typeof opt !== 'object') return '';
  const raw = opt.value ?? opt.info ?? opt.title ?? opt.name ?? opt.label ?? '';
  return String(raw).trim();
}

function normalizeDictToken(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[;:.,\s]+$/g, '');
}

/** Разобрать ячейку: id / «Текст->id» / подпись → значение для <select>. */
function resolveDictSelectValue(stored, options) {
  if (!Array.isArray(options) || options.length === 0) return '';
  const raw = String(stored ?? '').trim();
  if (!raw) return '';
  let label = raw;
  let idPart = '';
  const arrow = raw.indexOf('->');
  if (arrow > 0) {
    label = raw.slice(0, arrow).trim();
    idPart = raw.slice(arrow + 2).trim();
  }
  if (idPart) {
    const byId = options.find((o) => String(o.id) === idPart);
    if (byId) return String(byId.id);
  }
  const byIdDirect = options.find((o) => String(o.id) === raw);
  if (byIdDirect) return String(byIdDirect.id);
  const n = normalizeDictToken(label || raw);
  const byLabel = options.find(
    (o) =>
      normalizeDictToken(o.label) === n ||
      normalizeDictToken(o.value) === n ||
      normalizeDictToken(ozonDictOptionLabel(o)) === n
  );
  if (byLabel) return String(byLabel.id);
  return '';
}

/** Сохранить выбор справочника: Ozon — «Подпись->id», YM — id, WB — подпись. */
function encodeDictSelection(optionId, options, bucket) {
  const id = String(optionId ?? '').trim();
  if (!id) return '';
  const opt = (options || []).find((o) => String(o.id) === id);
  const label = opt
    ? String(opt.label || ozonDictOptionLabel(opt) || opt.value || id).trim()
    : id;
  if (bucket === 'ozon') {
    return label && label !== id ? `${label}->${id}` : id;
  }
  if (bucket === 'ym') return id;
  return label || id;
}

/** Подпись → ячейка справочника (для связи «Страна» и т.п.). */
function encodeDictFromPlainText(text, options, bucket) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (!Array.isArray(options) || options.length === 0) return t;
  const sel = resolveDictSelectValue(t, options);
  if (sel) return encodeDictSelection(sel, options, bucket);
  return t;
}

function isCountryLikeAttrName(humanName) {
  return /(страна|country|производств)/i.test(String(humanName || ''));
}

/**
 * Связь country → колонки JSON-атрибутов «Страна…» (справочник):
 * подставляем текст и, если есть options, резолвим в id.
 */
function applyLinkedCountryToDictAttrColumns(row, countryText, mpAttrCols, ozonDictByAttr = {}) {
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  const text = String(countryText ?? '').trim();
  if (!text || !Array.isArray(mpAttrCols) || mpAttrCols.length === 0) return row;
  let next = row;
  let changed = false;
  for (const col of mpAttrCols) {
    if (!col?.mpAttr) continue;
    if (!isCountryLikeAttrName(col._humanName || col.label)) continue;
    const mp = col.mpAttr.bucket;
    if (!isMpFieldLinked(links, 'country', mp)) continue;
    const attrId = String(col.mpAttr.attrId);
    const options =
      (Array.isArray(col.dictOptions) && col.dictOptions.length ? col.dictOptions : null) ||
      (mp === 'ozon' ? ozonDictByAttr[attrId] || ozonDictByAttr[Number(attrId)] : null) ||
      [];
    const encoded = encodeDictFromPlainText(text, options, mp);
    if (str(next[col.key]) === str(encoded)) continue;
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    next[col.key] = encoded;
  }
  return next;
}

function formatMpColumnLabel(attrId, humanName) {
  const id = String(attrId);
  const h = humanName && String(humanName).trim() ? String(humanName).trim() : '';
  if (h) return h;
  return `id ${id}`;
}

function mpColumnTitleAttr(bucket, attrId, humanName, isDict) {
  const id = String(attrId);
  const h = humanName && String(humanName).trim() ? String(humanName).trim() : '';
  const ru = bucket === 'ozon' ? 'Ozon' : bucket === 'wb' ? 'Wildberries' : 'Яндекс.Маркет';
  const dictHint = isDict ? '\nСправочник' : '';
  return h ? `${ru} · ${h}\nID: ${id}${dictHint}` : `${ru}\nID: ${id}${dictHint}`;
}

function mpBucketOfCol(col) {
  return col?.mpBucket || col?.mpAttr?.bucket || null;
}

function mpColClassName(col) {
  const b = mpBucketOfCol(col);
  if (b === 'ozon') return 'bulk-mp-ozon';
  if (b === 'wb') return 'bulk-mp-wb';
  if (b === 'ym') return 'bulk-mp-ym';
  return '';
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
    const kind = classifyMarketplaceDimAttrName(raw);
    if (kind === 'pack' || kind === 'product') return true;
    return false;
  }

  if (bucket === 'wb') {
    if (h.includes('артикул продавца')) return true;
    if (h === 'бренд' || h.includes('бренд продавца') || h.includes('торговая марк')) return true;
    if (h === 'название' || (h.includes('наименование') && h.includes('товар'))) return true;
    if (h.includes('описание') && (h.includes('товар') || h.includes('продавца'))) return true;
    const kind = classifyMarketplaceDimAttrName(raw);
    if (kind === 'pack' || kind === 'product') return true;
    if (/(длина|ширина|высота)/.test(h) && /упаковк|габарит/.test(h)) return true;
    if (/вес/.test(h) && /упаковк|брутто|brutto/.test(h)) return true;
    return false;
  }

  if (bucket === 'ym') {
    if (h === 'название' || h === 'название товара' || (h.startsWith('название') && !h.includes('модели') && !h.includes('группы'))) {
      return true;
    }
    if ((h.includes('описание') && (h.includes('товар') || h.includes('карточк'))) || h === 'описание товара') return true;
    const kind = classifyMarketplaceDimAttrName(raw);
    if (kind === 'pack' || kind === 'product') return true;
    if (/(длина|ширина|высота)/.test(h) && /упаковк|габарит/.test(h)) return true;
    if (/вес/.test(h) && /упаковк/.test(h)) return true;
    return false;
  }

  return false;
}

/** Известные id атрибутов Ozon для габаритов/веса упаковки — не дублируем столбцами JSON */
const OZON_PACK_DIM_ATTR_IDS = new Set(['9802', '6605', '6606', '4497', '4383', '9799', '6859']);
/** charcID габаритов упаковки/товара WB — не дублируем (вес — в wb_pack_weight) */
const WB_PACK_DIM_ATTR_IDS = new Set(['90849', '90745', '90846', '90652', '90673', '90630']);

/** Столбцы по объединению ключей атрибутов по всем загруженным товарам */
function buildMpAttrColumnDefs(products, labelMaps = { ozon: {}, wb: {}, ym: {} }) {
  const { oz, wb, ym } = collectAttrKeySets(products);
  const ozM = labelMaps?.ozon || {};
  const wbM = labelMaps?.wb || {};
  const ymM = labelMaps?.ym || {};
  const cols = [];
  for (const id of sortAttrIdsWithLabels(oz, ozM)) {
    if (OZON_PACK_DIM_ATTR_IDS.has(String(id))) continue;
    const meta = ozM[id] || ozM[String(id)];
    const human = schemaAttrName(meta);
    if (isDuplicateMpCardJsonAttr('ozon', human)) continue;
    const dictionaryId = Number(meta?.dictionaryId) || 0;
    const isDict = dictionaryId > 0;
    cols.push({
      key: `__mpAttr__ozon__${id}`,
      label: formatMpColumnLabel(id, human),
      title: mpColumnTitleAttr('ozon', id, human, isDict),
      headerClass: 'mp-attr-head',
      input: isDict ? 'select_dict' : 'textarea',
      minW: isDict ? 140 : 120,
      mpBucket: 'ozon',
      mpAttr: { bucket: 'ozon', attrId: id },
      dictionaryId: isDict ? dictionaryId : 0,
      dictOptions: null,
      _humanName: human || '',
    });
  }
  for (const id of sortAttrIdsWithLabels(wb, wbM)) {
    if (WB_PACK_DIM_ATTR_IDS.has(String(id))) continue;
    const meta = wbM[id] || wbM[String(id)];
    const human = schemaAttrName(meta);
    if (isDuplicateMpCardJsonAttr('wb', human)) continue;
    const options = Array.isArray(meta?.options) && meta.options.length ? meta.options : null;
    const isDict = Boolean(options);
    cols.push({
      key: `__mpAttr__wb__${id}`,
      label: formatMpColumnLabel(id, human),
      title: mpColumnTitleAttr('wb', id, human, isDict),
      headerClass: 'mp-attr-head',
      input: isDict ? 'select_dict' : 'textarea',
      minW: isDict ? 140 : 120,
      mpBucket: 'wb',
      mpAttr: { bucket: 'wb', attrId: id },
      dictionaryId: 0,
      dictOptions: options,
      _humanName: human || '',
    });
  }
  for (const id of sortAttrIdsWithLabels(ym, ymM)) {
    const meta = ymM[id] || ymM[String(id)];
    const human = schemaAttrName(meta);
    if (isDuplicateMpCardJsonAttr('ym', human)) continue;
    const options = Array.isArray(meta?.options) && meta.options.length ? meta.options : null;
    const isDict = Boolean(options);
    cols.push({
      key: `__mpAttr__ym__${id}`,
      label: formatMpColumnLabel(id, human),
      title: mpColumnTitleAttr('ym', id, human, isDict),
      headerClass: 'mp-attr-head',
      input: isDict ? 'select_dict' : 'textarea',
      minW: isDict ? 140 : 120,
      mpBucket: 'ym',
      mpAttr: { bucket: 'ym', attrId: id },
      dictionaryId: 0,
      dictOptions: options,
      _humanName: human || '',
    });
  }
  return cols;
}

/** Объём в литрах из габаритов в мм — как в ProductForm (мм³ / 1_000_000). */
function volumeLitersFromMmDims(rowOrProduct) {
  const len = Number(rowOrProduct.length);
  const wid = Number(rowOrProduct.width);
  const hei = Number(rowOrProduct.height);
  if (![len, wid, hei].every((n) => Number.isFinite(n) && n > 0)) return '';
  const liters = (len * wid * hei) / 1_000_000;
  if (!Number.isFinite(liters) || liters <= 0) return '';
  return String(Number(liters.toFixed(3)));
}

function ozonAttrPositiveNumber(attrs, ...ids) {
  const src = attrs && typeof attrs === 'object' ? attrs : {};
  for (const id of ids) {
    const raw = src[id] ?? src[String(id)];
    if (raw == null || raw === '') continue;
    const text = stringifyMpAttrValue(raw);
    const n = Number(String(text).replace(',', '.').replace(/[^\d.-]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function readProductDimsFromProduct(p, lengthUnit = 'mm', weightUnit = 'g') {
  const length = lengthMmToDisplay(p.product_length ?? p.productLength, lengthUnit);
  const width = lengthMmToDisplay(p.product_width ?? p.productWidth, lengthUnit);
  const height = lengthMmToDisplay(p.product_height ?? p.productHeight, lengthUnit);
  const weight = weightGToDisplay(p.product_weight ?? p.productWeight, weightUnit);
  const main = { length, width, height, weight };
  const links = normalizeMpFieldLinks(p.mp_field_links);
  const fromMp = (mp) => {
    if (isMpFieldLinked(links, 'product_dimensions', mp)) return main;
    const d = getMpDraftProductDimensionsMm(p, mp);
    if (d && (Number(d.length) > 0 || Number(d.width) > 0 || Number(d.height) > 0 || Number(d.weight) > 0)) {
      return {
        length: lengthMmToDisplay(d.length, lengthUnit),
        width: lengthMmToDisplay(d.width, lengthUnit),
        height: lengthMmToDisplay(d.height, lengthUnit),
        weight: weightGToDisplay(d.weight, weightUnit),
      };
    }
    if (mp === 'wb') {
      const attrs = normalizeJsonAttrs(p.wb_attributes);
      return {
        length: lengthCmToDisplay(attrs[WB_ITEM_DIM_CHARC.length], lengthUnit) || '',
        width: lengthCmToDisplay(attrs[WB_ITEM_DIM_CHARC.width], lengthUnit) || '',
        height: lengthCmToDisplay(attrs[WB_ITEM_DIM_CHARC.height], lengthUnit) || '',
        weight,
      };
    }
    return { length: '', width: '', height: '', weight: '' };
  };
  const oz = fromMp('ozon');
  const wb = fromMp('wb');
  const ym = fromMp('ym');
  return {
    product_length: length,
    product_width: width,
    product_height: height,
    product_weight: weight,
    ozon_product_length: oz.length,
    ozon_product_width: oz.width,
    ozon_product_height: oz.height,
    ozon_product_weight: oz.weight,
    wb_product_length: wb.length,
    wb_product_width: wb.width,
    wb_product_height: wb.height,
    wb_product_weight: wb.weight,
    ym_product_length: ym.length,
    ym_product_width: ym.width,
    ym_product_height: ym.height,
    ym_product_weight: ym.weight,
  };
}

function readOzonPackDimsFromProduct(p, lengthUnit = 'mm', weightUnit = 'g') {
  const d = getMpDraftDimensionsMm(p, 'ozon') || {};
  const attrs = normalizeJsonAttrs(p.ozon_attributes);
  const length = d.length ?? ozonAttrPositiveNumber(attrs, 9802);
  const width = d.width ?? ozonAttrPositiveNumber(attrs, 6605, 9799);
  const height = d.height ?? ozonAttrPositiveNumber(attrs, 6606, 6859);
  const weight = d.weight ?? ozonAttrPositiveNumber(attrs, 4497, 4383);
  return {
    ozon_pack_length: lengthMmToDisplay(length, lengthUnit),
    ozon_pack_width: lengthMmToDisplay(width, lengthUnit),
    ozon_pack_height: lengthMmToDisplay(height, lengthUnit),
    ozon_pack_weight: weightGToDisplay(weight, weightUnit),
  };
}

function readWbPackDimsFromProduct(p, lengthUnit = 'mm', weightUnit = 'g') {
  const d = getMpDraftDimensionsMm(p, 'wb') || {};
  return {
    wb_pack_length: lengthMmToDisplay(d.length, lengthUnit),
    wb_pack_width: lengthMmToDisplay(d.width, lengthUnit),
    wb_pack_height: lengthMmToDisplay(d.height, lengthUnit),
    wb_pack_weight: weightGToDisplay(d.weight, weightUnit),
  };
}

function readYmPackDimsFromProduct(p, lengthUnit = 'mm', weightUnit = 'g') {
  const wd = getYmDraftWeightDimensions(p);
  if (wd && typeof wd === 'object') {
    return {
      ym_pack_length: lengthCmToDisplay(wd.length, lengthUnit),
      ym_pack_width: lengthCmToDisplay(wd.width, lengthUnit),
      ym_pack_height: lengthCmToDisplay(wd.height, lengthUnit),
      ym_pack_weight: (() => {
        const g = wd.weight != null ? kgToGrams(wd.weight) : null;
        return g != null ? weightGToDisplay(g, weightUnit) : '';
      })(),
    };
  }
  const mm = getMpDraftDimensionsMm(p, 'ym');
  if (!mm) {
    return { ym_pack_length: '', ym_pack_width: '', ym_pack_height: '', ym_pack_weight: '' };
  }
  return {
    ym_pack_length: lengthMmToDisplay(mm.length, lengthUnit),
    ym_pack_width: lengthMmToDisplay(mm.width, lengthUnit),
    ym_pack_height: lengthMmToDisplay(mm.height, lengthUnit),
    ym_pack_weight: weightGToDisplay(mm.weight, weightUnit),
  };
}

function buildPositiveDimsObject(length, width, height, weight) {
  const out = {};
  const L = parseOptionalNumber(length);
  const W = parseOptionalNumber(width);
  const H = parseOptionalNumber(height);
  const Wt = parseOptionalNumber(weight);
  if (L != null && L > 0) out.length = L;
  if (W != null && W > 0) out.width = W;
  if (H != null && H > 0) out.height = H;
  if (Wt != null && Wt > 0) out.weight = Wt;
  return out;
}

function parseDraftBaseline(raw) {
  return normalizeJsonAttrs(raw);
}

function readMpCountriesFromProduct(p) {
  const oz = parseDraftBaseline(p?.ozon_draft);
  const wb = parseDraftBaseline(p?.wb_draft);
  const ym = parseDraftBaseline(p?.ym_draft);
  const ymList = Array.isArray(ym.manufacturerCountries)
    ? ym.manufacturerCountries.map((c) => String(c || '').trim()).filter(Boolean)
    : [];
  return {
    ozon_country: str(oz.country || ''),
    wb_country: str(wb.country || ''),
    ym_country: str(ymList[0] || ym.country || ''),
  };
}

function productToRow(p, mpAttrColDefs = [], lengthUnit = 'mm', weightUnit = 'g') {
  const orgRaw = p.organization_id ?? p.organizationId;
  const supplierRaw = p.supplier_id ?? p.supplierId;
  const barcodes = barcodeStringsFromProduct(p.barcodes);
  const oz = normalizeJsonAttrs(p.ozon_attributes);
  const wb = normalizeJsonAttrs(p.wb_attributes);
  const ym = normalizeJsonAttrs(p.ym_attributes);
  const ozPack = readOzonPackDimsFromProduct(p, lengthUnit, weightUnit);
  const wbPack = readWbPackDimsFromProduct(p, lengthUnit, weightUnit);
  const ymPack = readYmPackDimsFromProduct(p, lengthUnit, weightUnit);
  const productDims = readProductDimsFromProduct(p, lengthUnit, weightUnit);
  const mpCountries = readMpCountriesFromProduct(p);
  const row = {
    id: str(p.id),
    name: str(p.name),
    sku: str(p.sku),
    product_type: p.product_type === 'kit' ? 'kit' : 'product',
    categoryId: p.categoryId != null && p.categoryId !== '' ? str(p.categoryId) : '',
    organizationId: orgRaw != null && orgRaw !== '' ? str(orgRaw) : '',
    supplierId: supplierRaw != null && supplierRaw !== '' ? str(supplierRaw) : '',
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
    mp_field_links: normalizeMpFieldLinks(p.mp_field_links),
    ...ozPack,
    ...wbPack,
    ...ymPack,
    ...productDims,
    ...mpCountries,
    weight: weightGToDisplay(p.weight, weightUnit),
    length: lengthMmToDisplay(p.length, lengthUnit),
    width: lengthMmToDisplay(p.width, lengthUnit),
    height: lengthMmToDisplay(p.height, lengthUnit),
    _mpAttrBaseline: { ozon: { ...oz }, wb: { ...wb }, ym: { ...ym } },
    _ozonDraftBaseline: parseDraftBaseline(p.ozon_draft),
    _wbDraftBaseline: parseDraftBaseline(p.wb_draft),
    _ymDraftBaseline: parseDraftBaseline(p.ym_draft),
    _ozonDimsLocked: isOzonPackagingDimensionsLocked(p),
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
function buildUpdatePayload(original, current, mpAttrColDefs = [], lengthUnit = 'mm', weightUnit = 'g') {
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
  if (!eq(original.supplierId, current.supplierId)) {
    touch('supplierId', str(current.supplierId).trim() === '' ? null : str(current.supplierId).trim());
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

  if (linksSignature(original.mp_field_links) !== linksSignature(current.mp_field_links)) {
    touch('mp_field_links', normalizeMpFieldLinks(current.mp_field_links));
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

  const ozPackChanged =
    !eq(original.ozon_pack_length, current.ozon_pack_length) ||
    !eq(original.ozon_pack_width, current.ozon_pack_width) ||
    !eq(original.ozon_pack_height, current.ozon_pack_height) ||
    !eq(original.ozon_pack_weight, current.ozon_pack_weight);
  if (ozPackChanged) {
    const prevDraft = parseDraftBaseline(
      original._ozonDraftBaseline ?? original._productRef?.ozon_draft
    );
    const dimensions = buildPositiveDimsObject(
      lengthDisplayToMm(current.ozon_pack_length, lengthUnit),
      lengthDisplayToMm(current.ozon_pack_width, lengthUnit),
      lengthDisplayToMm(current.ozon_pack_height, lengthUnit),
      weightDisplayToG(current.ozon_pack_weight, weightUnit)
    );
    touch('ozon_draft', {
      ...prevDraft,
      dimensions,
    });
  }

  const wbPackChanged =
    !eq(original.wb_pack_length, current.wb_pack_length) ||
    !eq(original.wb_pack_width, current.wb_pack_width) ||
    !eq(original.wb_pack_height, current.wb_pack_height) ||
    !eq(original.wb_pack_weight, current.wb_pack_weight);
  if (wbPackChanged) {
    const prevDraft = parseDraftBaseline(
      original._wbDraftBaseline ?? original._productRef?.wb_draft
    );
    const dimensions = buildPositiveDimsObject(
      lengthDisplayToMm(current.wb_pack_length, lengthUnit),
      lengthDisplayToMm(current.wb_pack_width, lengthUnit),
      lengthDisplayToMm(current.wb_pack_height, lengthUnit),
      weightDisplayToG(current.wb_pack_weight, weightUnit)
    );
    touch('wb_draft', {
      ...prevDraft,
      dimensions,
    });
  }

  const ymPackChanged =
    !eq(original.ym_pack_length, current.ym_pack_length) ||
    !eq(original.ym_pack_width, current.ym_pack_width) ||
    !eq(original.ym_pack_height, current.ym_pack_height) ||
    !eq(original.ym_pack_weight, current.ym_pack_weight);
  if (ymPackChanged) {
    const prevDraft = parseDraftBaseline(original._ymDraftBaseline ?? original._productRef?.ym_draft);
    const L = lengthDisplayToCm(current.ym_pack_length, lengthUnit);
    const W = lengthDisplayToCm(current.ym_pack_width, lengthUnit);
    const H = lengthDisplayToCm(current.ym_pack_height, lengthUnit);
    const g = weightDisplayToG(current.ym_pack_weight, weightUnit);
    const kg = g != null ? gramsToKg(g) : null;
    const weightDimensions = {};
    if (L != null && L > 0) weightDimensions.length = L;
    if (W != null && W > 0) weightDimensions.width = W;
    if (H != null && H > 0) weightDimensions.height = H;
    if (kg != null && kg > 0) weightDimensions.weight = kg;
    const erpDims = ymWeightDimensionsToErp(weightDimensions);
    touch('ym_draft', {
      ...prevDraft,
      weightDimensions,
      ...(erpDims ? { dimensions: erpDims } : { dimensions: {} }),
    });
  }

  // Если связь dimensions↔МП вкл. и правили «Основное» — обновим draft из Main
  // (иначе UI мог показать зеркало, а draft остался старым, напр. 12×6 см на WB).
  {
    const links = normalizeMpFieldLinks(current.mp_field_links);
    const mainPackTouched =
      !eq(original.length, current.length) ||
      !eq(original.width, current.width) ||
      !eq(original.height, current.height) ||
      !eq(original.weight, current.weight);
    if (mainPackTouched && isMpFieldLinked(links, 'dimensions', 'wb') && !wbPackChanged) {
      const prevDraft = parseDraftBaseline(
        original._wbDraftBaseline ?? original._productRef?.wb_draft
      );
      const dimensions = buildPositiveDimsObject(
        lengthDisplayToMm(current.length, lengthUnit),
        lengthDisplayToMm(current.width, lengthUnit),
        lengthDisplayToMm(current.height, lengthUnit),
        weightDisplayToG(current.weight, weightUnit)
      );
      touch('wb_draft', { ...prevDraft, dimensions });
    }
    if (mainPackTouched && isMpFieldLinked(links, 'dimensions', 'ozon') && !ozPackChanged) {
      const prevDraft = parseDraftBaseline(
        original._ozonDraftBaseline ?? original._productRef?.ozon_draft
      );
      const dimensions = buildPositiveDimsObject(
        lengthDisplayToMm(current.length, lengthUnit),
        lengthDisplayToMm(current.width, lengthUnit),
        lengthDisplayToMm(current.height, lengthUnit),
        weightDisplayToG(current.weight, weightUnit)
      );
      touch('ozon_draft', { ...prevDraft, dimensions });
    }
    if (mainPackTouched && isMpFieldLinked(links, 'dimensions', 'ym') && !ymPackChanged) {
      const prevDraft = parseDraftBaseline(original._ymDraftBaseline ?? original._productRef?.ym_draft);
      const L = lengthDisplayToCm(current.length, lengthUnit);
      const W = lengthDisplayToCm(current.width, lengthUnit);
      const H = lengthDisplayToCm(current.height, lengthUnit);
      const g = weightDisplayToG(current.weight, weightUnit);
      const kg = g != null ? gramsToKg(g) : null;
      const weightDimensions = {};
      if (L != null && L > 0) weightDimensions.length = L;
      if (W != null && W > 0) weightDimensions.width = W;
      if (H != null && H > 0) weightDimensions.height = H;
      if (kg != null && kg > 0) weightDimensions.weight = kg;
      const erpDims = ymWeightDimensionsToErp(weightDimensions);
      touch('ym_draft', {
        ...prevDraft,
        weightDimensions,
        ...(erpDims ? { dimensions: erpDims } : { dimensions: {} }),
      });
    }
  }

  // Страна производителя → drafts МП (как упаковка)
  {
    const links = normalizeMpFieldLinks(current.mp_field_links);
    const patchDraft = (mp, extra) => {
      const key = `${mp}_draft`;
      const baselineKey = mp === 'ozon' ? '_ozonDraftBaseline' : mp === 'wb' ? '_wbDraftBaseline' : '_ymDraftBaseline';
      const prev =
        payload[key] && typeof payload[key] === 'object'
          ? payload[key]
          : parseDraftBaseline(original[baselineKey] ?? original._productRef?.[key]);
      touch(key, { ...prev, ...extra });
    };
    const ozCountryChanged = !eq(original.ozon_country, current.ozon_country);
    const wbCountryChanged = !eq(original.wb_country, current.wb_country);
    const ymCountryChanged = !eq(original.ym_country, current.ym_country);
    const mainCountryChanged = !eq(original.country_of_origin, current.country_of_origin);

    if (ozCountryChanged) {
      patchDraft('ozon', { country: str(current.ozon_country).trim() });
    } else if (mainCountryChanged && isMpFieldLinked(links, 'country', 'ozon')) {
      patchDraft('ozon', { country: str(current.country_of_origin).trim() });
    }
    if (wbCountryChanged) {
      patchDraft('wb', { country: str(current.wb_country).trim() });
    } else if (mainCountryChanged && isMpFieldLinked(links, 'country', 'wb')) {
      patchDraft('wb', { country: str(current.country_of_origin).trim() });
    }
    if (ymCountryChanged) {
      const c = str(current.ym_country).trim();
      patchDraft('ym', { manufacturerCountries: c ? [c] : [] });
    } else if (mainCountryChanged && isMpFieldLinked(links, 'country', 'ym')) {
      const c = str(current.country_of_origin).trim();
      patchDraft('ym', { manufacturerCountries: c ? [c] : [] });
    }
  }

  if (!eq(original.weight, current.weight)) {
    touch('weight', weightDisplayToG(current.weight, weightUnit));
  }
  if (!eq(original.length, current.length)) {
    touch('length', lengthDisplayToMm(current.length, lengthUnit));
  }
  if (!eq(original.width, current.width)) {
    touch('width', lengthDisplayToMm(current.width, lengthUnit));
  }
  if (!eq(original.height, current.height)) {
    touch('height', lengthDisplayToMm(current.height, lengthUnit));
  }
  if (!eq(original.product_length, current.product_length)) {
    touch('product_length', lengthDisplayToMm(current.product_length, lengthUnit));
  }
  if (!eq(original.product_width, current.product_width)) {
    touch('product_width', lengthDisplayToMm(current.product_width, lengthUnit));
  }
  if (!eq(original.product_height, current.product_height)) {
    touch('product_height', lengthDisplayToMm(current.product_height, lengthUnit));
  }
  if (!eq(original.product_weight, current.product_weight)) {
    touch('product_weight', weightDisplayToG(current.product_weight, weightUnit));
  }
  const productDimsTouched =
    !eq(original.product_length, current.product_length) ||
    !eq(original.product_width, current.product_width) ||
    !eq(original.product_height, current.product_height) ||
    !eq(original.product_weight, current.product_weight);

  // Размеры товара МП: связь вкл. → draft из Main; выкл. → свои ozon/wb/ym_product_* в draft.productDimensions
  {
    const links = normalizeMpFieldLinks(current.mp_field_links);
    const patchDraft = (mp, extra) => {
      const key = `${mp}_draft`;
      const baselineKey =
        mp === 'ozon' ? '_ozonDraftBaseline' : mp === 'wb' ? '_wbDraftBaseline' : '_ymDraftBaseline';
      const prev =
        payload[key] && typeof payload[key] === 'object'
          ? payload[key]
          : parseDraftBaseline(original[baselineKey] ?? original._productRef?.[key]);
      touch(key, { ...prev, ...extra });
    };
    const dimsFromDisplay = (length, width, height, weight) =>
      buildPositiveDimsObject(
        lengthDisplayToMm(length, lengthUnit),
        lengthDisplayToMm(width, lengthUnit),
        lengthDisplayToMm(height, lengthUnit),
        weightDisplayToG(weight, weightUnit)
      );
    const mpProductChanged = (mp) =>
      !eq(original[`${mp}_product_length`], current[`${mp}_product_length`]) ||
      !eq(original[`${mp}_product_width`], current[`${mp}_product_width`]) ||
      !eq(original[`${mp}_product_height`], current[`${mp}_product_height`]) ||
      !eq(original[`${mp}_product_weight`], current[`${mp}_product_weight`]);
    for (const mp of ['ozon', 'wb', 'ym']) {
      const linked = isMpFieldLinked(links, 'product_dimensions', mp);
      if (mpProductChanged(mp) && !linked) {
        patchDraft(mp, {
          productDimensions: dimsFromDisplay(
            current[`${mp}_product_length`],
            current[`${mp}_product_width`],
            current[`${mp}_product_height`],
            current[`${mp}_product_weight`]
          ),
        });
      } else if (productDimsTouched && linked) {
        patchDraft(mp, {
          productDimensions: dimsFromDisplay(
            current.product_length,
            current.product_width,
            current.product_height,
            current.product_weight
          ),
        });
      }
    }
  }
  const dimTouched =
    !eq(original.length, current.length) ||
    !eq(original.width, current.width) ||
    !eq(original.height, current.height);
  if (dimTouched) {
    const mmRow = {
      length: lengthDisplayToMm(current.length, lengthUnit),
      width: lengthDisplayToMm(current.width, lengthUnit),
      height: lengthDisplayToMm(current.height, lengthUnit),
    };
    const vCalc = volumeLitersFromMmDims(mmRow);
    touch('volume', vCalc === '' ? null : parseOptionalNumber(vCalc));
  }

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

  {
    const links = normalizeMpFieldLinks(current.mp_field_links);
    const wbLinked = isMpFieldLinked(links, 'product_dimensions', 'wb');
    const wbProductItemChanged =
      !eq(original.wb_product_length, current.wb_product_length) ||
      !eq(original.wb_product_width, current.wb_product_width) ||
      !eq(original.wb_product_height, current.wb_product_height);
    const writeWbItem =
      (productDimsTouched && wbLinked) || (wbProductItemChanged && !wbLinked);
    if (writeWbItem) {
      const prevWb = {
        ...normalizeJsonAttrs(original._productRef?.wb_attributes),
        ...normalizeJsonAttrs(original._mpAttrBaseline?.wb),
        ...(payload.wb_attributes && typeof payload.wb_attributes === 'object'
          ? payload.wb_attributes
          : {}),
      };
      const nextWb = sanitizeMpAttrsForApi(prevWb);
      const srcL = wbLinked ? current.product_length : current.wb_product_length;
      const srcW = wbLinked ? current.product_width : current.wb_product_width;
      const srcH = wbLinked ? current.product_height : current.wb_product_height;
      const cmL = lengthDisplayToCm(srcL, lengthUnit);
      const cmW = lengthDisplayToCm(srcW, lengthUnit);
      const cmH = lengthDisplayToCm(srcH, lengthUnit);
      if (cmL != null && Number(cmL) > 0) nextWb[WB_ITEM_DIM_CHARC.length] = String(cmL);
      if (cmW != null && Number(cmW) > 0) nextWb[WB_ITEM_DIM_CHARC.width] = String(cmW);
      if (cmH != null && Number(cmH) > 0) nextWb[WB_ITEM_DIM_CHARC.height] = String(cmH);
      touch('wb_attributes', nextWb);
    }
  }

  // WB характеристики упаковки (см) — иначе push/кабинет оставляют старые 90849/90745/90846
  {
    const links = normalizeMpFieldLinks(current.mp_field_links);
    const wbPackSource =
      wbPackChanged || (isMpFieldLinked(links, 'dimensions', 'wb') && (
        !eq(original.length, current.length) ||
        !eq(original.width, current.width) ||
        !eq(original.height, current.height)
      ));
    if (wbPackSource) {
      const prevWb = {
        ...normalizeJsonAttrs(original._productRef?.wb_attributes),
        ...normalizeJsonAttrs(original._mpAttrBaseline?.wb),
        ...(payload.wb_attributes && typeof payload.wb_attributes === 'object'
          ? payload.wb_attributes
          : {}),
      };
      const nextWb = sanitizeMpAttrsForApi(prevWb);
      const srcL = wbPackChanged ? current.wb_pack_length : current.length;
      const srcW = wbPackChanged ? current.wb_pack_width : current.width;
      const srcH = wbPackChanged ? current.wb_pack_height : current.height;
      const cmL = lengthDisplayToCm(srcL, lengthUnit);
      const cmW = lengthDisplayToCm(srcW, lengthUnit);
      const cmH = lengthDisplayToCm(srcH, lengthUnit);
      if (cmL != null && Number(cmL) > 0) nextWb[WB_PACK_DIM_CHARC.length] = String(cmL);
      if (cmW != null && Number(cmW) > 0) nextWb[WB_PACK_DIM_CHARC.width] = String(cmW);
      if (cmH != null && Number(cmH) > 0) nextWb[WB_PACK_DIM_CHARC.height] = String(cmH);
      touch('wb_attributes', nextWb);
    }
  }

  // Не даём объектам/массивам из ячеек атрибутов уронить весь PUT (габариты тоже откатятся)
  for (const key of ['ozon_attributes', 'wb_attributes', 'ym_attributes']) {
    if (payload[key] && typeof payload[key] === 'object') {
      payload[key] = sanitizeMpAttrsForApi(payload[key]);
    }
  }

  return payload;
}

/** Скаляры для JSON-атрибутов МП — Zod на PUT не принимает вложенные объекты в wb/ym. */
function sanitizeMpAttrsForApi(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'object') {
      const text = stringifyMpAttrValue(v);
      if (text !== '') out[k] = text;
    }
  }
  return out;
}

/**
 * После PUT: если в ответе пустые габариты, а в payload/текущей строке они были — оставляем введённые.
 */
function preserveBulkDimFieldsAfterSave(nextRow, currentRow, payload, lengthUnit, weightUnit) {
  const row = { ...nextRow };
  const fillProduct = (apiKey, rowKey, toDisplay) => {
    if (!Object.prototype.hasOwnProperty.call(payload, apiKey)) return;
    const cur = str(row[rowKey]).trim();
    if (cur !== '') return;
    const fromPayload = toDisplay(payload[apiKey]);
    const fromCurrent = str(currentRow?.[rowKey]).trim();
    const v = fromPayload !== '' ? fromPayload : fromCurrent;
    if (v === '') return;
    const base = productDimBaseKey(rowKey) || rowKey;
    if (PRODUCT_DIM_ALIAS[base]) {
      for (const alias of PRODUCT_DIM_ALIAS[base]) row[alias] = v;
    } else {
      row[rowKey] = v;
    }
  };
  fillProduct('product_length', 'product_length', (n) => lengthMmToDisplay(n, lengthUnit));
  fillProduct('product_width', 'product_width', (n) => lengthMmToDisplay(n, lengthUnit));
  fillProduct('product_height', 'product_height', (n) => lengthMmToDisplay(n, lengthUnit));
  fillProduct('product_weight', 'product_weight', (n) => weightGToDisplay(n, weightUnit));

  const fillPack = (apiKey, rowKey, toDisplay) => {
    if (!Object.prototype.hasOwnProperty.call(payload, apiKey)) return;
    if (str(row[rowKey]).trim() !== '') return;
    const fromPayload = toDisplay(payload[apiKey]);
    const fromCurrent = str(currentRow?.[rowKey]).trim();
    const v = fromPayload !== '' ? fromPayload : fromCurrent;
    if (v !== '') row[rowKey] = v;
  };
  fillPack('length', 'length', (n) => lengthMmToDisplay(n, lengthUnit));
  fillPack('width', 'width', (n) => lengthMmToDisplay(n, lengthUnit));
  fillPack('height', 'height', (n) => lengthMmToDisplay(n, lengthUnit));
  fillPack('weight', 'weight', (n) => weightGToDisplay(n, weightUnit));

  for (const mp of ['ozon', 'wb', 'ym']) {
    const draft = payload[`${mp}_draft`];
    if (!draft || typeof draft !== 'object' || !draft.productDimensions) continue;
    for (const kind of ['length', 'width', 'height', 'weight']) {
      const rowKey = `${mp}_product_${kind}`;
      if (str(row[rowKey]).trim() !== '') continue;
      const fromCurrent = str(currentRow?.[rowKey]).trim();
      if (fromCurrent) row[rowKey] = fromCurrent;
    }
  }
  return row;
}

function cloneRow(r) {
  const { _productRef, _ozonDraftBaseline, _wbDraftBaseline, _ymDraftBaseline, _mpAttrBaseline, ...rest } = r;
  return {
    ...rest,
    mp_field_links: normalizeMpFieldLinks(r.mp_field_links),
    _mpAttrBaseline: _mpAttrBaseline
      ? {
          ozon: { ...(_mpAttrBaseline.ozon || {}) },
          wb: { ...(_mpAttrBaseline.wb || {}) },
          ym: { ...(_mpAttrBaseline.ym || {}) },
        }
      : { ozon: {}, wb: {}, ym: {} },
    _ozonDraftBaseline: _ozonDraftBaseline ? { ..._ozonDraftBaseline } : {},
    _wbDraftBaseline: _wbDraftBaseline ? { ..._wbDraftBaseline } : {},
    _ymDraftBaseline: _ymDraftBaseline ? { ..._ymDraftBaseline } : {},
    _productRef,
  };
}

/** Оценка высоты строки для виртуализации (фото 3:4 + textarea). */
const BULK_ROW_ESTIMATE_PX = 60;
const BULK_ROW_OVERSCAN = 12;

/**
 * Справочник Ozon/WB/YM: полный список option монтируем только в фокусе.
 * Иначе 100 строк × десятки dict-колонок × сотни значений вешают вкладку.
 */
function BulkDictSelect({ cellRaw, options, bucket, title, dictionaryId, onCommit }) {
  const [expanded, setExpanded] = useState(false);
  const list = Array.isArray(options) ? options : [];
  const raw = str(cellRaw);
  const selectValue = resolveDictSelectValue(raw, list);
  const needsFallback = raw.trim() !== '' && selectValue === '';
  const visible = expanded ? list : list.filter((o) => String(o.id) === String(selectValue));

  return (
    <select
      className="products-bulk-cell-input"
      value={needsFallback ? raw : selectValue}
      title={title}
      onFocus={() => setExpanded(true)}
      onChange={(e) => {
        const picked = e.target.value;
        if (!picked) {
          onCommit('');
          return;
        }
        if (needsFallback && picked === raw) return;
        onCommit(encodeDictSelection(picked, list, bucket));
      }}
    >
      <option value="">—</option>
      {visible.map((opt) => (
        <option key={String(opt.id)} value={String(opt.id)}>
          {opt.label || ozonDictOptionLabel(opt) || opt.id}
        </option>
      ))}
      {needsFallback ? <option value={raw}>{formatOzonAttrDisplayValue(raw)}</option> : null}
      {!expanded && list.length > visible.length ? (
        <option value="" disabled>
          {list.length} значений — откройте список
        </option>
      ) : null}
      {bucket === 'ozon' && list.length === 0 && Number(dictionaryId) > 0 ? (
        <option value="" disabled>
          Загрузка справочника…
        </option>
      ) : null}
    </select>
  );
}

function PinIcon({ locked = false }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      className={locked ? 'products-bulk-pin-icon is-locked' : 'products-bulk-pin-icon'}
    >
      <path
        fill="currentColor"
        d="M16 3a1 1 0 0 1 .8 1.6l-2.2 2.93 1.47 4.42a1 1 0 0 1-.34 1.1l-1.73 1.38V21a1 1 0 1 1-2 0v-6.57l-1.73-1.38a1 1 0 0 1-.34-1.1l1.47-4.42L9.2 4.6A1 1 0 0 1 10 3h6z"
      />
    </svg>
  );
}

export function ProductsBulkEdit() {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const kitsEnabled = isProfileKitsEnabled(profile);
  const supplierBindingEnabled = isProfileProductSupplierBindingEnabled(profile);
  const lengthUnit = getProfileLengthUnit(profile);
  const weightUnit = getProfileWeightUnit(profile);
  const { categories, loadCategories } = useCategories();
  const { organizations } = useOrganizations();
  const { brands } = useBrands();
  const { suppliers } = useSuppliers();

  const activeSuppliers = useMemo(
    () =>
      [...(suppliers || [])]
        .filter((s) => s && s.isActive !== false && s.active !== false)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru')),
    [suppliers]
  );

  const [rows, setRows] = useState([]);
  const [originals, setOriginals] = useState({});
  /** Пока false — товары не грузим: сначала выбор категории (или «все»). */
  const [categoryScopeReady, setCategoryScopeReady] = useState(() => {
    const ids = location.state?.selectedIds;
    return Array.isArray(ids) && ids.length > 0;
  });
  const [categoryPickDraft, setCategoryPickDraft] = useState(() => {
    const ids = location.state?.selectedIds;
    if (Array.isArray(ids) && ids.length > 0) {
      const f = location.state?.filters;
      const cat = f?.categoryId != null && f.categoryId !== '' ? String(f.categoryId) : '';
      return cat === '' ? CATEGORY_SCOPE_ALL : cat;
    }
    return CATEGORY_SCOPE_UNSET;
  });
  const [pickerHasUncategorized, setPickerHasUncategorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  const [pushMpLoading, setPushMpLoading] = useState(null);
  const [pushMpMessage, setPushMpMessage] = useState(null);
  const [pullMpLoading, setPullMpLoading] = useState(null);
  const [pullMpMessage, setPullMpMessage] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(readBulkPageSize);
  const [totalProducts, setTotalProducts] = useState(0);

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
  useEffect(() => {
    if (!kitsEnabled && filterProductType) {
      setFilterProductType('');
    }
  }, [kitsEnabled, filterProductType]);
  const [filterUnlinkedMp, setFilterUnlinkedMp] = useState(() =>
    mpFilterSetFromState(location.state?.filters?.unlinkedMp)
  );
  const [filterLinkedMp, setFilterLinkedMp] = useState(() =>
    mpFilterSetFromState(location.state?.filters?.linkedMp)
  );
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
  const currentPageRef = useRef(1);
  const pageSizeRef = useRef(pageSize);
  currentPageRef.current = currentPage;
  pageSizeRef.current = pageSize;

  const [bulkModal, setBulkModal] = useState({ open: false, column: null });
  const [bulkDraft, setBulkDraft] = useState('');
  const [imagesModal, setImagesModal] = useState({
    open: false,
    productId: null,
    sku: '',
    images: [],
    loading: false,
    aspectLoadingId: '',
    error: '',
  });
  const imagesFileInputRef = useRef(null);
  const [imagesDropActive, setImagesDropActive] = useState(false);
  const [leavePromptOpen, setLeavePromptOpen] = useState(false);
  const [pushOfferOpen, setPushOfferOpen] = useState(false);
  const [pushOfferSavedCount, setPushOfferSavedCount] = useState(0);
  /** id, успешно сохранённые перед предложением «На МП» (если галочки не стоят) */
  const [pushOfferProductIds, setPushOfferProductIds] = useState([]);
  const pendingLeaveActionRef = useRef(null);
  const leaveBypassRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const bulkScrollRef = useRef(null);
  const [bulkViewport, setBulkViewport] = useState({ top: 0, height: 640 });
  /** id товаров, изменённых в этой сессии (после успешного push снимаются) */
  const changedForPushIdsRef = useRef(new Set());
  /** Выбранные на текущей странице строки (галочки) — scope для На МП / Из МП */
  const [selectedRowIds, setSelectedRowIds] = useState(() => new Set());
  const selectAllCheckboxRef = useRef(null);

  const markChangedForPush = useCallback((ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const sid = str(id);
      if (!sid) continue;
      changedForPushIdsRef.current.add(sid);
    }
  }, []);

  const clearChangedForPush = useCallback(() => {
    changedForPushIdsRef.current = new Set();
  }, []);

  const unmarkChangedForPush = useCallback((ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const sid = str(id);
      if (!sid) continue;
      changedForPushIdsRef.current.delete(sid);
    }
  }, []);
  /** Убираем галочки строк, которых больше нет на странице (смена страницы/фильтров). */
  useEffect(() => {
    const pageIds = new Set(rows.map((r) => str(r.id)).filter(Boolean));
    setSelectedRowIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (pageIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const pageRowIds = useMemo(
    () => rows.map((r) => str(r.id)).filter(Boolean),
    [rows]
  );
  const selectedCount = selectedRowIds.size;
  const allPageSelected =
    pageRowIds.length > 0 && pageRowIds.every((id) => selectedRowIds.has(id));
  const somePageSelected = pageRowIds.some((id) => selectedRowIds.has(id));

  useEffect(() => {
    const el = selectAllCheckboxRef.current;
    if (!el) return;
    el.indeterminate = somePageSelected && !allPageSelected;
  }, [somePageSelected, allPageSelected]);

  const toggleSelectRow = useCallback((id, checked) => {
    const sid = str(id);
    if (!sid) return;
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(sid);
      else next.delete(sid);
      return next;
    });
  }, []);

  const toggleSelectAllVisible = useCallback(
    (e) => {
      const checked = !!e?.target?.checked;
      setSelectedRowIds((prev) => {
        const next = new Set(prev);
        for (const id of pageRowIds) {
          if (checked) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [pageRowIds]
  );

  const getSelectedProductIds = useCallback(() => [...selectedRowIds].filter(Boolean), [selectedRowIds]);

  useEffect(() => {
    if (!pushOfferOpen) return undefined;
    const t = window.setTimeout(() => {
      document.querySelector('.products-bulk-push-offer')?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }, 50);
    return () => window.clearTimeout(t);
  }, [pushOfferOpen]);

  const [mpAttrColumnDefs, setMpAttrColumnDefs] = useState([]);
  /** Ozon: attrId → [{ id, label }] из getOzonAttributeValues (объединение по категориям страницы) */
  const [ozonBulkDictOptions, setOzonBulkDictOptions] = useState({});
  const ozonBulkDictOptionsRef = useRef(ozonBulkDictOptions);
  ozonBulkDictOptionsRef.current = ozonBulkDictOptions;
  const [showMpOzon, setShowMpOzon] = useState(() => readMpBucketVisibility().ozon);
  const [showMpWb, setShowMpWb] = useState(() => readMpBucketVisibility().wb);
  const [showMpYm, setShowMpYm] = useState(() => readMpBucketVisibility().ym);
  const [pinnedColumnKeys, setPinnedColumnKeys] = useState(() => readPinnedColumnKeys());
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState(() => readHiddenColumnKeys());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsSearch, setColumnsSearch] = useState('');
  const columnsMenuRef = useRef(null);
  const columnsSearchRef = useRef(null);

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
  useEffect(() => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_PINNED_COLS, JSON.stringify(pinnedColumnKeys));
      }
    } catch {
      /* ignore */
    }
  }, [pinnedColumnKeys]);
  useEffect(() => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_HIDDEN_COLS, JSON.stringify(hiddenColumnKeys));
      }
    } catch {
      /* ignore */
    }
  }, [hiddenColumnKeys]);

  useEffect(() => {
    if (!columnsMenuOpen) {
      setColumnsSearch('');
      return undefined;
    }
    const t = window.setTimeout(() => columnsSearchRef.current?.focus(), 0);
    const onDoc = (e) => {
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target)) {
        setColumnsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [columnsMenuOpen]);

  const togglePinColumn = useCallback((colKey) => {
    const key = String(colKey || '');
    if (!key || key === DEFAULT_STICKY_COL_KEY) return;
    setPinnedColumnKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      return [...prev, key];
    });
  }, []);

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
    const erp = COLUMNS.filter((c) => {
      if (c.key === 'supplierId' && !supplierBindingEnabled) return false;
      if (c.key === 'product_type' && !kitsEnabled) return false;
      return c.mpBucket == null;
    });
    const bucketVisible = (b) => {
      if (b === 'ozon') return showMpOzon;
      if (b === 'wb') return showMpWb;
      if (b === 'ym') return showMpYm;
      return false;
    };
    const out = [...erp];
    for (const bucket of ['ozon', 'wb', 'ym']) {
      if (!bucketVisible(bucket)) continue;
      const dedicated = COLUMNS.filter((c) => c.mpBucket === bucket);
      const attrs = visibleMpAttrColumnDefs.filter((c) => c.mpAttr?.bucket === bucket);
      out.push(...sortMpSectionColumns(dedicated, attrs));
    }
    return withDisplayUnitLabels(out, lengthUnit, weightUnit);
  }, [visibleMpAttrColumnDefs, showMpOzon, showMpWb, showMpYm, supplierBindingEnabled, kitsEnabled, lengthUnit, weightUnit]);

  /** Сдвиг закреплённого столбца среди пинов (артикул всегда левее). dir: -1 влево, +1 вправо */
  const movePinnedColumn = useCallback(
    (colKey, dir) => {
      const key = String(colKey || '');
      if (!key || key === DEFAULT_STICKY_COL_KEY) return;
      const step = dir < 0 ? -1 : 1;
      setPinnedColumnKeys((prev) => {
        const visibleKeySet = new Set((visibleColumns || []).map((c) => c.key));
        const active = prev.filter((k) => visibleKeySet.has(k));
        const inactive = prev.filter((k) => !visibleKeySet.has(k));
        const i = active.indexOf(key);
        if (i < 0) return prev;
        const j = i + step;
        if (j < 0 || j >= active.length) return prev;
        const next = [...active];
        const tmp = next[i];
        next[i] = next[j];
        next[j] = tmp;
        return [...next, ...inactive];
      });
    },
    [visibleColumns]
  );

  const visiblePinnedKeys = useMemo(() => {
    const vis = new Set((visibleColumns || []).map((c) => c.key));
    return (pinnedColumnKeys || []).filter((k) => vis.has(k));
  }, [pinnedColumnKeys, visibleColumns]);

  const displayColumns = useMemo(() => {
    const hidden = new Set(hiddenColumnKeys || []);
    const pinned = new Set(pinnedColumnKeys || []);
    const q = String(columnsSearch || '').trim();
    const ordered = orderColumnsWithPins(visibleColumns, pinnedColumnKeys).filter((c) => {
      if (ALWAYS_VISIBLE_COL_KEYS.has(c.key) || pinned.has(c.key)) return true;
      if (q) return columnMatchesSearchQuery(c, q);
      return !hidden.has(c.key);
    });
    return [SELECT_COL, ...ordered];
  }, [visibleColumns, pinnedColumnKeys, hiddenColumnKeys, columnsSearch]);

  const stickyLeftMap = useMemo(
    () => buildStickyLeftMap(displayColumns, pinnedColumnKeys),
    [displayColumns, pinnedColumnKeys]
  );

  const bulkVirtRange = useMemo(() => {
    const n = rows.length;
    if (n === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
    const top = Math.max(0, Number(bulkViewport.top) || 0);
    const h = Math.max(160, Number(bulkViewport.height) || 640);
    const start = Math.max(0, Math.floor(top / BULK_ROW_ESTIMATE_PX) - BULK_ROW_OVERSCAN);
    const end = Math.min(n, Math.ceil((top + h) / BULK_ROW_ESTIMATE_PX) + BULK_ROW_OVERSCAN);
    return {
      start,
      end,
      padTop: start * BULK_ROW_ESTIMATE_PX,
      padBottom: Math.max(0, (n - end) * BULK_ROW_ESTIMATE_PX),
    };
  }, [rows.length, bulkViewport]);

  const visibleRows = useMemo(
    () => rows.slice(bulkVirtRange.start, bulkVirtRange.end),
    [rows, bulkVirtRange.start, bulkVirtRange.end]
  );

  const toggleColumnHidden = useCallback((colKey, visible) => {
    const key = String(colKey || '');
    if (!key || ALWAYS_VISIBLE_COL_KEYS.has(key)) return;
    setHiddenColumnKeys((prev) => {
      if (visible) return prev.filter((k) => k !== key);
      return prev.includes(key) ? prev : [...prev, key];
    });
  }, []);

  const showAllColumns = useCallback(() => {
    setHiddenColumnKeys([]);
    setColumnsSearch('');
  }, []);

  const filteredColumnMenuItems = useMemo(() => {
    const hidden = new Set(hiddenColumnKeys || []);
    const pinned = new Set(pinnedColumnKeys || []);
    const q = String(columnsSearch || '').trim();
    return (visibleColumns || []).filter((col) => {
      if (ALWAYS_VISIBLE_COL_KEYS.has(col.key) || pinned.has(col.key)) return true;
      if (q) return columnMatchesSearchQuery(col, q);
      return !hidden.has(col.key);
    });
  }, [visibleColumns, columnsSearch, hiddenColumnKeys, pinnedColumnKeys]);

  const colStickyClass = useCallback(
    (col) => {
      const meta = stickyLeftMap.get(col.key);
      if (!meta) return '';
      return [
        'sticky-col-pin',
        meta.isBase ? 'sticky-col-base' : '',
        meta.isLast ? 'sticky-col-pin-edge' : '',
      ]
        .filter(Boolean)
        .join(' ');
    },
    [stickyLeftMap]
  );

  const colStickyStyle = useCallback(
    (col, { header = false } = {}) => {
      const meta = stickyLeftMap.get(col.key);
      const base = { minWidth: col.minW };
      if (!meta) return base;
      return {
        ...base,
        left: meta.left,
        width: meta.width,
        minWidth: meta.width,
        maxWidth: meta.width,
        /* шапка + pin: выше body-pin; body-pin выше прокручиваемых ячеек */
        zIndex: header ? meta.zIndex + 40 : meta.zIndex,
      };
    },
    [stickyLeftMap]
  );

  const activeFiltersCount =
    (filterOrganizationId ? 1 : 0) +
    (filterBrandId ? 1 : 0) +
    (filterProductType ? 1 : 0) +
    filterUnlinkedMp.size +
    filterLinkedMp.size;

  useEffect(() => {
    return () => {
      if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    };
  }, []);

  /** Категории для стартового выбора. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadCategories({ silent: true });
      } catch {
        /* ignore */
      }
      try {
        const show = await fetchHasUncategorizedProducts({});
        if (!cancelled) setPickerHasUncategorized(!!show);
      } catch {
        if (!cancelled) setPickerHasUncategorized(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCategories]);

  const applyCategoryScope = (rawValue) => {
    const v = String(rawValue ?? '');
    if (v === CATEGORY_SCOPE_UNSET) return;
    const cat = v === CATEGORY_SCOPE_ALL ? '' : v;
    setCategoryPickDraft(v === CATEGORY_SCOPE_ALL ? CATEGORY_SCOPE_ALL : v);
    setFilterCategoryId(cat);
    setCurrentPage(1);
    setCategoryScopeReady(true);
    setLoadError(null);
    setSaveMessage(null);
    setPushMpMessage(null);
    setPullMpMessage(null);
  };

  const markDirty = useCallback(() => {
    if (!hasUnsavedChangesRef.current) {
      hasUnsavedChangesRef.current = true;
      setHasUnsavedChanges(true);
    }
  }, []);

  const clearDirty = useCallback(() => {
    hasUnsavedChangesRef.current = false;
    setHasUnsavedChanges(false);
  }, []);

  const runPendingLeaveAction = useCallback(() => {
    const fn = pendingLeaveActionRef.current;
    pendingLeaveActionRef.current = null;
    setLeavePromptOpen(false);
    if (typeof fn !== 'function') return;
    leaveBypassRef.current = true;
    try {
      fn();
    } finally {
      queueMicrotask(() => {
        leaveBypassRef.current = false;
      });
    }
  }, []);

  const requestLeaveGuard = useCallback((proceed) => {
    if (typeof proceed !== 'function') return;
    if (leaveBypassRef.current || !hasUnsavedChangesRef.current) {
      proceed();
      return;
    }
    pendingLeaveActionRef.current = proceed;
    setLeavePromptOpen(true);
  }, []);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (leaveBypassRef.current || !hasUnsavedChangesRef.current) return;
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      const hrefAttr = a.getAttribute('href');
      if (!hrefAttr || hrefAttr.startsWith('#') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:')) {
        return;
      }
      let url;
      try {
        url = new URL(a.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      const next = `${url.pathname}${url.search}${url.hash}`;
      const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next === cur) return;
      e.preventDefault();
      e.stopPropagation();
      requestLeaveGuard(() => navigate(next));
    };
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [navigate, requestLeaveGuard]);

  const handleCategoryScopeChange = (e) => {
    const v = e.target.value;
    if (v === CATEGORY_SCOPE_UNSET) return;
    requestLeaveGuard(() => {
      // смена категории — сбрасываем таблицу до новой загрузки
      setRows([]);
      setOriginals({});
      setMpAttrColumnDefs([]);
      setTotalProducts(0);
      clearDirty();
      applyCategoryScope(v);
    });
  };

  const clearListFilters = () => {
    setFilterOrganizationId('');
    setFilterBrandId('');
    setFilterProductType('');
    setFilterUnlinkedMp(new Set());
    setFilterLinkedMp(new Set());
    setListSearch('');
    setCurrentPage(1);
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
      const unlinked =
        partial.unlinkedMp !== undefined ? partial.unlinkedMp : filterUnlinkedMp;
      const linked = partial.linkedMp !== undefined ? partial.linkedMp : filterLinkedMp;
      const searchRaw = partial.search !== undefined ? partial.search : listSearch;
      const search = typeof searchRaw === 'string' ? searchRaw.trim() : '';
      const ptTrim = typeof pt === 'string' ? pt.trim() : '';
      const unlinkedArr = [...mpFilterSetFromState(unlinked)];
      const linkedArr = [...mpFilterSetFromState(linked)];
      const page = partial.page !== undefined ? Number(partial.page) : currentPageRef.current;
      const limitCandidate = partial.limit !== undefined ? Number(partial.limit) : pageSizeRef.current;
      const limit = BULK_PAGE_SIZES.includes(limitCandidate) ? limitCandidate : 100;
      const safePage = Math.max(1, Number.isFinite(page) ? page : 1);
      const offset = Math.max(0, (safePage - 1) * limit);

      const baseParams = {
        organizationId: org || undefined,
        brandId: brand || undefined,
        categoryId: cat || undefined,
        productType: ptTrim || undefined,
        search: search || undefined,
        unlinkedMp: unlinkedArr.length ? unlinkedArr : undefined,
        linkedMp: linkedArr.length ? linkedArr : undefined,
        cacheBust: true,
      };

      const selectedIds = [...new Set((appliedSelectedIds || []).map((x) => str(x)).filter(Boolean))];

      let list = [];
      let total = 0;
      if (selectedIds.length > 0) {
        total = selectedIds.length;
        const pageIds = selectedIds.slice(offset, offset + limit);
        const CONC = 8;
        for (let i = 0; i < pageIds.length; i += CONC) {
          if (gen !== loadGenRef.current) return;
          const chunk = pageIds.slice(i, i + CONC);
          const parts = await Promise.all(
            chunk.map(async (id) => {
              try {
                const wrap = await productsApi.getById(id);
                return wrap?.data ?? wrap;
              } catch {
                return null;
              }
            })
          );
          for (const p of parts) {
            if (p?.id != null) list.push(p);
          }
        }
      } else {
        const res = await productsApi.getAll({
          ...baseParams,
          limit,
          offset,
        });
        if (gen !== loadGenRef.current) return;
        list = Array.isArray(res?.data) ? res.data : [];
        const metaTotal = Number(res?.meta?.total);
        total = Number.isFinite(metaTotal) ? metaTotal : list.length;
      }

      let showUncat = false;
      try {
        if (selectedIds.length > 0) {
          const resU = await productsApi.getAll({
            organizationId: org || undefined,
            brandId: brand || undefined,
            categoryId: FILTER_CATEGORY_NONE,
            productType: ptTrim || undefined,
            search: search || undefined,
            cacheBust: true,
            limit: Math.min(selectedIds.length, 1000),
            offset: 0,
          });
          if (gen !== loadGenRef.current) return;
          const uncat = Array.isArray(resU?.data) ? resU.data.filter(Boolean) : [];
          const setSel = new Set(selectedIds.map((x) => str(x)));
          showUncat = uncat.some((p) => p?.id != null && setSel.has(str(p.id)));
        } else {
          showUncat = await fetchHasUncategorizedProducts({
            organizationId: org || undefined,
            brandId: brand || undefined,
            productType: ptTrim || undefined,
            search: search || undefined,
          });
          if (gen !== loadGenRef.current) return;
        }
      } catch {
        showUncat = false;
      }
      if (gen !== loadGenRef.current) return;
      setShowUncategorizedCategoryOption(showUncat);
      setTotalProducts(total);
      if (partial.page !== undefined) setCurrentPage(safePage);

      const mpColsInitial = buildMpAttrColumnDefs(list, { ozon: {}, wb: {}, ym: {} });
      if (gen !== loadGenRef.current) return;
      setMpAttrColumnDefs(mpColsInitial);
      const nextRows = list.filter(Boolean).map((p) => productToRow(p, mpColsInitial, lengthUnit, weightUnit));
      const orig = {};
      for (const r of nextRows) {
        orig[r.id] = cloneRow(r);
      }
      setRows(nextRows);
      setOriginals(orig);
      clearChangedForPush();
      clearDirty();
      setOzonBulkDictOptions({});

      queueMicrotask(() => {
        fetchMpAttributeLabelMaps(list)
          .then(async (maps) => {
            if (gen !== loadGenRef.current) return;
            const mpColsLabeled = buildMpAttrColumnDefs(list, maps);
            setMpAttrColumnDefs(mpColsLabeled);

            const ozonDictAttrIds = [
              ...new Set(
                mpColsLabeled
                  .filter((c) => c.mpAttr?.bucket === 'ozon' && Number(c.dictionaryId) > 0)
                  .map((c) => String(c.mpAttr.attrId))
              ),
            ];
            const pairs = Array.isArray(maps.ozonPairs) ? maps.ozonPairs : [];
            if (ozonDictAttrIds.length === 0 || pairs.length === 0) {
              setOzonBulkDictOptions({});
              return;
            }

            const merged = {};
            const tasks = [];
            for (const pair of pairs) {
              for (const attrId of ozonDictAttrIds) {
                tasks.push({ attrId, descId: pair.descId, typeId: pair.typeId });
              }
            }
            const CONC = 3;
            for (let i = 0; i < tasks.length; i += CONC) {
              if (gen !== loadGenRef.current) return;
              const chunk = tasks.slice(i, i + CONC);
              const settled = await Promise.all(
                chunk.map(({ attrId, descId, typeId }) =>
                  integrationsApi
                    .getOzonAttributeValues(attrId, descId, typeId, { limit: 500 })
                    .then((r) => ({ attrId, result: r?.result || [] }))
                    .catch(() => ({ attrId, result: [] }))
                )
              );
              for (const { attrId, result } of settled) {
                if (!Array.isArray(result) || result.length === 0) continue;
                if (!merged[attrId]) merged[attrId] = new Map();
                const m = merged[attrId];
                for (const opt of result) {
                  if (opt?.id == null) continue;
                  const id = String(opt.id);
                  if (m.has(id)) continue;
                  const label = ozonDictOptionLabel(opt) || id;
                  m.set(id, { id, label, value: label });
                }
              }
            }
            if (gen !== loadGenRef.current) return;
            const out = {};
            for (const [attrId, m] of Object.entries(merged)) {
              out[attrId] = [...m.values()].sort((a, b) =>
                String(a.label).localeCompare(String(b.label), 'ru')
              );
            }
            setOzonBulkDictOptions(out);

            // После загрузки справочников — дописать связанные страны в dict-колонки
            setRows((prev) =>
              prev.map((r) => {
                const links = normalizeMpFieldLinks(r.mp_field_links);
                if (!['ozon', 'wb', 'ym'].some((mp) => isMpFieldLinked(links, 'country', mp))) {
                  return r;
                }
                const countryText = str(r.country_of_origin).trim();
                if (!countryText) return r;
                return applyLinkedCountryToDictAttrColumns(
                  r,
                  countryText,
                  mpColsLabeled,
                  out
                );
              })
            );
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
      setOzonBulkDictOptions({});
      clearChangedForPush();
      setShowUncategorizedCategoryOption(false);
      setTotalProducts(0);
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
    filterUnlinkedMp,
    filterLinkedMp,
    listSearch,
    appliedSelectedIds,
    lengthUnit,
    weightUnit,
    clearChangedForPush,
    clearDirty,
  ]);

  useEffect(() => {
    if (!categoryScopeReady) return;
    loadProducts();
  }, [loadProducts, categoryScopeReady]);

  useEffect(() => {
    const el = bulkScrollRef.current;
    if (!el || !categoryScopeReady || loading) return undefined;
    let raf = 0;
    const sync = () => {
      raf = 0;
      setBulkViewport({ top: el.scrollTop, height: el.clientHeight || 640 });
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(sync);
    };
    sync();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [categoryScopeReady, loading, rows.length, pageSize]);

  useEffect(() => {
    if (showUncategorizedCategoryOption === false && filterCategoryId === FILTER_CATEGORY_NONE) {
      setFilterCategoryId('');
      setCategoryPickDraft(CATEGORY_SCOPE_ALL);
    }
  }, [showUncategorizedCategoryOption, filterCategoryId]);

  const handleFilterOrganizationChange = (e) => {
    const v = e.target.value;
    requestLeaveGuard(() => {
      setFilterOrganizationId(v);
      setCurrentPage(1);
      void loadProducts({ organizationId: v, page: 1 });
    });
  };

  const handleFilterBrandChange = (e) => {
    const v = e.target.value;
    requestLeaveGuard(() => {
      setFilterBrandId(v);
      setCurrentPage(1);
      void loadProducts({ brandId: v, page: 1 });
    });
  };

  const handleFilterProductTypeChange = (e) => {
    const v = e.target.value;
    requestLeaveGuard(() => {
      setFilterProductType(v);
      setCurrentPage(1);
      void loadProducts({ productType: v, page: 1 });
    });
  };

  const toggleUnlinkedMpFilter = (mpCode) => {
    requestLeaveGuard(() => {
      const code = String(mpCode || '').toLowerCase();
      const nextUnlinked = new Set(filterUnlinkedMp);
      if (nextUnlinked.has(code)) nextUnlinked.delete(code);
      else nextUnlinked.add(code);
      const nextLinked = new Set(filterLinkedMp);
      nextLinked.delete(code);
      setFilterUnlinkedMp(nextUnlinked);
      setFilterLinkedMp(nextLinked);
      setCurrentPage(1);
      void loadProducts({ unlinkedMp: nextUnlinked, linkedMp: nextLinked, page: 1 });
    });
  };

  const toggleLinkedMpFilter = (mpCode) => {
    requestLeaveGuard(() => {
      const code = String(mpCode || '').toLowerCase();
      const nextLinked = new Set(filterLinkedMp);
      if (nextLinked.has(code)) nextLinked.delete(code);
      else nextLinked.add(code);
      const nextUnlinked = new Set(filterUnlinkedMp);
      nextUnlinked.delete(code);
      setFilterLinkedMp(nextLinked);
      setFilterUnlinkedMp(nextUnlinked);
      setCurrentPage(1);
      void loadProducts({ linkedMp: nextLinked, unlinkedMp: nextUnlinked, page: 1 });
    });
  };

  const handleListSearchChange = (e) => {
    const v = e.target.value;
    setListSearch(v);
    if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    listSearchDebounceRef.current = setTimeout(() => {
      requestLeaveGuard(() => {
        setCurrentPage(1);
        void loadProducts({ search: v, page: 1 });
      });
    }, 400);
  };

  const applyClearListFilters = () => {
    requestLeaveGuard(() => {
      clearListFilters();
      void loadProducts({
        organizationId: '',
        brandId: '',
        productType: '',
        unlinkedMp: [],
        linkedMp: [],
        search: '',
        page: 1,
      });
    });
  };

  const totalPages = Math.max(1, Math.ceil(Math.max(0, totalProducts) / Math.max(1, pageSize)));

  const goToPage = (page) => {
    const next = Math.min(Math.max(1, page), totalPages);
    if (next === currentPage) return;
    requestLeaveGuard(() => {
      setCurrentPage(next);
      void loadProducts({ page: next });
    });
  };

  const handlePageSizeChange = (e) => {
    const next = parseInt(e.target.value, 10);
    if (!BULK_PAGE_SIZES.includes(next)) return;
    requestLeaveGuard(() => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(BULK_PAGE_SIZE_LS, String(next));
      } catch {
        /* ignore */
      }
      setPageSize(next);
      setCurrentPage(1);
      void loadProducts({ page: 1, limit: next });
    });
  };

  const renderBulkListPager = (placement) => {
    const idSuffix = placement === 'top' ? 'top' : 'bottom';
    return (
      <div
        className={`d-flex justify-content-between align-items-center px-3 py-2 flex-wrap gap-2 ${
          placement === 'top' ? 'border-bottom' : 'border-top'
        }`}
      >
        <div className="d-flex flex-wrap align-items-center gap-3 text-muted small">
          <span>
            Страница <strong>{currentPage}</strong> из <strong>{totalPages}</strong>
            {totalProducts > 0 ? (
              <>
                {' '}
                · всего <strong>{totalProducts}</strong>
              </>
            ) : null}
          </span>
          <label className="d-inline-flex align-items-center gap-2 mb-0" htmlFor={`bulk-edit-page-size-${idSuffix}`}>
            <span>На странице</span>
            <select
              id={`bulk-edit-page-size-${idSuffix}`}
              className="form-select form-select-sm"
              style={{ width: 'auto', minWidth: '4.5rem' }}
              value={pageSize}
              onChange={handlePageSizeChange}
              disabled={loading}
            >
              {BULK_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="d-flex gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1 || loading}
          >
            Назад
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages || loading}
          >
            Вперёд
          </Button>
        </div>
      </div>
    );
  };

  const openBulk = (col) => {
    if (col.readonly || col.noBulk) return;
    setBulkDraft('');
    setBulkModal({ open: true, column: col });
  };

  const applyImagesToRow = useCallback((productId, images) => {
    const pid = str(productId);
    const list = normalizeProductImagesOrder(images);
    setRows((prev) =>
      prev.map((r) => {
        if (str(r.id) !== pid) return r;
        return {
          ...r,
          _productRef: { ...(r._productRef || {}), id: r.id, images: list },
        };
      })
    );
    setOriginals((prev) => {
      const o = prev[pid] || prev[productId];
      if (!o) return prev;
      const key = o.id != null ? str(o.id) : pid;
      return {
        ...prev,
        [key]: {
          ...o,
          _productRef: { ...(o._productRef || {}), id: o.id ?? productId, images: list },
        },
      };
    });
    return list;
  }, []);

  const openImagesModal = useCallback((row) => {
    if (!row?.id) return;
    const images = normalizeProductImagesOrder(parseProductImages(row._productRef?.images));
    setImagesModal({
      open: true,
      productId: row.id,
      sku: row.sku || '',
      images,
      loading: false,
      aspectLoadingId: '',
      error: '',
    });
    setImagesDropActive(false);
  }, []);

  const closeImagesModal = useCallback(() => {
    setImagesModal({
      open: false,
      productId: null,
      sku: '',
      images: [],
      loading: false,
      aspectLoadingId: '',
      error: '',
    });
    setImagesDropActive(false);
    if (imagesFileInputRef.current) imagesFileInputRef.current.value = '';
  }, []);

  const handleBulkUploadImages = useCallback(
    async (files) => {
      const productId = imagesModal.productId;
      const arr = Array.from(files || []);
      if (!productId || !arr.length) return;
      setImagesModal((m) => ({ ...m, loading: true, error: '' }));
      try {
        const r = await productsApi.uploadImages(productId, arr);
        let list = extractImagesFromApiPayload(r);
        if (list.length === 0) {
          const fresh = await productsApi.getImages(productId);
          list = extractImagesFromApiPayload(fresh);
        }
        list = applyImagesToRow(productId, list);
        setImagesModal((m) => ({ ...m, images: list, loading: false, error: '' }));
      } catch (e) {
        setImagesModal((m) => ({
          ...m,
          loading: false,
          error: e?.response?.data?.error || e?.message || 'Ошибка загрузки изображений',
        }));
      } finally {
        if (imagesFileInputRef.current) imagesFileInputRef.current.value = '';
      }
    },
    [imagesModal.productId, applyImagesToRow]
  );

  const handleBulkDeleteImage = useCallback(
    async (imageId) => {
      const productId = imagesModal.productId;
      if (!productId || !imageId) return;
      setImagesModal((m) => ({ ...m, loading: true, error: '' }));
      try {
        const r = await productsApi.deleteImage(productId, imageId);
        const list = applyImagesToRow(productId, extractImagesFromApiPayload(r));
        setImagesModal((m) => ({ ...m, images: list, loading: false, error: '' }));
      } catch (e) {
        setImagesModal((m) => ({
          ...m,
          loading: false,
          error: e?.response?.data?.error || e?.message || 'Ошибка удаления изображения',
        }));
      }
    },
    [imagesModal.productId, applyImagesToRow]
  );

  const handleBulkFitImageAspect3x4 = useCallback(
    async (imageId) => {
      const productId = imagesModal.productId;
      if (!productId || !imageId) return;
      setImagesModal((m) => ({ ...m, aspectLoadingId: String(imageId), error: '' }));
      try {
        const r = await productsApi.fitImageAspect3x4(productId, imageId);
        const list = applyImagesToRow(productId, extractImagesFromApiPayload(r));
        setImagesModal((m) => ({ ...m, images: list, aspectLoadingId: '', error: '' }));
      } catch (e) {
        setImagesModal((m) => ({
          ...m,
          aspectLoadingId: '',
          error: e?.response?.data?.error || e?.message || 'Ошибка приведения фото к 3:4',
        }));
      }
    },
    [imagesModal.productId, applyImagesToRow]
  );

  /** OZ/WB/ЯМ на фото: какие МП получают это изображение при выгрузке (как в карточке товара). */
  const handleBulkUpdateImageMarketplaces = useCallback(
    async (imageId, patch) => {
      const productId = imagesModal.productId;
      if (!productId || !imageId) return;
      const next = (imagesModal.images || []).map((img) => {
        const id = String(img?.id ?? img?.filename ?? '');
        if (id !== String(imageId)) return img;
        return { ...img, marketplaces: { ...(img.marketplaces || {}), ...(patch || {}) } };
      });
      const withPrimary = normalizeProductImagesOrder(next);
      setImagesModal((m) => ({ ...m, images: withPrimary, error: '' }));
      applyImagesToRow(productId, withPrimary);
      try {
        await productsApi.updateImages(productId, withPrimary);
      } catch (e) {
        setImagesModal((m) => ({
          ...m,
          error: e?.response?.data?.error || e?.message || 'Не удалось сохранить связь с МП',
        }));
      }
    },
    [imagesModal.productId, imagesModal.images, applyImagesToRow]
  );

  const applyBulk = () => {
    const col = bulkModal.column;
    if (!col) return;
    const key = col.key;
    markChangedForPush(rows.map((r) => r.id));
    markDirty();
    setRows((prev) =>
      prev.map((r) => {
        let next = withSyncedLinkedFields(r, key, bulkDraft);
        if (bulkLinkFieldForColumn(key) === 'country') {
          next = applyLinkedCountryToDictAttrColumns(
            next,
            next.country_of_origin,
            mpAttrColumnDefs,
            ozonBulkDictOptionsRef.current
          );
        }
        return next;
      })
    );
    setBulkModal({ open: false, column: null });
  };

  const updateCell = useCallback((id, key, value) => {
    markChangedForPush(id);
    markDirty();
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        let next = withSyncedLinkedFields(r, key, value);
        if (bulkLinkFieldForColumn(key) === 'country') {
          next = applyLinkedCountryToDictAttrColumns(
            next,
            next.country_of_origin,
            mpAttrColumnDefs,
            ozonBulkDictOptionsRef.current
          );
        }
        return next;
      })
    );
  }, [markChangedForPush, markDirty, mpAttrColumnDefs]);

  /** Тумблеры в шапке: включают/выключают связь для всех строк на экране. */
  const toggleBulkHeaderFieldLink = useCallback(
    (fieldKey, mp) => {
      if (!rows.length) return;
      const anyOn = rows.some((r) =>
        isMpFieldLinked(normalizeMpFieldLinks(r.mp_field_links), fieldKey, mp)
      );
      const enable = !anyOn;
      markChangedForPush(rows.map((r) => r.id));
      markDirty();
      setRows((prev) =>
        prev.map((r) => {
          let next = {
            ...r,
            mp_field_links: setMpFieldLink(r.mp_field_links, fieldKey, mp, enable),
          };
          if (enable) {
            next = copyMainFieldToMp(next, fieldKey, mp);
            if (fieldKey === 'country') {
              next = applyLinkedCountryToDictAttrColumns(
                next,
                next.country_of_origin,
                mpAttrColumnDefs,
                ozonBulkDictOptionsRef.current
              );
            }
          }
          return next;
        })
      );
    },
    [rows, markChangedForPush, markDirty, mpAttrColumnDefs]
  );

  const mpLinksFingerprint = useMemo(
    () => rows.map((r) => linksSignature(r.mp_field_links)).join('\n'),
    [rows]
  );

  const headerLinksByField = useMemo(() => {
    const keys = [...new Set((displayColumns || []).map((c) => c.linkFieldKey).filter(Boolean))];
    const out = {};
    for (const fieldKey of keys) {
      const base = emptyMpFieldLinks();
      if (!rows.length) {
        out[fieldKey] = base;
        continue;
      }
      for (const mp of ['ozon', 'wb', 'ym']) {
        const anyOn = rows.some((r) =>
          isMpFieldLinked(normalizeMpFieldLinks(r.mp_field_links), fieldKey, mp)
        );
        if (anyOn) base[fieldKey] = [...(base[fieldKey] || []), mp];
      }
      out[fieldKey] = base;
    }
    return out;
    // rows читаем при смене fingerprint (связи) или набора колонок
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpLinksFingerprint, displayColumns, rows.length]);

  const headerLinksForField = useCallback(
    (fieldKey) => headerLinksByField[fieldKey] || emptyMpFieldLinks(),
    [headerLinksByField]
  );

  const handleSave = async (opts = {}) => {
    const suppressPushOffer = opts?.suppressPushOffer === true;
    setSaving(true);
    setSaveMessage(null);
    const errors = [];
    const savedIds = [];
    let ok = 0;
    try {
      for (const r of rows) {
        const orig = originals[r.id];
        if (!orig) continue;
        const payload = buildUpdatePayload(orig, r, mpAttrColumnDefs, lengthUnit, weightUnit);
        if (Object.keys(payload).length === 0) continue;
        try {
          const wrap = await productsApi.update(r.id, payload);
          const u = wrap?.data !== undefined ? wrap.data : wrap;
          let nextRow = productToRow(u, mpAttrColumnDefs, lengthUnit, weightUnit);
          // Если API по какой-то причине не вернул габариты — не затираем только что сохранённые значения в таблице
          nextRow = preserveBulkDimFieldsAfterSave(nextRow, r, payload, lengthUnit, weightUnit);
          setOriginals((o) => ({ ...o, [r.id]: cloneRow(nextRow) }));
          setRows((list) => list.map((row) => (row.id === r.id ? { ...nextRow, _productRef: u } : row)));
          markChangedForPush(r.id);
          savedIds.push(str(r.id));
          ok += 1;
        } catch (e) {
          const msg = e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Ошибка';
          errors.push({ id: r.id, sku: r.sku, msg });
        }
      }
      if (errors.length === 0) {
        clearDirty();
        setSaveMessage(ok > 0 ? `Сохранено изменений: ${ok}.` : 'Нет изменений для сохранения.');
      } else {
        setSaveMessage(
          `Сохранено: ${ok}. Ошибок: ${errors.length}. ` +
            errors.slice(0, 5).map((e) => `#${e.id} (${e.sku}): ${e.msg}`).join('; ')
        );
      }
      if (!suppressPushOffer && ok > 0) {
        setPushOfferSavedCount(ok);
        setPushOfferProductIds(savedIds);
        // после async-сохранения открываем на следующем тике — иначе клик/фокус могут сразу закрыть модалку
        window.setTimeout(() => setPushOfferOpen(true), 0);
      }
      return { ok, errorCount: errors.length };
    } finally {
      setSaving(false);
    }
  };

  const handleSaveClick = () => {
    void handleSave({ suppressPushOffer: false });
  };

  const closeLeavePrompt = () => {
    pendingLeaveActionRef.current = null;
    setLeavePromptOpen(false);
  };

  const handleLeaveSaveAndContinue = async () => {
    const result = await handleSave({ suppressPushOffer: true });
    if (result?.errorCount > 0) {
      // остаёмся на странице — показать ошибки
      pendingLeaveActionRef.current = null;
      setLeavePromptOpen(false);
      return;
    }
    runPendingLeaveAction();
  };

  const handleLeaveDiscard = () => {
    runPendingLeaveAction();
  };

  const handlePushToMarketplaces = async (marketplaces, opts = {}) => {
    const skipConfirm = opts.skipConfirm === true;
    const rowIdsOnPage = new Set(rows.map((r) => str(r.id)).filter(Boolean));
    const selectedOnPage = getSelectedProductIds().filter((id) => rowIdsOnPage.has(id));
    let productIds = Array.isArray(opts.productIds)
      ? [...new Set(opts.productIds.map((x) => str(x)).filter(Boolean))]
      : selectedOnPage;

    // После «Сохранить» — если галочек нет, шлём только что сохранённые карточки.
    if (productIds.length === 0 && skipConfirm && Array.isArray(pushOfferProductIds)) {
      productIds = pushOfferProductIds.filter((id) => rowIdsOnPage.has(id));
    }

    if (productIds.length === 0) {
      setPushMpMessage('Отметьте товары галочками в таблице — отправка идёт только по выделенным.');
      setPushOfferOpen(false);
      return;
    }

    const mpLabel =
      marketplaces === 'all'
        ? 'все маркетплейсы'
        : marketplaces === 'ozon'
          ? 'Ozon'
          : marketplaces === 'wb'
            ? 'Wildberries'
            : 'Яндекс.Маркет';
    const dirtyAmong = productIds.filter((id) => {
      const r = rows.find((x) => str(x.id) === id);
      const orig = r ? originals[r.id] : null;
      if (!r || !orig) return false;
      return (
        Object.keys(buildUpdatePayload(orig, r, mpAttrColumnDefs, lengthUnit, weightUnit)).length > 0
      );
    });
    if (!skipConfirm) {
      const okConfirm = window.confirm(
        `Отправить на ${mpLabel} выделенные карточки: ${productIds.length} из ${rows.length} на странице?\n\n` +
          (dirtyAmong.length > 0
            ? `Сначала будут сохранены несохранённые правки (${dirtyAmong.length}).\n\n`
            : '') +
          'На маркетплейсы уходят данные из базы ERP.'
      );
      if (!okConfirm) return;
    }
    if (dirtyAmong.length > 0) {
      const saveResult = await handleSave({ suppressPushOffer: true });
      if (saveResult?.errorCount > 0) {
        setPushMpMessage('Отправка отменена: не удалось сохранить все изменения в ERP.');
        return;
      }
    }
    setPushOfferOpen(false);
    setPushMpLoading(marketplaces);
    setPushMpMessage(null);
    setPullMpMessage(null);
    try {
      const body = await productsApi.pushCardBulk({ productIds, marketplaces });
      const data = body?.data ?? body;
      const failedItems = Array.isArray(data?.items)
        ? data.items.filter((it) => !it?.ok).slice(0, 5)
        : [];
      const failHint =
        failedItems.length > 0
          ? ` Примеры ошибок: ${failedItems
              .map((it) => {
                const err =
                  (it.results || []).find((r) => !r.ok)?.error || 'ошибка';
                return `#${it.productId}: ${err}`;
              })
              .join('; ')}`
          : '';
      setPushMpMessage(
        `Отправка на МП (выделенные): успешно ${data?.success ?? 0} из ${data?.total ?? productIds.length}, ошибок: ${data?.failed ?? 0}.${failHint}`
      );
      const failedIdSet = new Set(
        (Array.isArray(data?.items) ? data.items : [])
          .filter((it) => !it?.ok)
          .map((it) => str(it.productId))
          .filter(Boolean)
      );
      unmarkChangedForPush(productIds.filter((id) => !failedIdSet.has(id)));
    } catch (e) {
      setPushMpMessage(e?.response?.data?.message || e?.message || 'Ошибка отправки на маркетплейсы');
    } finally {
      setPushMpLoading(null);
    }
  };

  const handlePullFromMarketplaces = async (marketplaces) => {
    const rowIdsOnPage = new Set(rows.map((r) => str(r.id)).filter(Boolean));
    const productIds = getSelectedProductIds().filter((id) => rowIdsOnPage.has(id));
    if (productIds.length === 0) {
      setPullMpMessage('Отметьте товары галочками в таблице — загрузка идёт только по выделенным.');
      return;
    }
    const mpLabel =
      marketplaces === 'all'
        ? 'всех маркетплейсов'
        : marketplaces === 'ozon'
          ? 'Ozon'
          : marketplaces === 'wb'
            ? 'Wildberries'
            : 'Яндекс.Маркет';
    const okConfirm = window.confirm(
      `Обновить в ERP выделенные карточки (${productIds.length}) данными с ${mpLabel}?\n\n` +
        'Поля маркетплейса (названия, описания, атрибуты, артикулы МП) будут перезаписаны из кабинета. ' +
        'Несохранённые правки в таблице по этим полям могут быть потеряны после обновления списка.\n\n' +
        'Картинки при массовой загрузке не скачиваются (быстрее). При большом числе товаров это всё равно может занять несколько минут.'
    );
    if (!okConfirm) return;
    setPullMpLoading(marketplaces);
    setPullMpMessage(
      `Загрузка с ${mpLabel}: 0 / ${productIds.length}… Не закрывайте вкладку.`
    );
    setPushMpMessage(null);
    try {
      const body = await productsApi.pullCardBulk(
        { productIds, marketplaces, skipImages: true },
        {
          onChunkProgress: ({ doneIds, totalIds, chunkIndex, chunkTotal }) => {
            setPullMpMessage(
              `Загрузка с ${mpLabel}: ${doneIds} / ${totalIds}` +
                (chunkTotal > 1 ? ` (пакет ${chunkIndex}/${chunkTotal})` : '') +
                '… Не закрывайте вкладку.'
            );
          },
        }
      );
      const data = body?.data ?? body;
      const failedItems = Array.isArray(data?.items)
        ? data.items.filter((it) => !it?.ok).slice(0, 5)
        : [];
      const failHint =
        failedItems.length > 0
          ? ` Примеры: ${failedItems
              .map((it) => {
                const err =
                  (it.results || []).find((r) => !r.ok)?.error || 'ошибка';
                return `#${it.productId}: ${err}`;
              })
              .join('; ')}`
          : '';
      const skippedN = Number(data?.skipped) || 0;
      const failedN = Number(data?.failed) || 0;
      const parts = [
        `успешно ${data?.success ?? 0} из ${data?.total ?? productIds.length}`,
      ];
      if (skippedN > 0) parts.push(`без привязки к МП (пропуск): ${skippedN}`);
      if (failedN > 0) parts.push(`ошибок: ${failedN}`);
      setPullMpMessage(`Обновление из МП (выделенные): ${parts.join(', ')}.${failHint}`);
      await loadProducts();
    } catch (e) {
      setPullMpMessage(
        e?.response?.data?.message || e?.message || 'Ошибка обновления карточек из маркетплейсов'
      );
    } finally {
      setPullMpLoading(null);
    }
  };

  const subtitle = useMemo(() => {
    if (!categoryScopeReady) {
      return 'Выберите категорию в списке ниже (или «Все категории») — затем загрузится таблица для редактирования.';
    }
    const n = rows.length;
    const sel = appliedSelectedIds.length;
    if (sel > 0) {
      return `Редактирование выбранных товаров (${n} на странице из ${sel}). Фильтры ниже сужают выборку; выбранные id с «Товаров» по-прежнему ограничивают список.`;
    }
    return `До ${pageSize} товаров на странице по фильтрам ниже. Отметьте строки на странице «Товары» и откройте массовое редактирование, чтобы править только выбранные.`;
  }, [categoryScopeReady, rows.length, appliedSelectedIds.length, pageSize]);

  const categoryScopeSelect = (
    <div className="products-bulk-category-scope">
      <label className="text-muted small mb-1 d-block" htmlFor="bulk-category-scope-pick">
        Категория для редактирования
      </label>
      <select
        id="bulk-category-scope-pick"
        className="form-select form-select-sm products-bulk-category-scope-select"
        value={categoryScopeReady ? categoryPickDraft : CATEGORY_SCOPE_UNSET}
        onChange={handleCategoryScopeChange}
        disabled={appliedSelectedIds.length > 0}
        aria-label="Выберите категорию для массового редактирования"
      >
        {!categoryScopeReady ? (
          <option value={CATEGORY_SCOPE_UNSET} disabled>
            — Выберите категорию —
          </option>
        ) : null}
        <option value={CATEGORY_SCOPE_ALL}>Все категории</option>
        {pickerHasUncategorized || showUncategorizedCategoryOption === true ? (
          <option value={FILTER_CATEGORY_NONE}>Без категории</option>
        ) : null}
        {[...(categories || [])]
          .filter((c) => c && c.id != null)
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
          .map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name || `Категория #${c.id}`}
            </option>
          ))}
      </select>
      {!categoryScopeReady ? (
        <p className="text-muted small mb-0 mt-2">
          Товары появятся после выбора категории. Можно выбрать «Все категории».
        </p>
      ) : null}
    </div>
  );

  const renderInput = (col, row) => {
    const orig = originals[row.id];
    const isDimCol = isPackDimColumnKey(col.key);
    const dimLocked = isDimCol && !!row._ozonDimsLocked;
    const dimDirty =
      isDimCol && orig != null && str(orig[col.key]) !== str(row[col.key]);
    const lockMark = dimLocked ? (
      <span className="products-bulk-dim-lock" title={OZON_DIMS_LOCK_TITLE} aria-label="Габариты закреплены Ozon">
        !
      </span>
    ) : null;

    if (col.readonly) {
      const text = str(row[col.key]).trim();
      return (
        <span
          className={`text-muted small text-nowrap d-block${dimDirty ? ' products-bulk-dim-dirty' : ''}`}
          title={dimLocked ? OZON_DIMS_LOCK_TITLE : col.hint || undefined}
        >
          {text !== '' ? text : '—'}
          {lockMark}
        </span>
      );
    }
    const linked = isBulkLinkedMpReadonly(row, col.key);
    const v = linked ? bulkLinkedMirrorValue(row, col.key) : row[col.key];
    const common = {
      className: `products-bulk-cell-input ${col.input === 'textarea' || col.mpAttr ? 'products-bulk-cell-textarea' : ''}${
        dimDirty ? ' products-bulk-dim-dirty' : ''
      }${linked ? ' products-bulk-cell-linked' : ''}`,
      value: v ?? '',
      onChange: (e) => updateCell(row.id, col.key, e.target.value),
      title: dimLocked
        ? OZON_DIMS_LOCK_TITLE
        : linked
          ? 'Связано с «Основным». Правка отвяжет это поле у строки'
          : undefined,
    };

    if (col.input === 'select_dict') {
      const bucket = col.mpAttr?.bucket;
      const attrId = String(col.mpAttr?.attrId ?? '');
      const options =
        (Array.isArray(col.dictOptions) && col.dictOptions.length ? col.dictOptions : null) ||
        (bucket === 'ozon'
          ? ozonBulkDictOptions[attrId] || ozonBulkDictOptions[Number(attrId)] || []
          : []) ||
        [];
      return (
        <BulkDictSelect
          cellRaw={str(v)}
          options={options}
          bucket={bucket}
          title={col.title || col._humanName || undefined}
          dictionaryId={col.dictionaryId}
          onCommit={(next) => updateCell(row.id, col.key, next)}
        />
      );
    }
    if (col.input === 'textarea' || col.mpAttr) {
      return <textarea {...common} rows={2} />;
    }
    if (col.input === 'number') {
      if (!isDimCol) {
        return <input {...common} type="text" inputMode="decimal" autoComplete="off" />;
      }
      return (
        <span className="products-bulk-dim-cell">
          <input {...common} type="text" inputMode="decimal" autoComplete="off" />
          {lockMark}
        </span>
      );
    }
    if (col.input === 'select_type') {
      return (
        <select
          className="products-bulk-cell-input"
          value={v}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
        >
          <option value="product">Товар</option>
          {kitsEnabled ? <option value="kit">Комплект</option> : null}
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
    if (col.input === 'select_supplier') {
      return (
        <select
          className="products-bulk-cell-input"
          value={v}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
          style={{ maxWidth: 220 }}
        >
          <option value="">— Не привязан —</option>
          {activeSuppliers.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name || `Поставщик #${s.id}`}
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
          <div className="d-flex flex-wrap align-items-center gap-2">
            {categoryScopeReady && !loading && rows.length > 0 ? (
              <>
                {hasUnsavedChanges ? (
                  <span className="text-warning small d-none d-md-inline">Есть изменения</span>
                ) : null}
                <Button
                  className="btn-shadow"
                  variant="primary"
                  size="small"
                  type="button"
                  onClick={handleSaveClick}
                  disabled={saving || !hasUnsavedChanges}
                >
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-shadow"
              onClick={() => requestLeaveGuard(() => navigate('/products'))}
            >
              ← К списку товаров
            </button>
          </div>
        )}
      />

      {loadError ? (
        <div className="alert alert-danger mb-0" role="alert">
          {loadError}
        </div>
      ) : null}
      {saveMessage ? (
        <div className={`alert ${saveMessage.includes('Ошибок') ? 'alert-warning' : 'alert-success'} mb-2`} role="status">
          {saveMessage}
        </div>
      ) : null}

      {pushOfferOpen ? (
        <div className="alert alert-info products-bulk-push-offer mb-2" role="dialog" aria-label="Отправить на маркетплейсы">
          <div className="d-flex flex-wrap align-items-center gap-2">
            <span className="me-auto">
              Сохранено в ERP: <strong>{pushOfferSavedCount}</strong> товар(ов). Отправить
              {selectedCount > 0
                ? ` выделенные (${selectedCount})`
                : ` сохранённые (${pushOfferProductIds.length || pushOfferSavedCount})`}{' '}
              на маркетплейсы?
            </span>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={!!pushMpLoading}
              onClick={() => setPushOfferOpen(false)}
            >
              Не сейчас
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={!!pushMpLoading}
              onClick={() => void handlePushToMarketplaces('ozon', { skipConfirm: true })}
            >
              {pushMpLoading === 'ozon' ? '…' : 'На Ozon'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={!!pushMpLoading}
              onClick={() => void handlePushToMarketplaces('wb', { skipConfirm: true })}
            >
              {pushMpLoading === 'wb' ? '…' : 'На WB'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={!!pushMpLoading}
              onClick={() => void handlePushToMarketplaces('ym', { skipConfirm: true })}
            >
              {pushMpLoading === 'ym' ? '…' : 'На Я.Маркет'}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="small"
              disabled={!!pushMpLoading}
              onClick={() => void handlePushToMarketplaces('all', { skipConfirm: true })}
            >
              {pushMpLoading === 'all' ? 'Отправка…' : 'На все МП'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="main-card mb-0 card products-bulk-main-card">
            <div className="card-body p-0">
              <div className="products-list-toolbar">
                <div className="products-bulk-toolbar-inner">
                  {categoryScopeSelect}
                  {categoryScopeReady ? (
                  <div className="products-bulk-scoped-ui">
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
                      <div className="products-bulk-columns-menu" ref={columnsMenuRef}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          className="btn-shadow"
                          onClick={() => setColumnsMenuOpen((o) => !o)}
                          aria-expanded={columnsMenuOpen}
                          title="Показать или скрыть столбцы таблицы"
                        >
                          {columnsMenuOpen ? '▼ Столбцы' : '▶ Столбцы'}
                          {hiddenColumnKeys.length > 0 ? (
                            <span className="badge bg-secondary ms-1 rounded-pill">{hiddenColumnKeys.length}</span>
                          ) : null}
                        </Button>
                        {columnsMenuOpen ? (
                          <div className="products-bulk-columns-panel" role="menu">
                            <div className="products-bulk-columns-toolbar">
                              <input
                                ref={columnsSearchRef}
                                id="bulk-columns-search"
                                type="search"
                                className="form-control form-control-sm products-bulk-columns-search"
                                placeholder="Найти столбец…"
                                value={columnsSearch}
                                onChange={(e) => setColumnsSearch(e.target.value)}
                                onKeyDown={(e) => e.stopPropagation()}
                                autoComplete="off"
                                aria-label="Поиск по названию столбца"
                              />
                              <button
                                type="button"
                                className="btn btn-outline-secondary btn-sm products-bulk-columns-show-all"
                                onClick={showAllColumns}
                                disabled={hiddenColumnKeys.length === 0}
                                title="Показать все скрытые столбцы"
                              >
                                Показать все
                              </button>
                            </div>
                            <div className="products-bulk-columns-list">
                              {filteredColumnMenuItems.length === 0 ? (
                                <div className="text-muted small py-2 px-1">
                                  {String(columnsSearch || '').trim()
                                    ? 'Нет столбцов по запросу'
                                    : 'Нет выбранных столбцов'}
                                </div>
                              ) : (
                                filteredColumnMenuItems.map((col) => {
                                  const locked = ALWAYS_VISIBLE_COL_KEYS.has(col.key);
                                  const shown = locked || !hiddenColumnKeys.includes(col.key);
                                  const fullTitle = col.title || col.label || col.key;
                                  return (
                                    <label key={col.key} className="products-bulk-columns-item">
                                      <input
                                        type="checkbox"
                                        className="form-check-input m-0"
                                        checked={shown}
                                        disabled={locked}
                                        onChange={(e) => toggleColumnHidden(col.key, e.target.checked)}
                                      />
                                      <span className="products-bulk-columns-item-label" title={fullTitle}>
                                        {col.label || col.key}
                                        {col.mpBucket ? (
                                          <span className="text-muted"> · {col.mpBucket.toUpperCase()}</span>
                                        ) : null}
                                      </span>
                                    </label>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        className="btn-shadow"
                        onClick={() => setFiltersOpen((o) => !o)}
                        aria-expanded={filtersOpen}
                        title="Организация, бренд, тип, связь с МП"
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
                      <div className="products-bulk-filters-row">
                        <div className="products-bulk-filter-item">
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
                        <div className="products-bulk-filter-item">
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
                        {kitsEnabled ? (
                        <div className="products-bulk-filter-item">
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
                        ) : null}
                        <div
                          className="products-bulk-filter-item products-bulk-filter-item--mp"
                          title="Показать товары со связью с маркетплейсом"
                        >
                          <span className="text-muted small d-block mb-1">Связан</span>
                          <div className="d-flex align-items-center gap-1">
                            {MP_LINK_FILTER_TOGGLES.map((mp) => {
                              const active = filterLinkedMp.has(mp.code);
                              return (
                                <MarketplaceToggle
                                  key={`linked-${mp.code}`}
                                  active={active}
                                  size={28}
                                  color={mp.color}
                                  title={
                                    active
                                      ? `Показаны товары со связью с ${mp.name}`
                                      : `Показать товары со связью с ${mp.name}`
                                  }
                                  onToggle={() => toggleLinkedMpFilter(mp.code)}
                                >
                                  {mp.label}
                                </MarketplaceToggle>
                              );
                            })}
                          </div>
                        </div>
                        <div
                          className="products-bulk-filter-item products-bulk-filter-item--mp"
                          title="Показать товары без связи с маркетплейсом"
                        >
                          <span className="text-muted small d-block mb-1">Не связан</span>
                          <div className="d-flex align-items-center gap-1">
                            {MP_LINK_FILTER_TOGGLES.map((mp) => {
                              const active = filterUnlinkedMp.has(mp.code);
                              return (
                                <MarketplaceToggle
                                  key={`unlinked-${mp.code}`}
                                  active={active}
                                  size={28}
                                  color={mp.color}
                                  title={
                                    active
                                      ? `Показаны товары без связи с ${mp.name}`
                                      : `Показать товары без связи с ${mp.name}`
                                  }
                                  onToggle={() => toggleUnlinkedMpFilter(mp.code)}
                                >
                                  {mp.label}
                                </MarketplaceToggle>
                              );
                            })}
                          </div>
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
                  <div className="d-flex flex-wrap align-items-center gap-2 ms-md-auto">
                    <span
                      className="text-muted small text-nowrap me-1"
                      title={
                        selectedCount > 0
                          ? `Отправить на МП только выделенные товары (${selectedCount})`
                          : 'Сначала отметьте товары галочками в таблице'
                      }
                    >
                      На МП{selectedCount > 0 ? ` (${selectedCount})` : ''}:
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePushToMarketplaces('ozon')}
                    >
                      {pushMpLoading === 'ozon' ? '…' : 'На Ozon'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePushToMarketplaces('wb')}
                    >
                      {pushMpLoading === 'wb' ? '…' : 'На WB'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePushToMarketplaces('ym')}
                    >
                      {pushMpLoading === 'ym' ? '…' : 'На Я.Маркет'}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePushToMarketplaces('all')}
                    >
                      {pushMpLoading === 'all' ? 'Отправка…' : 'На все МП'}
                    </Button>
                    <span
                      className="text-muted small text-nowrap ms-2 me-1"
                      title={
                        selectedCount > 0
                          ? `Загрузить данные с МП только для выделенных (${selectedCount})`
                          : 'Сначала отметьте товары галочками в таблице'
                      }
                    >
                      Из МП{selectedCount > 0 ? ` (${selectedCount})` : ''}:
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePullFromMarketplaces('ozon')}
                    >
                      {pullMpLoading === 'ozon' ? '…' : 'С Ozon'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePullFromMarketplaces('wb')}
                    >
                      {pullMpLoading === 'wb' ? '…' : 'С WB'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePullFromMarketplaces('ym')}
                    >
                      {pullMpLoading === 'ym' ? '…' : 'С Я.Маркет'}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="small"
                      disabled={!!pushMpLoading || !!pullMpLoading || rows.length === 0 || selectedCount === 0}
                      onClick={() => handlePullFromMarketplaces('all')}
                    >
                      {pullMpLoading === 'all' ? 'Загрузка…' : 'Со всех МП'}
                    </Button>
                  </div>
                  {pushMpMessage ? (
                    <div className="text-muted small w-100 mt-1">{pushMpMessage}</div>
                  ) : null}
                  {pullMpMessage ? (
                    <div className="text-muted small w-100 mt-1">{pullMpMessage}</div>
                  ) : null}
                  </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

      {categoryScopeReady ? (
      <div className="products-bulk-scoped-table">
      {renderBulkListPager('top')}

      <div className="products-bulk-scroll-region" ref={bulkScrollRef}>

          {loading ? (
            <p className="text-muted mb-0">Загрузка товаров…</p>
          ) : rows.length === 0 ? (
            <p className="text-muted mb-0">
              Нет товаров для отображения.{' '}
              <button
                type="button"
                className="btn btn-link btn-sm p-0 align-baseline"
                onClick={() => requestLeaveGuard(() => navigate('/products'))}
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
                {displayColumns.map((col) => {
                  if (col.key === SELECT_COL_KEY) {
                    return (
                      <th
                        key={col.key}
                        className={`${colStickyClass(col)} products-bulk-select-col`.trim()}
                        style={colStickyStyle(col, { header: true })}
                        scope="col"
                      >
                        <input
                          ref={selectAllCheckboxRef}
                          type="checkbox"
                          className="form-check-input m-0"
                          checked={allPageSelected}
                          onChange={toggleSelectAllVisible}
                          onClick={(e) => e.stopPropagation()}
                          aria-label="Выбрать все товары на странице"
                          title="Выбрать все на странице"
                        />
                      </th>
                    );
                  }
                  const isBaseSticky = col.key === DEFAULT_STICKY_COL_KEY;
                  const isPinned = pinnedColumnKeys.includes(col.key);
                  const pinIdx = isPinned ? visiblePinnedKeys.indexOf(col.key) : -1;
                  const canMoveLeft = pinIdx > 0;
                  const canMoveRight = pinIdx >= 0 && pinIdx < visiblePinnedKeys.length - 1;
                  return (
                    <th
                      key={col.key}
                      className={`${colStickyClass(col)} ${col.headerClass || ''} ${mpColClassName(col)}`.trim()}
                      style={colStickyStyle(col, { header: true })}
                      title={col.title || col.hint || col.label || undefined}
                    >
                      <div className="products-bulk-th-label">
                        <div className="products-bulk-th-top">
                          <span className="products-bulk-th-text">{col.label}</span>
                          {isBaseSticky ? (
                            <span
                              className="products-bulk-pin-btn products-bulk-pin-btn--locked"
                              title="Столбец закреплён по умолчанию"
                              aria-hidden
                            >
                              <PinIcon locked />
                            </span>
                          ) : (
                            <span className="products-bulk-th-actions">
                            {isPinned ? (
                              <button
                                type="button"
                                className="products-bulk-pin-btn products-bulk-move-btn"
                                title="Сдвинуть закреплённый столбец влево"
                                aria-label="Сдвинуть столбец влево"
                                disabled={!canMoveLeft}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  movePinnedColumn(col.key, -1);
                                }}
                              >
                                ‹
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`products-bulk-pin-btn${isPinned ? ' is-pinned' : ''}`}
                              title={
                                isPinned
                                  ? 'Открепить столбец'
                                  : 'Закрепить столбец слева (после артикула)'
                              }
                              aria-label={isPinned ? 'Открепить столбец' : 'Закрепить столбец'}
                              aria-pressed={isPinned}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                togglePinColumn(col.key);
                              }}
                            >
                              <PinIcon />
                            </button>
                            {isPinned ? (
                              <button
                                type="button"
                                className="products-bulk-pin-btn products-bulk-move-btn"
                                title="Сдвинуть закреплённый столбец вправо"
                                aria-label="Сдвинуть столбец вправо"
                                disabled={!canMoveRight}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  movePinnedColumn(col.key, 1);
                                }}
                              >
                                ›
                              </button>
                            ) : null}
                            </span>
                          )}
                        </div>
                        {col.linkFieldKey ? (
                          <MpFieldLinkToggles
                            fieldKey={col.linkFieldKey}
                            links={headerLinksForField(col.linkFieldKey)}
                            onToggle={toggleBulkHeaderFieldLink}
                            size={18}
                          />
                        ) : null}
                      </div>
                    </th>
                  );
                })}
              </tr>
              <tr className="bulk-actions-row">
                {displayColumns.map((col) => (
                  <th
                    key={`bulk-${col.key}`}
                    className={`${colStickyClass(col)} ${col.headerClass || ''} ${mpColClassName(col)}`.trim()}
                    style={colStickyStyle(col, { header: true })}
                    title={col.title || undefined}
                  >
                    {col.readonly || col.noBulk ? (
                      <span className="text-muted" style={{ fontSize: 10 }}>
                        —
                      </span>
                    ) : (
                      <button type="button" className="products-bulk-fill-btn" onClick={() => openBulk(col)}>
                        Заполнить
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bulkVirtRange.padTop > 0 ? (
                <tr aria-hidden="true" className="products-bulk-virt-spacer">
                  <td
                    colSpan={Math.max(1, displayColumns.length)}
                    style={{ height: bulkVirtRange.padTop, padding: 0, border: 0, lineHeight: 0 }}
                  />
                </tr>
              ) : null}
              {visibleRows.map((row) => (
                <tr key={row.id} className={selectedRowIds.has(str(row.id)) ? 'is-row-selected' : undefined}>
                  {displayColumns.map((col) => {
                    if (col.key === SELECT_COL_KEY) {
                      const sid = str(row.id);
                      return (
                        <td
                          key={col.key}
                          className={`${colStickyClass(col)} products-bulk-select-col`.trim()}
                          style={colStickyStyle(col)}
                        >
                          <input
                            type="checkbox"
                            className="form-check-input m-0"
                            checked={selectedRowIds.has(sid)}
                            onChange={(e) => toggleSelectRow(sid, e.target.checked)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Выбрать товар ${row.sku || sid}`}
                          />
                        </td>
                      );
                    }
                    if (col.key === 'id') {
                      return (
                        <td
                          key={col.key}
                          className={`${colStickyClass(col)} text-muted`.trim()}
                          style={colStickyStyle(col)}
                        >
                          {row.id}
                        </td>
                      );
                    }
                    if (col.key === '_photo') {
                      const url = getPrimaryProductImageUrl(row._productRef);
                      const count = parseProductImages(row._productRef?.images).length;
                      return (
                        <td
                          key={col.key}
                          className={colStickyClass(col) || undefined}
                          style={colStickyStyle(col)}
                        >
                          <button
                            type="button"
                            className="products-bulk-thumb products-bulk-thumb--btn"
                            onClick={() => openImagesModal(row)}
                            title={
                              count > 0
                                ? `Фото (${count}) — открыть, загрузить или удалить; OZ/WB/ЯМ — куда выгружать`
                                : 'Добавить изображения'
                            }
                            aria-label={
                              count > 0
                                ? `Управление изображениями товара ${row.sku || row.id}`
                                : `Добавить изображения для ${row.sku || row.id}`
                            }
                          >
                            {url ? <img src={url} alt="" loading="lazy" /> : <span className="products-bulk-thumb-empty">+</span>}
                            {count > 1 ? (
                              <span className="products-bulk-thumb-count">{count}</span>
                            ) : null}
                          </button>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={col.key}
                        className={`${colStickyClass(col)} ${mpColClassName(col)}`.trim() || undefined}
                        style={colStickyStyle(col)}
                      >
                        {renderInput(col, row)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {bulkVirtRange.padBottom > 0 ? (
                <tr aria-hidden="true" className="products-bulk-virt-spacer">
                  <td
                    colSpan={Math.max(1, displayColumns.length)}
                    style={{ height: bulkVirtRange.padBottom, padding: 0, border: 0, lineHeight: 0 }}
                  />
                </tr>
              ) : null}
            </tbody>
          </table>
            </div>
            </div>
      )}
      </div>

      <Modal
        isOpen={imagesModal.open}
        onClose={closeImagesModal}
        title={`Изображения${imagesModal.sku ? `: ${imagesModal.sku}` : ''}`}
        size="large"
      >
        <input
          ref={imagesFileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length) void handleBulkUploadImages(files);
          }}
        />
        <div
          className={`products-bulk-images-drop${imagesDropActive ? ' is-active' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            setImagesDropActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={(e) => {
            const rel = e.relatedTarget;
            if (rel && e.currentTarget.contains(rel)) return;
            setImagesDropActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setImagesDropActive(false);
            const files = filterDroppedImageFiles(e.dataTransfer?.files);
            if (files.length) void handleBulkUploadImages(files);
          }}
        >
          <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
            <Button
              type="button"
              variant="primary"
              size="small"
              disabled={imagesModal.loading || !imagesModal.productId}
              onClick={() => imagesFileInputRef.current?.click()}
            >
              {imagesModal.loading ? 'Загрузка…' : 'Загрузить фото'}
            </Button>
            <span className="text-muted small">или перетащите файлы сюда</span>
            <Button
              type="button"
              variant="secondary"
              size="small"
              className="ms-auto"
              onClick={closeImagesModal}
            >
              Закрыть
            </Button>
          </div>
          <p className="text-muted small mb-2">
            Значки <strong>OZ / WB / ЯМ</strong> на фото — на какие маркетплейсы отправлять изображение при выгрузке.
            Кнопка <strong>Сделать 3:4</strong> под каждым фото — привести изображение к формату 3:4.
          </p>
          {imagesModal.error ? (
            <div className="alert alert-danger py-2" role="alert">
              {imagesModal.error}
            </div>
          ) : null}
          {imagesModal.images.length === 0 ? (
            <p className="text-muted small mb-0">Пока нет изображений — загрузите файлы.</p>
          ) : (
            <div className="products-bulk-images-grid">
              {imagesModal.images.map((img, index) => {
                const id = String(img?.id ?? img?.filename ?? '');
                const url = resolveProductImageUrl(img?.url || img?.src || img?.link || '');
                const mp = img?.marketplaces || {};
                const aspectBusy = imagesModal.aspectLoadingId === id;
                return (
                  <div key={id || `img-${index}`} className="products-bulk-images-card">
                    <div className="products-bulk-images-card-media">
                      {url ? <img src={url} alt="" /> : <span className="text-muted">∅</span>}
                      <button
                        type="button"
                        className="products-bulk-images-delete"
                        title="Удалить изображение"
                        aria-label="Удалить изображение"
                        disabled={imagesModal.loading || !id}
                        onClick={() => void handleBulkDeleteImage(id)}
                      >
                        ×
                      </button>
                      <div className="products-bulk-images-mp-bar">
                        {index === 0 ? (
                          <span className="products-bulk-images-main-badge">Главное</span>
                        ) : (
                          <span />
                        )}
                        <span className="products-bulk-images-mp-toggles">
                          <MarketplaceToggle
                            active={mp.ozon !== false}
                            size={20}
                            color="#005bff"
                            title="Использовать на Ozon"
                            onToggle={() =>
                              void handleBulkUpdateImageMarketplaces(id, { ozon: !(mp.ozon !== false) })
                            }
                          >
                            OZ
                          </MarketplaceToggle>
                          <MarketplaceToggle
                            active={mp.wb !== false}
                            size={20}
                            color="#cb11ab"
                            title="Использовать на Wildberries"
                            onToggle={() =>
                              void handleBulkUpdateImageMarketplaces(id, { wb: !(mp.wb !== false) })
                            }
                          >
                            WB
                          </MarketplaceToggle>
                          <MarketplaceToggle
                            active={mp.ym !== false}
                            size={20}
                            color="#fc3f1d"
                            title="Использовать на Яндекс.Маркет"
                            onToggle={() =>
                              void handleBulkUpdateImageMarketplaces(id, { ym: !(mp.ym !== false) })
                            }
                          >
                            ЯМ
                          </MarketplaceToggle>
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="products-bulk-images-aspect-btn"
                      disabled={imagesModal.loading || aspectBusy || !id}
                      onClick={() => void handleBulkFitImageAspect3x4(id)}
                    >
                      {aspectBusy ? 'Приведение к 3:4…' : 'Сделать 3:4'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={bulkModal.open && bulkModalCol != null}
        onClose={() => setBulkModal({ open: false, column: null })}
        title={
          bulkModalCol
            ? `Массово: ${String(bulkModalCol.title || bulkModalCol.label || '')
                .split('\n')[0]
                .trim()}`
            : ''
        }
        size="large"
      >
        {bulkModalCol ? (
          <div>
            <p className="text-muted small">
              Значение будет применено ко <strong>всем</strong> строкам в таблице ({rows.length} товаров).
            </p>
            {bulkModalCol.input === 'select_dict' ? (
              (() => {
                const bucket = bulkModalCol.mpAttr?.bucket;
                const attrId = String(bulkModalCol.mpAttr?.attrId ?? '');
                const options =
                  (Array.isArray(bulkModalCol.dictOptions) && bulkModalCol.dictOptions.length
                    ? bulkModalCol.dictOptions
                    : null) ||
                  (bucket === 'ozon'
                    ? ozonBulkDictOptions[attrId] || ozonBulkDictOptions[Number(attrId)] || []
                    : []) ||
                  [];
                const selectValue = resolveDictSelectValue(bulkDraft, options);
                return (
                  <select
                    className="form-control"
                    value={selectValue}
                    onChange={(e) => {
                      const picked = e.target.value;
                      setBulkDraft(
                        picked ? encodeDictSelection(picked, options, bucket) : ''
                      );
                    }}
                    autoFocus
                  >
                    <option value="">— очистить / не задано</option>
                    {options.map((opt) => (
                      <option key={String(opt.id)} value={String(opt.id)}>
                        {opt.label || ozonDictOptionLabel(opt) || opt.id}
                      </option>
                    ))}
                  </select>
                );
              })()
            ) : bulkModalCol.input === 'textarea' ||
              (bulkModalCol.mpAttr && bulkModalCol.input !== 'select_dict') ? (
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
                {kitsEnabled ? <option value="kit">Комплект</option> : null}
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
            ) : bulkModalCol.input === 'select_supplier' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="">— Не привязан —</option>
                {activeSuppliers.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name || `Поставщик #${s.id}`}
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

      <Modal
        isOpen={leavePromptOpen}
        onClose={closeLeavePrompt}
        title="Несохранённые изменения"
        size="small"
        closeOnBackdropClick={!saving}
        closeOnEscape={!saving}
      >
        <p className="mb-3">
          В таблице есть несохранённые изменения. Сохранить их перед продолжением?
        </p>
        <div className="d-flex flex-wrap gap-2 justify-content-end">
          <Button type="button" variant="secondary" size="small" onClick={closeLeavePrompt} disabled={saving}>
            Остаться
          </Button>
          <Button type="button" variant="secondary" size="small" onClick={handleLeaveDiscard} disabled={saving}>
            Не сохранять
          </Button>
          <Button
            type="button"
            variant="primary"
            size="small"
            onClick={handleLeaveSaveAndContinue}
            disabled={saving}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={pushOfferOpen}
        onClose={() => setPushOfferOpen(false)}
        title="Отправить на маркетплейсы?"
        size="small"
        closeOnBackdropClick={!pushMpLoading}
        closeOnEscape={!pushMpLoading}
      >
        <p className="mb-3">
          Сохранено в ERP: <strong>{pushOfferSavedCount}</strong> товар(ов). Отправить
          {selectedCount > 0
            ? ` выделенные (${selectedCount})`
            : ` сохранённые (${pushOfferProductIds.length || pushOfferSavedCount})`}{' '}
          на маркетплейсы?
        </p>
        <p className="text-muted small mb-3">
          Уйдут только отмеченные галочками карточки (или только что сохранённые, если галочек нет).
          Можно выбрать один МП или все сразу.
        </p>
        <div className="d-flex flex-wrap gap-2 justify-content-end">
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={() => setPushOfferOpen(false)}
            disabled={!!pushMpLoading}
          >
            Не сейчас
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={!!pushMpLoading}
            onClick={() => void handlePushToMarketplaces('ozon', { skipConfirm: true })}
          >
            {pushMpLoading === 'ozon' ? '…' : 'На Ozon'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={!!pushMpLoading}
            onClick={() => void handlePushToMarketplaces('wb', { skipConfirm: true })}
          >
            {pushMpLoading === 'wb' ? '…' : 'На WB'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={!!pushMpLoading}
            onClick={() => void handlePushToMarketplaces('ym', { skipConfirm: true })}
          >
            {pushMpLoading === 'ym' ? '…' : 'На Я.Маркет'}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="small"
            disabled={!!pushMpLoading}
            onClick={() => void handlePushToMarketplaces('all', { skipConfirm: true })}
          >
            {pushMpLoading === 'all' ? 'Отправка…' : 'На все МП'}
          </Button>
        </div>
      </Modal>

      {!loading && (rows.length > 0 || totalProducts > 0) ? renderBulkListPager('bottom') : null}
      </div>
      ) : null}
    </div>
  );
}
