/**
 * Массовое редактирование товаров: таблица полей + «Заполнить» по столбцам.
 */

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { productAttributesApi } from '../../services/productAttributes.api';
import { productsApi } from '../../services/products.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { ImageLightbox } from '../../components/common/ImageLightbox/ImageLightbox';
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
  canRestoreImageAspect3x4,
} from '../../utils/productImage.js';
import {
  ProductImageAspectFrame,
  useProductHasNon3x4Image,
} from '../../hooks/useProductImageAspect3x4.js';
import {
  coerceBarcodeString,
  collectBarcodeStrings,
  formatBarcodesCell,
  isCorruptBarcodeString,
} from '../../utils/productBarcodes.js';
import {
  applyComputedAttributeValues,
  isComputedAttrType,
  isSystemPriceAttr,
} from '../../utils/attributeFormula.js';
import { attrShowsRelatedFields, isEditableAttrType } from '../../utils/editableAttribute.js';
import {
  isSystemMainFieldAttr,
  mainFieldShowsRelatedFields,
} from '../../utils/systemMainFieldAttributes.js';
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
  erpAttrLinkFieldKey,
  isAttrMpFieldLinkKey,
  isDedicatedMpFieldLinkKey,
  isWbCharcDuplicatingDedicatedField,
  isYmParamDuplicatingDedicatedField,
  normalizeCategoryDedicatedCharcLinks,
  DEDICATED_ADDED_KEYS_FIELD,
  DEDICATED_MAIN_MAP_KEYS,
  DEDICATED_PACK_DIM_KEYS,
  DEDICATED_PRODUCT_DIM_KEYS,
  supportedMpsForFieldKey,
  isMpOfferFieldAttrId,
  applyMpOfferFieldToForm,
  readMpOfferFieldValue,
  MP_OFFER_FIELD_ATTRS,
  isYmOfferFieldParamName,
} from '../../utils/productMpFieldLinks.js';
import {
  isOzonPackagingDimensionsLocked,
  OZON_DIMS_LOCK_TITLE,
} from '../../utils/ozonDimensionsLock.js';
import { MarketplaceToggle } from '../../components/common/MarketplaceToggle/MarketplaceToggle.jsx';
import { MpFieldLinkToggles, MpFromMainLinkIcon } from '../../components/common/MpFieldLinkToggles/MpFieldLinkToggles.jsx';
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
  ozonProductDimAxis,
  productDimAttrStoredFromMm,
  wbProductDimAxis,
} from '../../utils/marketplaceDimensions.js';
import {
  ATTR_MP_CODES,
  mappedMpsFromAttrLinks,
  MP_CATEGORY_LINK_ICON_TITLE,
  isMpSchemaAttrLinkedInCategory,
  isMpOfferFieldLinkedInCategory,
  isMpTargetLinkedInCategoryCategories,
  dedicatedMainFieldForMpTargetInCategories,
  normalizeAttrMpLinkList,
  normalizeAttrMpLinks,
  resolveAttrMpLinkTarget,
} from '../../utils/productAttributeMpLinks.js';
import { isOzonManufacturerCountryAttr, OZON_MANUFACTURER_COUNTRY_ATTR_ID } from '../../utils/ozonManufacturerCountry.js';
import { isOzonManufacturerArticleAttr, isStandaloneOemAttrName, OZON_PARTNUMBER_ATTR_ID } from '../../utils/ozonManufacturerArticle.js';
import { isOzonBrandAttr, OZON_BRAND_ATTR_ID } from '../../utils/ozonBrandAttr.js';
import {
  isOzonAnnotationAttr,
  isOzonNameAttr,
  isOzonPlainDescriptionAttr,
  OZON_ANNOTATION_ATTR_ID,
} from '../../utils/ozonCardTextAttrs.js';
import {
  applyTnVedAutofillToAttributes,
  categoryTnVedDigits,
} from '../../utils/productTnVedAttributeAutofill.js';
import { userCategoriesApi } from '../../services/userCategories.api';
import { integrationsApi } from '../../services/integrations.api.js';
import { WbBrandSuggest } from '../../components/common/WbBrandSuggest/WbBrandSuggest.jsx';
import {
  FILTER_CATEGORY_NONE,
  fetchHasUncategorizedProducts,
} from '../../utils/uncategorizedCategoryFilter.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { isProfileKitsEnabled, isProfileProductSupplierBindingEnabled } from '../../utils/profileFlags.js';
import { useSuppliers } from '../../hooks/useSuppliers';
import { useMarketplaceFieldLimitsByOrg } from '../../hooks/useMarketplaceFieldLimits.js';
import {
  bulkCellLimitHit,
  bulkCellLimitInfo,
  collectBulkRowLimitViolations,
  confirmFieldLimitViolations,
  emptyFieldLimitsByMp,
  expandPushMarketplaces,
  formatLimitCountLabel,
  formatLimitHitTitle,
} from '../../utils/marketplaceFieldLimits.js';
import { MarketplaceFieldLimitHint } from '../../components/common/MarketplaceFieldLimitHint/MarketplaceFieldLimitHint.jsx';
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
  ],
  product_width: [
    'product_width',
    'ozon_product_width',
    'wb_product_width',
  ],
  product_height: [
    'product_height',
    'ozon_product_height',
    'wb_product_height',
  ],
  product_weight: [
    'product_weight',
    'ozon_product_weight',
    'wb_product_weight',
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
const BULK_SKU_COLS = {
  main: 'sku',
  ozon: 'sku_ozon',
  wb: 'mp_wb_vendor_code',
  ym: 'sku_ym',
};
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
  if (k === 'sku' || k === 'sku_ozon' || k === 'mp_wb_vendor_code' || k === 'sku_ym') return 'sku';
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
  const mpOffer = parseMpOfferFieldColKey(k);
  if (mpOffer) return mpBucketFromOfferFieldId(mpOffer.offerId);
  const mpAttr = k.match(/^__mpAttr__(ozon|wb|ym)__/);
  if (mpAttr) return mpAttr[1];
  if (
    k === 'sku_ozon' ||
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
    k === 'sku_ym' ||
    k === 'ym_vendor_code' ||
    k.startsWith('mp_ym_') ||
    k.startsWith('ym_pack_') ||
    k.startsWith('ym_product_') ||
    k === 'ym_country'
  ) {
    return 'ym';
  }
  return null;
}

function mpAttrColKey(mp, attrId) {
  return `__mpAttr__${mp}__${attrId}`;
}

function parseMpAttrColKey(colKey) {
  const m = String(colKey || '').match(/^__mpAttr__(ozon|wb|ym)__(.+)$/);
  if (!m) return null;
  return { mp: m[1], attrId: m[2] };
}

/** Карты подписей характеристик МП — обновляются при загрузке таблицы. */
let bulkEditMpLabelMaps = { ozon: {}, wb: {}, ym: {} };

function findErpAttrColForMpAttr(erpAttrCols, mp, attrId, labelMaps = bulkEditMpLabelMaps, _attrName = '') {
  const want = String(attrId);
  return (
    (erpAttrCols || []).find((c) => {
      const entries = normalizeAttrMpLinkList(c?.erpAttr?.mpLinks?.[mp]);
      return entries.some((entry) => {
        if (String(entry.id || '') === want && !isMpOfferFieldAttrId(entry.id)) return true;
        const target = resolveAttrMpLinkTarget(entry, mp, labelMaps);
        return target?.kind === 'attr' && String(target.attrId) === want;
      });
    }) || null
  );
}

const MP_OFFER_COL_PREFIX = '__mpOffer__';

function mpOfferFieldColKey(offerId) {
  return `${MP_OFFER_COL_PREFIX}${String(offerId || '')}`;
}

function parseMpOfferFieldColKey(colKey) {
  const s = String(colKey || '');
  if (!s.startsWith(MP_OFFER_COL_PREFIX)) return null;
  const offerId = s.slice(MP_OFFER_COL_PREFIX.length);
  return isMpOfferFieldAttrId(offerId) ? { offerId } : null;
}

function mpBucketFromOfferFieldId(offerId) {
  const id = String(offerId || '');
  if (id.startsWith('__ym_')) return 'ym';
  if (id.startsWith('__ozon_')) return 'ozon';
  if (id.startsWith('__wb_')) return 'wb';
  return null;
}

function offerFieldDisplayName(offerId, humanName) {
  const h = String(humanName || '').trim();
  if (h) return h;
  for (const list of Object.values(MP_OFFER_FIELD_ATTRS)) {
    const hit = (list || []).find((x) => x.id === offerId);
    if (hit?.name) return hit.name;
  }
  return String(offerId || '');
}

function rowAsOfferFieldForm(row) {
  return {
    ...row,
    ym_draft: row.ym_draft || row._ymDraftBaseline,
    ozon_draft: row.ozon_draft || row._ozonDraftBaseline,
    wb_draft: row.wb_draft || row._wbDraftBaseline,
  };
}

function findErpAttrColForMpOfferField(erpAttrCols, offerId, labelMaps = bulkEditMpLabelMaps) {
  const want = String(offerId);
  return (
    (erpAttrCols || []).find((c) => {
      const links = c?.erpAttr?.mpLinks || {};
      for (const mp of ATTR_MP_CODES) {
        for (const entry of normalizeAttrMpLinkList(links[mp])) {
          if (String(entry.id || '') === want) return true;
          const target = resolveAttrMpLinkTarget(entry, mp, labelMaps);
          if (target?.kind === 'offer' && target.offerId === want) return true;
        }
      }
      return false;
    }) || null
  );
}

const BULK_DEDICATED_OFFER_FIELD_BY_COL = {
  sku_ozon: '__ozon_offer_id__',
  mp_wb_vendor_code: '__wb_vendor_code__',
  sku_ym: '__ym_shop_sku__',
  ym_vendor_code: '__ym_vendor_code__',
};

const BULK_DEDICATED_OFFER_FIELD_IDS = new Set(Object.values(BULK_DEDICATED_OFFER_FIELD_BY_COL));

function erpColsAsCategoryAttributes(erpCols) {
  return (erpCols || []).map((c) => ({
    id: c?.erpAttr?.id,
    mp_links: c?.erpAttr?.mpLinks,
  }));
}

function bulkEditCategoryIdSet(categories, filterCategoryId, rows, scopeCategoryIds) {
  const catId = String(filterCategoryId || '').trim();
  if (catId && catId !== FILTER_CATEGORY_NONE) return new Set([catId]);
  return new Set(resolveBulkEditCategoryIds(categories, filterCategoryId, rows, scopeCategoryIds));
}

function bulkMpColumnCategoryLinked(
  col,
  erpCols,
  labelMaps,
  categories,
  filterCategoryId,
  rows,
  scopeCategoryIds
) {
  if (col?.categoryLinked) return true;
  const mp = col.mpBucket || bulkMpCodeForColumn(col.key);
  if (!mp) return false;

  const catIds = bulkEditCategoryIdSet(categories, filterCategoryId, rows, scopeCategoryIds);
  const attrId = col.mpAttr?.attrId;
  const attrName = col._humanName || col.label || '';
  if (attrId) {
    const target = { kind: 'attr', attrId: String(attrId), attrName: String(attrName || '') };
    if (isMpTargetLinkedInCategoryCategories(categories, catIds, mp, target, labelMaps)) return true;
    if (findErpAttrColForMpAttr(erpCols, mp, attrId, labelMaps, attrName)) return true;
    if (
      isMpSchemaAttrLinkedInCategory(erpColsAsCategoryAttributes(erpCols), mp, attrId, labelMaps, attrName)
    ) {
      return true;
    }
  }

  const offerId =
    col.mpOfferField?.offerId ||
    BULK_DEDICATED_OFFER_FIELD_BY_COL[col.key] ||
    (isMpOfferFieldAttrId(col.key) ? col.key : '');
  if (offerId) {
    const target = { kind: 'offer', offerId: String(offerId) };
    if (isMpTargetLinkedInCategoryCategories(categories, catIds, mp, target, labelMaps)) return true;
    if (findErpAttrColForMpOfferField(erpCols, offerId, labelMaps)) return true;
    if (isMpOfferFieldLinkedInCategory(erpColsAsCategoryAttributes(erpCols), mp, offerId, labelMaps)) {
      return true;
    }
  }

  const parsed = parseMpAttrColKey(col.key);
  if (parsed) {
    const human = col._humanName || col.label || '';
    const target = { kind: 'attr', attrId: String(parsed.attrId), attrName: String(human || '') };
    if (isMpTargetLinkedInCategoryCategories(categories, catIds, parsed.bucket, target, labelMaps)) {
      return true;
    }
    if (findErpAttrColForMpAttr(erpCols, parsed.bucket, parsed.attrId, labelMaps, human)) return true;
    if (
      isMpSchemaAttrLinkedInCategory(
        erpColsAsCategoryAttributes(erpCols),
        parsed.bucket,
        parsed.attrId,
        labelMaps,
        human
      )
    ) {
      return true;
    }
  }

  const linkField = col.linkFieldKey || bulkLinkFieldForColumn(col.key);
  if (linkField) {
    const dedicated = dedicatedMappedMpsFromCategories(
      categories,
      filterCategoryId,
      rows,
      linkField,
      scopeCategoryIds
    );
    if (dedicated.includes(mp)) return true;
  }

  return false;
}

function attachBulkCategoryLinkIndicators(
  col,
  erpCols,
  labelMaps,
  categories,
  filterCategoryId,
  rows,
  scopeCategoryIds
) {
  if (bulkMpColumnCategoryLinked(col, erpCols, labelMaps, categories, filterCategoryId, rows, scopeCategoryIds)) {
    return { ...col, categoryLinked: true };
  }
  return col;
}

/** Цели сопоставления колонки МП в mp_field_links категории (артикул → партномер и т.д.). */
function bulkMpColumnDedicatedTargets(col) {
  const targets = [];
  const mp = col?.mpBucket || col?.mpAttr?.bucket || col?.mpOfferField?.mp;
  if (col?.mpAttr) {
    const attrName = String(col._humanName || col.label || '');
    targets.push({
      kind: 'attr',
      attrId: String(col.mpAttr.attrId),
      attrName,
    });
    if (mp === 'ozon' && isOzonManufacturerArticleAttr({ id: col.mpAttr.attrId, name: attrName })) {
      targets.push({ kind: 'offer', offerId: '__ozon_vendor_code__' });
    }
  }
  const offerId =
    col?.mpOfferField?.offerId || (col?.key ? BULK_DEDICATED_OFFER_FIELD_BY_COL[col.key] : null);
  if (offerId) targets.push({ kind: 'offer', offerId: String(offerId) });
  return targets;
}

function bulkDedicatedMainFieldForMpCol(col, categories, categoryIds, labelMaps) {
  const mp = col?.mpBucket || col?.mpAttr?.bucket || col?.mpOfferField?.mp;
  if (!mp) return '';
  let found = '';
  for (const target of bulkMpColumnDedicatedTargets(col)) {
    const field = dedicatedMainFieldForMpTargetInCategories(
      categories,
      categoryIds,
      mp,
      target,
      labelMaps
    );
    if (field === 'sku') return 'sku';
    if (field && !found) found = field;
  }
  return found;
}

function attachDedicatedMainFieldToMpColumn(col, categories, categoryIds, labelMaps) {
  if (!col?.mpAttr && !col?.mpOfferField && !BULK_DEDICATED_OFFER_FIELD_BY_COL[col?.key]) return col;
  const field = bulkDedicatedMainFieldForMpCol(col, categories, categoryIds, labelMaps);
  if (!field) return col;
  if (col.dedicatedMainFieldKey === field && col.linkFieldKey === field) return col;
  return {
    ...col,
    dedicatedMainFieldKey: field,
    linkFieldKey: field,
  };
}

function attachOfferFieldLinkMeta(col, erpCols) {
  if (!col?.mpOfferField) return col;
  const erp = findErpAttrColForMpOfferField(erpCols, col.mpOfferField.offerId);
  if (!erp) return col;
  const attrMapped = mappedMpsFromAttrLinks(erp.erpAttr?.mpLinks);
  return {
    ...col,
    mappedMps: attrMapped.length ? attrMapped : col.mappedMps?.length ? col.mappedMps : [col.mpOfferField.mp],
    linkFieldKey: erp.linkFieldKey,
    categoryLinked: true,
    linkSupportedMps: attrMapped,
  };
}

function attachDedicatedOfferColumnLinkMeta(col, erpCols) {
  const offerId = BULK_DEDICATED_OFFER_FIELD_BY_COL[col.key];
  if (!offerId) return col;
  const erp = findErpAttrColForMpOfferField(erpCols, offerId);
  if (!erp) return col;
  const attrMapped = mappedMpsFromAttrLinks(erp.erpAttr?.mpLinks);
  return {
    ...col,
    linkFieldKey: erp.linkFieldKey,
    categoryLinked: true,
    mappedMps: attrMapped.length ? attrMapped : col.mappedMps,
    linkSupportedMps: attrMapped.length ? attrMapped : col.linkSupportedMps,
  };
}

function extraLinkedMpOfferColumn(mp, offerId, humanName) {
  const id = String(offerId);
  if (!isMpOfferFieldAttrId(id)) return null;
  const bucket = mpBucketFromOfferFieldId(id);
  if (bucket && bucket !== mp) return null;
  const label = offerFieldDisplayName(id, humanName);
  const ru = mp === 'ozon' ? 'Ozon' : mp === 'wb' ? 'Wildberries' : 'Яндекс.Маркет';
  return {
    key: mpOfferFieldColKey(id),
    label,
    title: `${ru} · ${label}`,
    headerClass: 'mp-attr-head',
    input: 'text',
    minW: 120,
    mpBucket: mp,
    mpOfferField: { mp, offerId: id },
    _humanName: label,
  };
}

function syncOfferFieldColsOnRow(row, mpAttrColDefs = []) {
  let next = row;
  for (const col of mpAttrColDefs) {
    if (!col.mpOfferField) continue;
    const val = readMpOfferFieldValue(rowAsOfferFieldForm(next), col.mpOfferField.offerId);
    if (str(next[col.key]) === str(val)) continue;
    next = { ...next, [col.key]: val };
  }
  return next;
}

function patchPayloadFromOfferFieldForm(payload, touch, formBefore, formAfter) {
  const eq = (a, b) => str(a) === str(b);
  if (!eq(formBefore.sku_ym, formAfter.sku_ym)) touch('sku_ym', normTextOrNull(formAfter.sku_ym));
  if (!eq(formBefore.sku_ozon, formAfter.sku_ozon)) touch('sku_ozon', normTextOrNull(formAfter.sku_ozon));
  if (!eq(formBefore.mp_wb_vendor_code, formAfter.mp_wb_vendor_code)) {
    touch('mp_wb_vendor_code', normTextOrNull(formAfter.mp_wb_vendor_code));
  }
  for (const mp of ['ozon', 'wb', 'ym']) {
    const k = `${mp}_draft`;
    if (stableAttrJson(formBefore[k]) !== stableAttrJson(formAfter[k])) {
      touch(k, formAfter[k]);
    }
  }
}

function syncOzonMfrArticleColsOnRow(row, value, mpAttrColDefs = []) {
  const v = String(value ?? '');
  let next = row;
  for (const col of mpAttrColDefs || []) {
    if (col.mpAttr?.bucket !== 'ozon') continue;
    const fake = { id: col.mpAttr.attrId, name: col._humanName || col.label };
    if (!isOzonManufacturerArticleAttr(fake)) continue;
    if (str(next[col.key]) === v) continue;
    next = { ...next, [col.key]: v };
  }
  return next;
}

function mpColOwnedBySku(col) {
  return col?.dedicatedMainFieldKey === 'sku' || col?.linkFieldKey === 'sku';
}

function copyErpAttrToLinkedMp(row, erpCol, mp, labelMaps = bulkEditMpLabelMaps, mpAttrColDefs = []) {
  const fieldKey = erpCol?.linkFieldKey;
  if (!fieldKey || !isMpFieldLinked(normalizeMpFieldLinks(row?.mp_field_links), fieldKey, mp)) {
    return row;
  }
  const entries = normalizeAttrMpLinkList(erpCol?.erpAttr?.mpLinks?.[mp]);
  if (!entries.length) return row;
  const src = String(row[erpCol.key] ?? '');
  let next = row;
  let syncedOzonMfr = false;
  for (const entry of entries) {
    let target;
    try {
      target = resolveAttrMpLinkTarget(entry, mp, labelMaps);
    } catch {
      target = null;
    }
    if (!target) continue;
    if (target.kind === 'offer') {
      if (mp === 'ozon' && target.offerId === '__ozon_vendor_code__') {
        const mfrCol = (mpAttrColDefs || []).find(
          (c) =>
            c.mpAttr?.bucket === 'ozon' &&
            isOzonManufacturerArticleAttr({ id: c.mpAttr.attrId, name: c._humanName || c.label })
        );
        if (mfrCol && mpColOwnedBySku(mfrCol)) continue;
      }
      const seeded = {
        ...next,
        ym_draft: next.ym_draft || next._ymDraftBaseline,
        ozon_draft: next.ozon_draft || next._ozonDraftBaseline,
        wb_draft: next.wb_draft || next._wbDraftBaseline,
      };
      next = applyMpOfferFieldToForm(seeded, target.offerId, src);
      if (mp === 'ozon' && target.offerId === '__ozon_vendor_code__') syncedOzonMfr = true;
      continue;
    }
    if (!target.attrId) continue;
    const destKey = mpAttrColKey(mp, target.attrId);
    const destCol = (mpAttrColDefs || []).find((c) => c.key === destKey);
    if (destCol && mpColOwnedBySku(destCol)) continue;
    next = { ...next, [destKey]: src };
    if (mp === 'ozon' && isOzonManufacturerArticleAttr({ id: target.attrId, name: entry.name })) {
      syncedOzonMfr = true;
    }
  }
  if (syncedOzonMfr) next = syncOzonMfrArticleColsOnRow(next, src, mpAttrColDefs);
  return next;
}

/** Ячейка МП связана с «Основным» — в UI показываем зеркало Main, правка отвязывает. */
function isBulkLinkedMpReadonly(row, colKey, erpAttrCols = [], mpAttrCols = []) {
  const mpOffer = parseMpOfferFieldColKey(colKey);
  if (mpOffer) {
    const mp = mpBucketFromOfferFieldId(mpOffer.offerId);
    const links = normalizeMpFieldLinks(row?.mp_field_links);
    const pseudoCol = {
      key: colKey,
      mpBucket: mp,
      mpOfferField: { mp, offerId: mpOffer.offerId },
    };
    if (bulkMpColumnLinkActive(links, pseudoCol, erpAttrCols)) return true;
    return false;
  }
  const mpAttr = parseMpAttrColKey(colKey);
  if (mpAttr) {
    const col = (mpAttrCols || []).find((c) => c.key === colKey);
    if (col && bulkMpColumnLinkActive(row?.mp_field_links, col, erpAttrCols)) return true;
    return false;
  }
  const dedicatedOfferId = BULK_DEDICATED_OFFER_FIELD_BY_COL[colKey];
  if (dedicatedOfferId) {
    const mp = bulkMpCodeForColumn(colKey);
    return bulkMpColumnLinkActive(row?.mp_field_links, { key: colKey, mpBucket: mp }, erpAttrCols);
  }
  const fieldKey = bulkLinkFieldForColumn(colKey);
  const mp = bulkMpCodeForColumn(colKey);
  if (!fieldKey || !mp) return false;
  return isMpFieldLinked(normalizeMpFieldLinks(row?.mp_field_links), fieldKey, mp);
}

function productDimAxisForMpAttr(meta, mp) {
  return mp === 'wb' ? wbProductDimAxis(meta) || ozonProductDimAxis(meta) : ozonProductDimAxis(meta);
}

function mainProductDimDisplayForAxis(row, axis, lengthUnit, weightUnit) {
  if (axis === 'weight') return row.product_weight ?? '';
  if (axis === 'length') return row.product_length ?? '';
  if (axis === 'width') return row.product_width ?? '';
  if (axis === 'height') return row.product_height ?? '';
  return '';
}

/** Зеркало значения поля «Основное» для связанной колонки МП. */
function bulkMirrorFromMainFieldKey(row, fieldKey, colKey, lengthUnit, weightUnit) {
  const key = String(fieldKey || '');
  if (key === 'name') return row.name ?? '';
  if (key === 'description') return row.description ?? '';
  if (key === 'brand') return row.brand ?? '';
  if (key === 'country') return row.country_of_origin ?? '';
  if (key === 'sku') return row.sku ?? '';
  if (key === 'dimensions') {
    const dimKey = BULK_DIM_KEYS.find((d) => colKey === d || String(colKey).endsWith(`_pack_${d}`));
    return dimKey ? row[dimKey] ?? '' : row[colKey];
  }
  if (key === 'product_dimensions') {
    const base = productDimBaseKey(colKey);
    return base ? row[base] ?? '' : row[colKey];
  }
  return row[colKey] ?? '';
}

function findErpColForMpAttrMirror(erpAttrCols, mpAttr, col) {
  // Партномер, сопоставленный в категории с артикулом, не должен зеркалить OEM.
  if (col?.linkFieldKey === 'sku' || col?.dedicatedMainFieldKey === 'sku') return null;
  const attrName = col?._humanName || col?.label || '';
  const direct = findErpAttrColForMpAttr(
    erpAttrCols,
    mpAttr.mp,
    mpAttr.attrId,
    bulkEditMpLabelMaps,
    attrName
  );
  if (direct) return direct;
  if (mpAttr.mp === 'ozon' && isOzonManufacturerArticleAttr({ id: mpAttr.attrId, name: attrName })) {
    return findErpAttrColForMpOfferField(erpAttrCols, '__ozon_vendor_code__');
  }
  return null;
}

/** Ключ связи для колонки МП: сопоставление поля Main в категории (артикул) важнее OEM-атрибута. */
function resolveBulkMpColumnLinkFieldKey(col, erpAttrCols) {
  if (col?.dedicatedMainFieldKey) return col.dedicatedMainFieldKey;
  if (col?.linkFieldKey && isDedicatedMpFieldLinkKey(col.linkFieldKey)) return col.linkFieldKey;
  if (col?.mpAttr) {
    const erpCol = findErpColForMpAttrMirror(erpAttrCols, col.mpAttr, col);
    if (erpCol?.linkFieldKey) return erpCol.linkFieldKey;
  }
  const offerId =
    col?.mpOfferField?.offerId ||
    (col?.key ? BULK_DEDICATED_OFFER_FIELD_BY_COL[col.key] : null);
  if (offerId) {
    const erpCol = findErpAttrColForMpOfferField(erpAttrCols, offerId);
    if (erpCol?.linkFieldKey) return erpCol.linkFieldKey;
  }
  return col?.linkFieldKey || '';
}

function bulkMpColumnLinkKeys(col, erpAttrCols) {
  const keys = [];
  const resolved = resolveBulkMpColumnLinkFieldKey(col, erpAttrCols);
  if (resolved) keys.push(resolved);
  const dedicatedKey = bulkLinkFieldForColumn(col?.key);
  if (dedicatedKey && !keys.includes(dedicatedKey)) keys.push(dedicatedKey);
  if (
    col?.linkFieldKey &&
    isDedicatedMpFieldLinkKey(col.linkFieldKey) &&
    !keys.includes(col.linkFieldKey)
  ) {
    keys.push(col.linkFieldKey);
  }
  return keys;
}

function bulkMpColumnLinkActive(links, col, erpAttrCols) {
  const mp = col.mpBucket || col.mpAttr?.bucket || col.mpOfferField?.mp || bulkMpCodeForColumn(col.key);
  if (!mp) return false;
  const normalized = normalizeMpFieldLinks(links);
  return bulkMpColumnLinkKeys(col, erpAttrCols).some((k) => isMpFieldLinked(normalized, k, mp));
}

function bulkMirrorFromLinkKey(row, linkKey, colKey, erpAttrCols, lengthUnit, weightUnit) {
  if (isAttrMpFieldLinkKey(linkKey)) {
    const erpCol = (erpAttrCols || []).find((c) => c.linkFieldKey === linkKey);
    if (erpCol) return row[erpCol.key] ?? '';
  }
  if (isDedicatedMpFieldLinkKey(linkKey)) {
    return bulkMirrorFromMainFieldKey(row, linkKey, colKey, lengthUnit, weightUnit);
  }
  return row[colKey] ?? '';
}

function bulkMpAttrColumnLinkFieldKey(col, mpAttr, erpAttrCols) {
  const colWithAttr = col?.mpAttr ? col : mpAttr ? { ...col, mpAttr } : col;
  return resolveBulkMpColumnLinkFieldKey(colWithAttr, erpAttrCols);
}

/** Значение колонки МП при включённой связи: как на «Основном». */
function bulkLinkedMirrorValue(row, colKey, erpAttrCols = [], mpAttrCols = [], lengthUnit = 'mm', weightUnit = 'g') {
  const mpOffer = parseMpOfferFieldColKey(colKey);
  if (mpOffer) {
    const mp = mpBucketFromOfferFieldId(mpOffer.offerId);
    const links = normalizeMpFieldLinks(row.mp_field_links);
    const pseudoCol = {
      key: colKey,
      mpBucket: mp,
      mpOfferField: { mp, offerId: mpOffer.offerId },
    };
    for (const linkKey of bulkMpColumnLinkKeys(pseudoCol, erpAttrCols)) {
      if (!mp || !isMpFieldLinked(links, linkKey, mp)) continue;
      return bulkMirrorFromLinkKey(row, linkKey, colKey, erpAttrCols, lengthUnit, weightUnit);
    }
    const erpCol = findErpAttrColForMpOfferField(erpAttrCols, mpOffer.offerId);
    if (erpCol && isMpFieldLinked(links, erpCol.linkFieldKey, mp)) return row[erpCol.key] ?? '';
  }
  const mpAttr = parseMpAttrColKey(colKey);
  if (mpAttr) {
    const col = (mpAttrCols || []).find((c) => c.key === colKey);
    if (col?.linkFieldKey === 'product_dimensions') {
      const meta = { id: mpAttr.attrId, name: col._humanName || col.label };
      const axis = productDimAxisForMpAttr(meta, mpAttr.mp);
      if (axis === 'length' || axis === 'width' || axis === 'height' || axis === 'weight') {
        return mainProductDimDisplayForAxis(row, axis, lengthUnit, weightUnit);
      }
    }
    const linkKeys = bulkMpColumnLinkKeys(col, erpAttrCols);
    const links = normalizeMpFieldLinks(row.mp_field_links);
    for (const linkKey of linkKeys) {
      if (!isMpFieldLinked(links, linkKey, mpAttr.mp)) continue;
      if (linkKey === 'product_dimensions') {
        const meta = { id: mpAttr.attrId, name: col._humanName || col.label };
        const axis = productDimAxisForMpAttr(meta, mpAttr.mp);
        if (axis === 'length' || axis === 'width' || axis === 'height' || axis === 'weight') {
          return mainProductDimDisplayForAxis(row, axis, lengthUnit, weightUnit);
        }
      }
      return bulkMirrorFromLinkKey(row, linkKey, colKey, erpAttrCols, lengthUnit, weightUnit);
    }
    if (col?.dedicatedMainFieldKey !== 'sku' && col?.linkFieldKey !== 'sku') {
      const erpCol = findErpColForMpAttrMirror(erpAttrCols, mpAttr, col);
      if (erpCol && isMpFieldLinked(links, erpCol.linkFieldKey, mpAttr.mp)) {
        return row[erpCol.key] ?? '';
      }
    }
  }
  const dedicatedOfferId = BULK_DEDICATED_OFFER_FIELD_BY_COL[colKey];
  if (dedicatedOfferId) {
    const mp = bulkMpCodeForColumn(colKey);
    const links = normalizeMpFieldLinks(row.mp_field_links);
    const pseudoCol = { key: colKey, mpBucket: mp };
    for (const linkKey of bulkMpColumnLinkKeys(pseudoCol, erpAttrCols)) {
      if (!mp || !isMpFieldLinked(links, linkKey, mp)) continue;
      return bulkMirrorFromLinkKey(row, linkKey, colKey, erpAttrCols, lengthUnit, weightUnit);
    }
  }
  const fieldKey = bulkLinkFieldForColumn(colKey);
  const mp = bulkMpCodeForColumn(colKey);
  const links = normalizeMpFieldLinks(row.mp_field_links);
  if (fieldKey && mp && isMpFieldLinked(links, fieldKey, mp)) {
    return bulkMirrorFromMainFieldKey(row, fieldKey, colKey, lengthUnit, weightUnit);
  }
  return row[colKey];
}

function copyMainSkuToMp(row, mp, erpAttrCols = [], mpAttrColDefs = []) {
  const sku = String(row.sku ?? '');
  let next = row;
  const col = BULK_SKU_COLS[mp];
  if (col) next = { ...next, [col]: sku };
  let syncedOzonMfr = false;
  for (const c of mpAttrColDefs || []) {
    const cMp = c.mpBucket || c.mpAttr?.bucket || c.mpOfferField?.mp;
    if (cMp !== mp) continue;
    const linkKey = resolveBulkMpColumnLinkFieldKey(c, erpAttrCols);
    if (linkKey !== 'sku') continue;
    if (c.mpOfferField?.offerId) {
      next = applyMpOfferFieldToForm(rowAsOfferFieldForm(next), c.mpOfferField.offerId, sku);
      if (mp === 'ozon' && c.mpOfferField.offerId === '__ozon_vendor_code__') syncedOzonMfr = true;
      continue;
    }
    if (c.mpAttr) {
      if (str(next[c.key]) !== sku) next = { ...next, [c.key]: sku };
      if (mp === 'ozon' && isOzonManufacturerArticleAttr({ id: c.mpAttr.attrId, name: c._humanName || c.label })) {
        syncedOzonMfr = true;
      }
    }
  }
  if (syncedOzonMfr) {
    next = syncOzonMfrArticleColsOnRow(next, sku, mpAttrColDefs);
    next = applyMpOfferFieldToForm(rowAsOfferFieldForm(next), '__ozon_vendor_code__', sku);
  }
  return next;
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

function copyMainFieldToMp(row, fieldKey, mp, erpAttrCols = [], mpAttrColDefs = []) {
  if (fieldKey === 'sku') return copyMainSkuToMp(row, mp, erpAttrCols, mpAttrColDefs);
  if (fieldKey === 'name') return copyMainNameToMp(row, mp);
  if (fieldKey === 'description') return copyMainDescToMp(row, mp);
  if (fieldKey === 'brand') return copyMainBrandToMp(row, mp);
  if (fieldKey === 'country') return copyMainCountryToMp(row, mp);
  if (fieldKey === 'dimensions') return copyMainDimsToMp(row, mp);
  if (fieldKey === 'product_dimensions') return copyMainProductDimsToMp(row, mp);
  if (isAttrMpFieldLinkKey(fieldKey)) {
    const col = (erpAttrCols || []).find((c) => c.linkFieldKey === fieldKey);
    if (col) return copyErpAttrToLinkedMp(row, col, mp, bulkEditMpLabelMaps, mpAttrColDefs);
  }
  return row;
}

/**
 * После правки ячейки: при активной связи копируем значение в связанные МП только с «Основного».
 * Правка колонки МП — только эта ячейка (при связи отвязываем МП у строки).
 */
function withSyncedLinkedFields(row, key, value, erpAttrCols = [], mpAttrColDefs = []) {
  const erpCol = (erpAttrCols || []).find((c) => c.key === key && c.erpAttr);
  if (erpCol?.erpAttr) {
    let next = { ...row, [key]: value };
    const fieldKey = erpCol.linkFieldKey;
    const links = normalizeMpFieldLinks(row.mp_field_links);
    for (const mp of mappedMpsFromAttrLinks(erpCol.erpAttr?.mpLinks)) {
      if (fieldKey && isMpFieldLinked(links, fieldKey, mp)) {
        next = copyErpAttrToLinkedMp(next, erpCol, mp, bulkEditMpLabelMaps, mpAttrColDefs);
      }
    }
    return syncOfferFieldColsOnRow(next, mpAttrColDefs);
  }

  const mpOffer = parseMpOfferFieldColKey(key);
  if (mpOffer) {
    const linkedErp = findErpAttrColForMpOfferField(erpAttrCols, mpOffer.offerId);
    const mp = mpBucketFromOfferFieldId(mpOffer.offerId);
    let next = applyMpOfferFieldToForm(rowAsOfferFieldForm({ ...row, [key]: value }), mpOffer.offerId, value);
    next = { ...next, [key]: value };
    if (linkedErp && mp) {
      const fieldKey = linkedErp.linkFieldKey;
      const links = normalizeMpFieldLinks(row.mp_field_links);
      if (fieldKey && isMpFieldLinked(links, fieldKey, mp)) {
        next = {
          ...next,
          mp_field_links: setMpFieldLink(next.mp_field_links, fieldKey, mp, false),
        };
      }
    }
    return syncOfferFieldColsOnRow(next, mpAttrColDefs);
  }

  const mpAttr = parseMpAttrColKey(key);
  if (mpAttr) {
    const linkedErp = findErpAttrColForMpAttr(erpAttrCols, mpAttr.mp, mpAttr.attrId);
    const col = (mpAttrColDefs || []).find((c) => c.key === key);
    const fieldKey = linkedErp?.linkFieldKey || col?.linkFieldKey;
    const links = normalizeMpFieldLinks(row.mp_field_links);
    if (fieldKey && isMpFieldLinked(links, fieldKey, mpAttr.mp)) {
      return {
        ...row,
        [key]: value,
        mp_field_links: setMpFieldLink(row.mp_field_links, fieldKey, mpAttr.mp, false),
      };
    }
    return { ...row, [key]: value };
  }

  const fieldKey = bulkLinkFieldForColumn(key);
  const editedMp = bulkMpCodeForColumn(key);
  const links0 = normalizeMpFieldLinks(row.mp_field_links);

  // Правка колонки МП при связи атрибута — отвязать этот МП. Поля Main↔МП задаются в категории, не отвязываем.
  if (
    fieldKey &&
    editedMp &&
    !isDedicatedMpFieldLinkKey(fieldKey) &&
    isMpFieldLinked(links0, fieldKey, editedMp)
  ) {
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
      next[colsByMp[editedMp]] = value;
      next.mp_field_links = setMpFieldLink(next.mp_field_links, fieldKey, editedMp, false);
    }
  };

  if (fieldKey === 'sku') {
    syncScalar('sku', BULK_SKU_COLS);
    if (!editedMp) {
      for (const mp of ['ozon', 'wb', 'ym']) {
        if (isMpFieldLinked(links, 'sku', mp)) {
          next = copyMainSkuToMp(next, mp, erpAttrCols, mpAttrColDefs);
        }
      }
    }
    return next;
  }

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
      next[BULK_PACK_COLS[editedMp][dimKey]] = value;
      next.mp_field_links = setMpFieldLink(next.mp_field_links, 'dimensions', editedMp, false);
    }
  }
  return next;
}

function linksSignature(links) {
  return JSON.stringify(normalizeMpFieldLinks(links));
}

const BULK_PAGE_SIZES = [100, 200, 300, 500, 1000];
const BULK_PAGE_SIZE_LS = 'productsBulkEditPageSize';
/** Фильтры списка и выбор категории — переживают F5 (localStorage; миграция из sessionStorage) */
const LS_BULK_FILTERS = 'productsBulkEditFilters';
const SESSION_BULK_FILTERS = 'productsBulkEditFilters';
const SESSION_MP_OZON = 'productsBulkShowMpOzon';
const SESSION_MP_WB = 'productsBulkShowMpWb';
const SESSION_MP_YM = 'productsBulkShowMpYm';
/** Закреплённые столбцы (ключи), сразу справа от артикула */
const SESSION_PINNED_COLS = 'productsBulkPinnedCols';
/** Скрытые столбцы (ключи) */
const SESSION_HIDDEN_COLS = 'productsBulkHiddenCols';
/** Пользовательские ширины столбцов: { [key]: px } */
const SESSION_COL_WIDTHS = 'productsBulkColWidths';
/** Порядок незакреплённых столбцов (ключи) */
const SESSION_COL_ORDER = 'productsBulkColOrder';
const COL_WIDTH_MIN_PX = 40;
const COL_WIDTH_MAX_PX = 480;
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
        ? 'wb wildberries вб'
        : col?.mpBucket === 'ym'
          ? 'ym яндекс ям'
          : '';
  const shortTitle = String(col?.title || '').split('.')[0];
  return [col?.label, shortTitle, mp].filter(Boolean).join(' ').toLowerCase();
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

/** categoryId для API из значения селекта категории. */
function categoryIdFromScopePick(pick) {
  const v = String(pick || '').trim();
  if (!v || v === CATEGORY_SCOPE_UNSET || v === CATEGORY_SCOPE_ALL) return '';
  return v;
}

function productMatchesBulkCategory(product, categoryId) {
  const want = String(categoryId || '').trim();
  if (!want) return true;
  const cid = String(product?.user_category_id ?? product?.categoryId ?? '').trim();
  if (want === FILTER_CATEGORY_NONE) return !cid;
  return cid === want;
}

function readBulkPageSize() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BULK_PAGE_SIZE_LS) : null;
    const n = parseInt(raw, 10);
    return BULK_PAGE_SIZES.includes(n) ? n : 100;
  } catch {
    return 100;
  }
}

function readBulkEditFiltersStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LS_BULK_FILTERS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    }
    if (typeof sessionStorage !== 'undefined') {
      const leg = sessionStorage.getItem(SESSION_BULK_FILTERS);
      if (leg) {
        const parsed = JSON.parse(leg);
        if (parsed && typeof parsed === 'object') {
          writeBulkEditFiltersStorage(parsed);
          try {
            sessionStorage.removeItem(SESSION_BULK_FILTERS);
          } catch {
            /* ignore */
          }
          return parsed;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function writeBulkEditFiltersStorage(payload) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_BULK_FILTERS, JSON.stringify(payload));
    }
  } catch {
    /* ignore */
  }
}

function isBulkEditPageReload() {
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
      return false;
    }
    const nav = performance.getEntriesByType('navigation')[0];
    return nav?.type === 'reload';
  } catch {
    return false;
  }
}

/** Начальные фильтры: при F5 — только storage (history.state.filters устаревает). */
function resolveInitialBulkFilters(locationState) {
  const stored = readBulkEditFiltersStorage();
  if (isBulkEditPageReload() && stored && typeof stored === 'object') {
    return { ...stored };
  }
  return mergeBulkEditFilters(stored, locationState?.filters);
}

/** Слияние сохранённых фильтров с переданными при переходе со страницы «Товары». */
function mergeBulkEditFilters(stored, navFilters) {
  const base = stored && typeof stored === 'object' ? { ...stored } : {};
  const nav = navFilters && typeof navFilters === 'object' ? navFilters : null;
  if (!nav) return base;
  const out = { ...base };
  if (nav.organizationId != null) out.organizationId = String(nav.organizationId);
  if (nav.brandId != null) out.brandId = String(nav.brandId);
  if (nav.categoryId != null) {
    const cat = String(nav.categoryId);
    out.categoryId = cat;
    // Пустая категория со страницы «Товары» не должна оставлять старый pick в селекте.
    out.categoryPickDraft = cat.trim() === '' ? CATEGORY_SCOPE_ALL : cat;
  }
  if (nav.productType != null) out.productType = String(nav.productType).trim();
  if (nav.search != null) out.search = String(nav.search);
  if (nav.unlinkedMp != null) out.unlinkedMp = nav.unlinkedMp;
  if (nav.linkedMp != null) out.linkedMp = nav.linkedMp;
  if (nav.filtersOpen != null) out.filtersOpen = !!nav.filtersOpen;
  if (nav.categoryPickDraft != null) out.categoryPickDraft = String(nav.categoryPickDraft);
  return out;
}

function resolveInitialCategoryScope(locationState, filters) {
  const fromReload = isBulkEditPageReload();
  if (locationState?.createMode && !fromReload) {
    const cat =
      filters?.categoryId != null && String(filters.categoryId).trim() !== ''
        ? String(filters.categoryId)
        : '';
    return cat !== '';
  }
  if (!fromReload) {
    const ids = locationState?.selectedIds;
    if (Array.isArray(ids) && ids.length > 0) return true;
  }
  const pick = filters?.categoryPickDraft;
  if (pick && String(pick) !== CATEGORY_SCOPE_UNSET) return true;
  const cat = filters?.categoryId;
  return cat != null && String(cat).trim() !== '';
}

function resolveInitialCategoryPickDraft(locationState, filters) {
  const fromReload = isBulkEditPageReload();
  if (locationState?.createMode && !fromReload) {
    const cat =
      filters?.categoryId != null && String(filters.categoryId).trim() !== ''
        ? String(filters.categoryId)
        : '';
    return cat === '' ? CATEGORY_SCOPE_UNSET : cat;
  }
  if (!fromReload) {
    const ids = locationState?.selectedIds;
    if (Array.isArray(ids) && ids.length > 0) {
      const cat =
        filters?.categoryId != null && String(filters.categoryId).trim() !== ''
          ? String(filters.categoryId)
          : '';
      return cat === '' ? CATEGORY_SCOPE_ALL : cat;
    }
  }
  const pick = filters?.categoryPickDraft;
  if (pick && String(pick) !== CATEGORY_SCOPE_UNSET) return String(pick);
  const cat = filters?.categoryId;
  if (cat != null && String(cat).trim() !== '') return String(cat);
  return CATEGORY_SCOPE_UNSET;
}

/** Список грузим по тому же id, что показан в селекте. */
function resolveInitialFilterCategoryId(locationState, filters) {
  return categoryIdFromScopePick(resolveInitialCategoryPickDraft(locationState, filters));
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

function readColumnWidths() {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const raw = sessionStorage.getItem(SESSION_COL_WIDTHS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k || '').trim();
      const n = Number(v);
      if (!key || !Number.isFinite(n)) continue;
      out[key] = Math.max(COL_WIDTH_MIN_PX, Math.min(COL_WIDTH_MAX_PX, Math.round(n)));
    }
    return out;
  } catch {
    return {};
  }
}

function readColumnOrderKeys() {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    const raw = sessionStorage.getItem(SESSION_COL_ORDER);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((k) => String(k || '').trim())
      .filter((k) => k && k !== SELECT_COL_KEY && k !== DEFAULT_STICKY_COL_KEY);
  } catch {
    return [];
  }
}

function clampColWidthPx(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return COL_WIDTH_MIN_PX;
  return Math.max(COL_WIDTH_MIN_PX, Math.min(COL_WIDTH_MAX_PX, v));
}

/** Ширина по названию столбца; явный width у col и пользовательский override имеют приоритет. */
function colHeaderWidthPx(col, widthOverrides) {
  const key = col?.key;
  const ovr = key != null ? Number(widthOverrides?.[key]) : NaN;
  if (Number.isFinite(ovr) && ovr > 0) return clampColWidthPx(ovr);

  const explicit = Number(col?.width);
  if (Number.isFinite(explicit) && explicit > 0) return clampColWidthPx(explicit);

  if (key === SELECT_COL_KEY) return 40;

  const label = String(col?.label || '').trim();
  const labelW = label ? Math.ceil(label.length * 7.2) + 12 : 44;
  // иконки в отдельных строках — ширина в основном от названия / ряда МП
  let w = Math.max(48, labelW);
  if (col?.showLinkToggles) {
    const n =
      Array.isArray(col.linkSupportedMps) && col.linkSupportedMps.length
        ? col.linkSupportedMps.length
        : Array.isArray(col.mappedMps) && col.mappedMps.length
          ? col.mappedMps.length
          : 3;
    w = Math.max(w, 8 + n * 18);
  } else if (Array.isArray(col?.mappedMps) && col.mappedMps.length) {
    const n = col.mappedMps.length;
    w = Math.max(w, 8 + n * 18);
  } else if (!(col?.readonly || col?.noBulk) || key !== DEFAULT_STICKY_COL_KEY) {
    w = Math.max(w, 54); // скрыть + закрепить + заполнить
  }

  return Math.max(48, Math.min(200, w));
}

function colStickyWidthPx(col, widthOverrides) {
  return colHeaderWidthPx(col, widthOverrides);
}

function applyColumnOrder(cols, orderKeys) {
  const list = Array.isArray(cols) ? cols : [];
  if (!Array.isArray(orderKeys) || orderKeys.length === 0) return list;
  const byKey = new Map(list.map((c) => [c.key, c]));
  const used = new Set();
  const out = [];
  for (const key of orderKeys) {
    const col = byKey.get(key);
    if (!col || used.has(key)) continue;
    out.push(col);
    used.add(key);
  }
  for (const col of list) {
    if (used.has(col.key)) continue;
    out.push(col);
  }
  return out;
}

function reorderKeyList(keys, fromKey, toKey) {
  const arr = (keys || []).map((k) => String(k));
  const from = arr.indexOf(fromKey);
  const to = arr.indexOf(toKey);
  if (from < 0 || to < 0 || from === to) return keys || [];
  const next = [...arr];
  next.splice(from, 1);
  next.splice(to, 0, fromKey);
  return next;
}

/**
 * Артикул всегда слева; закреплённые — сразу после него; остальные в исходном / пользовательском порядке.
 */
function orderColumnsWithPins(cols, pinnedKeys, columnOrderKeys) {
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
  const rest = applyColumnOrder(
    list.filter((c) => !pinnedSet.has(c.key)),
    columnOrderKeys
  );
  const out = [];
  if (base) out.push(base);
  out.push(...pinned);
  out.push(...rest);
  return out;
}

function buildStickyLeftMap(displayCols, pinnedKeys, widthOverrides) {
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
    const width = colStickyWidthPx(col, widthOverrides);
    map.set(key, {
      left,
      width,
      /* body: выше обычных ячеек, ниже всей шапки; левее — выше соседей */
      zIndex: stickyKeys.length - i,
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
  { key: 'sku', label: 'Артикул', input: 'text', minW: 120, linkFieldKey: 'sku', showLinkToggles: true },
  { key: 'barcodes', label: 'ШК', title: 'Штрихкоды. Можно вставить свой или сгенерировать иконкой справа. Если пусто — перед отправкой на МП код создастся сам', input: 'textarea', minW: 148, hint: 'Через запятую или с новой строки. Свой ШК — в ячейку, новый — иконка справа' },
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
  { key: 'name', label: 'Название', input: 'textarea', minW: 160, linkFieldKey: 'name', showLinkToggles: true },
  { key: 'brand', label: 'Бренд', title: 'Основное · Бренд. Тумблеры OZ/WB/ЯМ связывают бренд с МП', input: 'text', minW: 90, linkFieldKey: 'brand', showLinkToggles: true },
  /* описание */
  { key: 'description', label: 'Описание', input: 'textarea', minW: 160, linkFieldKey: 'description', showLinkToggles: true },
  /* габариты товара (без упаковки) — вкладка «Основное» */
  { key: 'product_length', label: 'Длина тов.', title: 'Основное · Длина товара', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'product_dimensions', showLinkToggles: true },
  { key: 'product_width', label: 'Ширина тов.', title: 'Основное · Ширина товара', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'product_dimensions', showLinkToggles: true },
  { key: 'product_height', label: 'Высота тов.', title: 'Основное · Высота товара', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'product_dimensions', showLinkToggles: true },
  { key: 'product_weight', label: 'Вес тов.', title: 'Основное · Вес товара', input: 'number', minW: 88, dimKind: 'weight', linkFieldKey: 'product_dimensions', showLinkToggles: true },
  { key: 'length', label: 'Длина уп.', title: 'Основное · Длина упаковки', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'dimensions', showLinkToggles: true },
  { key: 'width', label: 'Ширина уп.', title: 'Основное · Ширина упаковки', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'height', label: 'Высота уп.', title: 'Основное · Высота упаковки', input: 'number', minW: 88, dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'weight', label: 'Вес уп.', title: 'Основное · Вес с упаковкой', input: 'number', minW: 88, dimKind: 'weight', linkFieldKey: 'dimensions' },
  /* остальное */
  { key: 'product_type', label: 'Тип', input: 'select_type', minW: 80 },
  { key: 'categoryId', label: 'Категория', title: 'Категория', input: 'select_category', minW: 120 },
  { key: 'organizationId', label: 'Организация', title: 'Организация', input: 'select_org', minW: 120 },
  { key: 'supplierId', label: 'Пост.', title: 'Поставщик', input: 'select_supplier', minW: 120 },
  { key: 'cost', label: 'Себест.', title: 'Себестоимость', input: 'number', minW: 80 },
  { key: 'additionalExpenses', label: 'Доп. р.', title: 'Доп. расходы', input: 'number', minW: 80 },
  { key: 'minPrice', label: 'Мин. ц.', title: 'Мин. цена', input: 'number', minW: 72 },
  { key: 'buyout_rate', label: 'Выкуп %', input: 'number', minW: 72 },
  { key: 'country_of_origin', label: 'Страна', title: 'Основное · Страна производителя. Тумблеры OZ/WB/ЯМ связывают страну с МП', input: 'text', minW: 80, linkFieldKey: 'country', showLinkToggles: true },
  /* ——— Ozon ——— */
  { key: 'sku_ozon', label: 'offer_id', title: 'Ozon · offer_id', input: 'text', minW: 90, mpBucket: 'ozon', linkFieldKey: 'sku' },
  { key: 'ozon_product_id', label: 'product_id', title: 'Ozon · product_id', input: 'text', minW: 90, mpBucket: 'ozon' },
  /* Длина/ширина/высота товара Ozon — характеристики, не отдельные колонки */
  { key: 'ozon_product_weight', label: 'Вес тов.', title: 'Ozon · Вес товара', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'weight', linkFieldKey: 'product_dimensions' },
  { key: 'ozon_pack_length', label: 'Длина уп.', title: 'Ozon · Длина упаковки', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'ozon_pack_width', label: 'Ширина уп.', title: 'Ozon · Ширина упаковки', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'ozon_pack_height', label: 'Высота уп.', title: 'Ozon · Высота упаковки', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'ozon_pack_weight', label: 'Вес уп.', title: 'Ozon · Вес с упаковкой', input: 'number', minW: 88, mpBucket: 'ozon', dimKind: 'weight', linkFieldKey: 'dimensions' },
  /* Бренд, страна, название и аннотация Ozon — характеристики, не отдельные колонки */
  /* ——— Wildberries ——— */
  { key: 'mp_wb_name', label: 'Название', title: 'Wildberries · Название', input: 'textarea', minW: 140, mpBucket: 'wb', linkFieldKey: 'name' },
  { key: 'mp_wb_description', label: 'Описание', title: 'Wildberries · Описание', input: 'textarea', minW: 140, mpBucket: 'wb', linkFieldKey: 'description' },
  { key: 'sku_wb', label: 'nmId', title: 'Wildberries · nmId', input: 'text', minW: 80, mpBucket: 'wb' },
  { key: 'mp_wb_vendor_code', label: 'Арт. прод.', title: 'Wildberries · Артикул продавца', input: 'text', minW: 100, mpBucket: 'wb', linkFieldKey: 'sku' },
  /* Длина/ширина/высота товара WB — характеристики, не отдельные колонки */
  { key: 'wb_product_weight', label: 'Вес тов.', title: 'Wildberries · Вес товара', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'weight', linkFieldKey: 'product_dimensions' },
  { key: 'wb_pack_length', label: 'Длина уп.', title: 'Wildberries · Длина упаковки', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'wb_pack_width', label: 'Ширина уп.', title: 'Wildberries · Ширина упаковки', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'wb_pack_height', label: 'Высота уп.', title: 'Wildberries · Высота упаковки', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'wb_pack_weight', label: 'Вес уп.', title: 'Wildberries · Вес с упаковкой', input: 'number', minW: 88, mpBucket: 'wb', dimKind: 'weight', linkFieldKey: 'dimensions' },
  { key: 'mp_wb_brand', label: 'Бренд', title: 'Wildberries · Бренд', input: 'text', minW: 90, mpBucket: 'wb', linkFieldKey: 'brand' },
  { key: 'wb_country', label: 'Страна', title: 'Wildberries · Страна производителя', input: 'text', minW: 80, mpBucket: 'wb', linkFieldKey: 'country' },
  /* ——— Яндекс.Маркет ——— */
  { key: 'mp_ym_name', label: 'Название', title: 'Яндекс.Маркет · Название', input: 'textarea', minW: 140, mpBucket: 'ym', linkFieldKey: 'name' },
  { key: 'mp_ym_description', label: 'Описание', title: 'Яндекс.Маркет · Описание', input: 'textarea', minW: 140, mpBucket: 'ym', linkFieldKey: 'description' },
  { key: 'sku_ym', label: 'offerId', title: 'Яндекс.Маркет · offerId (артикул продавца)', input: 'text', minW: 90, mpBucket: 'ym', linkFieldKey: 'sku' },
  { key: 'ym_vendor_code', label: 'Арт. произв.', title: 'Яндекс.Маркет · Артикул производителя (vendorCode)', input: 'text', minW: 110, mpBucket: 'ym' },
  { key: 'ym_pack_length', label: 'Длина уп.', title: 'Яндекс.Маркет · Длина упаковки', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'ym_pack_width', label: 'Ширина уп.', title: 'Яндекс.Маркет · Ширина упаковки', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'ym_pack_height', label: 'Высота уп.', title: 'Яндекс.Маркет · Высота упаковки', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'length', linkFieldKey: 'dimensions' },
  { key: 'ym_pack_weight', label: 'Вес уп.', title: 'Яндекс.Маркет · Вес с упаковкой', input: 'number', minW: 88, mpBucket: 'ym', dimKind: 'weight', linkFieldKey: 'dimensions' },
  { key: 'ym_country', label: 'Страна', title: 'Яндекс.Маркет · Страна производителя', input: 'text', minW: 80, mpBucket: 'ym', linkFieldKey: 'country' },
];

function withDisplayUnitLabels(cols, lengthUnit) {
  const L = lengthUnitLabel(lengthUnit);
  return (cols || []).map((c) => {
    const strip = (s) =>
      String(s || '')
        .replace(/\s*\((мм|см|г|кг)\)\s*$/i, '')
        .trim();
    // Dedicated габариты/вес — короткие заголовки без единиц
    if (c.dimKind === 'length' || c.dimKind === 'weight') {
      return { ...c, label: strip(c.label), title: strip(c.title || c.label) };
    }
    const human = String(c._humanName || c.label || '');
    const h = human.toLowerCase();
    if (!c.mpAttr) return c;
    const base = strip(c.label);
    if (/вес/.test(h)) {
      return { ...c, label: base, title: strip(c.title || base) };
    }
    if (/(длина|ширина|высота|глубина)/.test(h)) {
      return { ...c, label: `${base} (${L})`, title: `${strip(c.title || base)} (${L})` };
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
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x && typeof x === 'object') {
          return stringifyMpAttrValue(x);
        }
        return String(x ?? '').trim();
      })
      .filter(Boolean)
      .join('; ');
  }
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
  if (baselineRaw && typeof baselineRaw === 'object' && !Array.isArray(baselineRaw)) {
    const shown = stringifyMpAttrValue(baselineRaw);
    if (shown && (shown === t || formatOzonAttrDisplayValue(shown) === t)) return baselineRaw;
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

/** При связи product_dimensions дописать L/W/H/вес в JSON-атрибуты МП (в т.ч. скрытые дубликаты). */
function mergeLinkedProductDimIntoMpAttrs(
  attrs,
  row,
  mpAttrColDefs,
  bucket,
  links,
  lengthUnit,
  weightUnit
) {
  if (!isMpFieldLinked(links, 'product_dimensions', bucket)) return attrs;
  const out = { ...(attrs || {}) };
  const mmOf = {
    length: lengthDisplayToMm(row.product_length, lengthUnit),
    width: lengthDisplayToMm(row.product_width, lengthUnit),
    height: lengthDisplayToMm(row.product_height, lengthUnit),
    weight: weightDisplayToG(row.product_weight, weightUnit),
  };
  const seen = new Set((mpAttrColDefs || []).filter((c) => c.mpAttr?.bucket === bucket).map((c) => String(c.mpAttr.attrId)));
  for (const id of Object.keys(row._mpAttrBaseline?.[bucket] || {})) seen.add(String(id));
  for (const id of seen) {
    const col = (mpAttrColDefs || []).find((c) => c.mpAttr?.bucket === bucket && String(c.mpAttr.attrId) === id);
    const meta = { id, name: col?._humanName || col?.label || knownMpAttrLabel(bucket, id) };
    const axis = productDimAxisForMpAttr(meta, bucket);
    if (axis !== 'length' && axis !== 'width' && axis !== 'height' && axis !== 'weight') continue;
    const stored = productDimAttrStoredFromMm(meta, mmOf[axis], bucket);
    if (stored === '') delete out[id];
    else out[id] = stored;
  }
  return out;
}

function collectAttrKeySets(products) {
  const oz = new Set();
  const wb = new Set();
  const ym = new Set();
  for (const p of products) {
    if (!p) continue;
    Object.keys(normalizeJsonAttrs(p.ozon_attributes)).forEach((k) => {
      if (!String(k).startsWith('__')) oz.add(String(k));
    });
    Object.keys(normalizeJsonAttrs(p.wb_attributes)).forEach((k) => {
      if (!String(k).startsWith('__')) wb.add(String(k));
    });
    Object.keys(normalizeJsonAttrs(p.ym_attributes)).forEach((k) => {
      if (!String(k).startsWith('__')) ym.add(String(k));
    });
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
  if (k.startsWith(MP_OFFER_COL_PREFIX)) return 2;
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
      rank: c.mpOfferField
        ? dedicatedMpColSortRank(c)
        : mpAttrSortRankFromHuman(c._humanName || c.label || ''),
      tie: String(c.mpAttr?.attrId || c.mpOfferField?.offerId || c.key),
    })),
  ];
  tagged.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // внутри одного ранга: сначала dedicated, потом attrs / offer
    const ad = a.c.mpAttr || a.c.mpOfferField ? 1 : 0;
    const bd = b.c.mpAttr || b.c.mpOfferField ? 1 : 0;
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

function unwrapMpAttrList(res) {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== 'object') return [];
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.result)) return res.result;
  if (Array.isArray(res.parameters)) return res.parameters;
  if (Array.isArray(res.attributes)) return res.attributes;
  if (res.data && typeof res.data === 'object' && Array.isArray(res.data.data)) return res.data.data;
  return [];
}

function ozonSchemaKind(a) {
  if (isOzonManufacturerArticleAttr(a) || isStandaloneOemAttrName(a?.name)) return 'text';
  const dictionaryIdRaw = a?.dictionary_id ?? a?.dictionaryId;
  const dictionaryId =
    dictionaryIdRaw != null && Number(dictionaryIdRaw) !== 0 ? Number(dictionaryIdRaw) : 0;
  if (dictionaryId) return 'dictionary';
  const t = String(a?.type || '').toLowerCase();
  if (t === 'boolean' || (t === 'string' && a?.is_aspect)) return 'boolean';
  if (t === 'integer' || t === 'decimal' || t === 'number' || t === 'float') return 'number';
  return 'text';
}

function extractYmDictionaryOptions(a) {
  const raw =
    (Array.isArray(a?.dictionary_options) && a.dictionary_options) ||
    (Array.isArray(a?.values) && a.values) ||
    (Array.isArray(a?.options) && a.options) ||
    [];
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    if (o == null) continue;
    let id = '';
    let label = '';
    if (typeof o === 'string' || typeof o === 'number') {
      id = String(o);
      label = String(o);
    } else {
      if (o.id == null && o.value == null) continue;
      id = o.id != null ? String(o.id) : String(o.value);
      label = String(o.label ?? o.value ?? o.description ?? o.name ?? id).trim() || id;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, value: id });
  }
  return out.length ? out : null;
}

function ymSchemaKind(a, options) {
  const t = String(a?.type || a?.ym_parameter_type || '').toLowerCase();
  if (options && options.length) return 'dictionary';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'number' || t === 'numeric' || t === 'integer' || t === 'decimal' || t === 'float') {
    return 'number';
  }
  return 'text';
}

function mpAttrInputFromKind(mp, kind) {
  if (kind === 'dictionary') return 'select_dict';
  if (kind === 'boolean') return mp === 'ozon' ? 'checkbox' : 'select_bool';
  if (kind === 'number') return 'number';
  return 'textarea';
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
    const kind = ozonSchemaKind(a);
    const prev = into[id];
    if (!prev) {
      into[id] = { name, dictionaryId, kind };
    } else {
      if (!prev.name && name) prev.name = name;
      if (!prev.dictionaryId && dictionaryId) prev.dictionaryId = dictionaryId;
      if (!prev.kind && kind) prev.kind = kind;
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
      into[id] = { name, options, kind: options ? 'dictionary' : 'text' };
    } else {
      if (!prev.name && name) prev.name = name;
      if ((!prev.options || !prev.options.length) && options) {
        prev.options = options;
        prev.kind = 'dictionary';
      }
    }
  }
}

function mergeYmAttrSchema(list, into) {
  if (!Array.isArray(list) || !into) return;
  for (const a of list) {
    const idRaw = a?.id ?? a?.parameterId ?? a?.parameter_id;
    const id = idRaw != null ? String(idRaw) : '';
    if (!id) continue;
    const name = String(a?.name || a?.title || a?.description || '').trim() || `Параметр ${id}`;
    const options = extractYmDictionaryOptions(a);
    const kind = ymSchemaKind(a, options);
    const prev = into[id];
    if (!prev) {
      into[id] = { name, options, kind };
    } else {
      if (!prev.name && name) prev.name = name;
      if ((!prev.options || !prev.options.length) && options) prev.options = options;
      if (!prev.kind || prev.kind === 'text') prev.kind = kind;
    }
  }
}

/** Категории, для которых в массовом редактировании нужна схема МП и сопоставления. */
function resolveBulkEditCategoryIds(categories, filterCategoryId, products, scopeCategoryIds) {
  const catId = String(filterCategoryId || '').trim();
  if (catId === FILTER_CATEGORY_NONE) return [];
  if (catId) return [catId];
  const scoped = [...new Set((scopeCategoryIds || []).map((x) => String(x).trim()).filter(Boolean))];
  if (scoped.length) return scoped;
  const out = new Set();
  for (const p of products || []) {
    const cid = p?.user_category_id ?? p?.categoryId;
    if (cid != null && String(cid).trim() !== '') out.add(String(cid));
  }
  return [...out];
}

/** Загрузить DISTINCT ERP-категории по текущим фильтрам списка (не только текущая страница). */
async function fetchBulkEditScopeCategoryIds(baseParams, selectedIds, filterCategoryId) {
  const catId = String(filterCategoryId || '').trim();
  if (catId === FILTER_CATEGORY_NONE) return [];
  if (catId) return [catId];
  try {
    const res = await productsApi.getDistinctUserCategoryIds({
      ...baseParams,
      ids: Array.isArray(selectedIds) && selectedIds.length > 0 ? selectedIds : undefined,
      cacheBust: true,
    });
    const data = res?.data ?? res;
    return Array.isArray(data) ? data.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Имена характеристик из сопоставлений категории (пока схема МП не подгрузилась). */
function seedMpLabelMapsFromCategoryLinks(
  categories,
  filterCategoryId,
  products,
  erpCols = [],
  scopeCategoryIds = []
) {
  const maps = { ozon: {}, wb: {}, ym: {} };
  const put = (mp, id, name) => {
    const aid = String(id || '').trim();
    const n = String(name || '').trim();
    if (!aid || !n || !maps[mp]) return;
    const prev = maps[mp][aid];
    if (!prev) maps[mp][aid] = { name: n };
    else if (!prev.name) prev.name = n;
  };
  for (const erp of erpCols || []) {
    const links = erp?.erpAttr?.mpLinks || {};
    for (const mp of ATTR_MP_CODES) {
      for (const entry of normalizeAttrMpLinkList(links[mp])) {
        put(mp, entry.id, entry.name);
      }
    }
  }
  const cats = categories || [];
  const catIds = new Set(
    resolveBulkEditCategoryIds(categories, filterCategoryId, products, scopeCategoryIds)
  );
  for (const c of cats) {
    if (catIds.size && !catIds.has(String(c.id))) continue;
    const attrMap = c?.attribute_mp_links && typeof c.attribute_mp_links === 'object' ? c.attribute_mp_links : {};
    for (const raw of Object.values(attrMap)) {
      const links = normalizeAttrMpLinks(raw);
      for (const mp of ATTR_MP_CODES) {
        for (const entry of links[mp] || []) put(mp, entry.id, entry.name);
      }
    }
    const dedicated = normalizeCategoryDedicatedCharcLinks(c?.mp_field_links);
    for (const [key, slot] of Object.entries(dedicated)) {
      if (key === DEDICATED_ADDED_KEYS_FIELD || !slot || typeof slot !== 'object' || Array.isArray(slot)) {
        continue;
      }
      for (const mp of ATTR_MP_CODES) {
        for (const entry of normalizeAttrMpLinkList(slot[mp])) put(mp, entry.id, entry.name);
      }
    }
  }
  return maps;
}

function mergeMpLabelMaps(...parts) {
  const out = { ozon: {}, wb: {}, ym: {}, ozonPairs: [] };
  for (const part of parts) {
    if (!part) continue;
    for (const mp of ['ozon', 'wb', 'ym']) {
      for (const [id, meta] of Object.entries(part[mp] || {})) {
        const prev = out[mp][id];
        if (!prev) {
          out[mp][id] = { ...(typeof meta === 'object' && meta ? meta : { name: String(meta || '') }) };
          continue;
        }
        const name = schemaAttrName(meta);
        if (name && !schemaAttrName(prev)) prev.name = name;
        if (meta && typeof meta === 'object') {
          if (!prev.options?.length && meta.options?.length) prev.options = meta.options;
          if (!prev.dictionaryId && meta.dictionaryId) prev.dictionaryId = meta.dictionaryId;
          if ((!prev.kind || prev.kind === 'text') && meta.kind) prev.kind = meta.kind;
        }
      }
    }
    if (Array.isArray(part.ozonPairs) && part.ozonPairs.length) {
      out.ozonPairs = [...out.ozonPairs, ...part.ozonPairs];
    }
  }
  return out;
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
async function fetchMpAttributeLabelMaps(
  products,
  categories,
  filterCategoryId,
  fallbackOrganizationId,
  scopeCategoryIds = []
) {
  const maps = { ozon: {}, wb: {}, ym: {}, ozonPairs: [] };
  const catIds = resolveBulkEditCategoryIds(
    categories,
    filterCategoryId,
    products,
    scopeCategoryIds
  );
  if (catIds.length === 0) return maps;

  const orgByCat = new Map();
  let fallbackOrg = String(fallbackOrganizationId || '').trim();
  for (const p of products || []) {
    const cid = String(p?.user_category_id ?? p?.categoryId ?? '').trim();
    const oid = String(p.organizationId ?? p.organization_id ?? '').trim();
    if (oid && !fallbackOrg) fallbackOrg = oid;
    if (cid && oid && !orgByCat.has(cid)) orgByCat.set(cid, oid);
  }
  for (const cid of catIds) {
    if (orgByCat.has(cid) || !fallbackOrg) continue;
    orgByCat.set(cid, fallbackOrg);
  }

  const markets = /** @type {const} */ (['ozon', 'wb', 'ym']);
  const tasks = [];
  for (const catId of catIds) {
    for (const mp of markets) {
      tasks.push({ catId, mp, organizationId: orgByCat.get(catId) || fallbackOrg || undefined });
    }
  }
  const BATCH = 8;
  for (let i = 0; i < tasks.length; i += BATCH) {
    const chunk = tasks.slice(i, i + BATCH);
    const settled = await Promise.all(
      chunk.map(({ catId, mp, organizationId }) =>
        userCategoriesApi
          .getMarketplaceAttributes(catId, mp, { organizationId })
          .catch(() => null)
      )
    );
    chunk.forEach(({ mp }, j) => {
      const res = settled[j];
      const body = unwrapMpAttrList(res?.data ?? res);
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
    if (col?.mpAttr?.bucket === 'ozon') {
      if (
        !isOzonManufacturerCountryAttr({
          id: col.mpAttr.attrId,
          name: col._humanName || col.label,
        })
      ) {
        continue;
      }
    } else if (!isCountryLikeAttrName(col._humanName || col.label)) {
      continue;
    }
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

function applyLinkedBrandToOzonAttrColumns(row, brandText, mpAttrCols, ozonDictByAttr = {}) {
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  const text = String(brandText ?? '').trim();
  if (!text || !Array.isArray(mpAttrCols) || mpAttrCols.length === 0) return row;
  if (!isMpFieldLinked(links, 'brand', 'ozon')) return row;
  let next = row;
  let changed = false;
  for (const col of mpAttrCols) {
    if (col?.mpAttr?.bucket !== 'ozon') continue;
    if (
      !isOzonBrandAttr({
        id: col.mpAttr.attrId,
        name: col._humanName || col.label,
      })
    ) {
      continue;
    }
    const attrId = String(col.mpAttr.attrId);
    const options =
      (Array.isArray(col.dictOptions) && col.dictOptions.length ? col.dictOptions : null) ||
      ozonDictByAttr[attrId] ||
      ozonDictByAttr[Number(attrId)] ||
      [];
    const encoded = encodeDictFromPlainText(text, options, 'ozon');
    if (str(next[col.key]) === str(encoded)) continue;
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    next[col.key] = encoded;
  }
  return next;
}

function applyLinkedOzonTextAttrColumns(row, text, fieldKey, matchAttr, mpAttrCols) {
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  if (!isMpFieldLinked(links, fieldKey, 'ozon')) return row;
  if (!Array.isArray(mpAttrCols) || mpAttrCols.length === 0) return row;
  const value = String(text ?? '');
  let next = row;
  let changed = false;
  for (const col of mpAttrCols) {
    if (col?.mpAttr?.bucket !== 'ozon') continue;
    if (
      !matchAttr({
        id: col.mpAttr.attrId,
        name: col._humanName || col.label,
      })
    ) {
      continue;
    }
    if (str(next[col.key]) === str(value)) continue;
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    next[col.key] = value;
  }
  return next;
}

function applyLinkedMpProductDimAttrColumns(row, mpAttrCols, lengthUnit = 'mm', weightUnit = 'g') {
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  if (!Array.isArray(mpAttrCols) || mpAttrCols.length === 0) return row;
  const mmOf = {
    length: lengthDisplayToMm(row.product_length, lengthUnit),
    width: lengthDisplayToMm(row.product_width, lengthUnit),
    height: lengthDisplayToMm(row.product_height, lengthUnit),
    weight: weightDisplayToG(row.product_weight, weightUnit),
  };
  let next = row;
  let changed = false;
  for (const col of mpAttrCols) {
    const mp = col?.mpAttr?.bucket;
    if (mp !== 'ozon' && mp !== 'wb' && mp !== 'ym') continue;
    if (!isMpFieldLinked(links, 'product_dimensions', mp)) continue;
    const meta = { id: col.mpAttr.attrId, name: col._humanName || col.label };
    const axis = productDimAxisForMpAttr(meta, mp);
    if (axis !== 'length' && axis !== 'width' && axis !== 'height' && axis !== 'weight') continue;
    const value = productDimAttrStoredFromMm(meta, mmOf[axis], mp);
    if (str(next[col.key]) === str(value)) continue;
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    next[col.key] = value;
  }
  return next;
}

function applyLinkedOzonProductDimAttrColumns(row, mpAttrCols, lengthUnit = 'mm', weightUnit = 'g') {
  return applyLinkedMpProductDimAttrColumns(row, mpAttrCols, lengthUnit, weightUnit);
}

function applyLinkedOzonNameAndAnnotationColumns(row, mpAttrCols, lengthUnit = 'mm', weightUnit = 'g') {
  let next = applyLinkedOzonTextAttrColumns(row, row?.name, 'name', isOzonNameAttr, mpAttrCols);
  next = applyLinkedOzonTextAttrColumns(
    next,
    next?.description,
    'description',
    isOzonAnnotationAttr,
    mpAttrCols
  );
  return applyLinkedOzonProductDimAttrColumns(next, mpAttrCols, lengthUnit, weightUnit);
}

function hydrateMpAttrCellsFromBaseline(row, mpAttrCols) {
  if (!row || !Array.isArray(mpAttrCols) || mpAttrCols.length === 0) return row;
  let next = row;
  let changed = false;
  for (const col of mpAttrCols) {
    if (!col?.mpAttr) continue;
    const cur = str(next[col.key]).trim();
    if (cur) continue;
    const src = next._mpAttrBaseline?.[col.mpAttr.bucket];
    const existing = stringifyMpAttrValue(src?.[col.mpAttr.attrId]);
    if (!existing) continue;
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    next[col.key] = existing;
  }
  return next;
}

function syncOzonCardTextFromAttrColumn(row, col, value) {
  if (col?.mpAttr?.bucket !== 'ozon') return row;
  const meta = { id: col.mpAttr.attrId, name: col._humanName || col.label };
  if (isOzonNameAttr(meta)) return { ...row, mp_ozon_name: value };
  if (isOzonAnnotationAttr(meta)) return { ...row, mp_ozon_description: value };
  return row;
}

function unlinkProductDimsIfMpDimAttrEdited(row, col) {
  const mp = col?.mpAttr?.bucket;
  if (!mp) return row;
  const meta = { id: col.mpAttr.attrId, name: col._humanName || col.label };
  const axis = mp === 'wb' ? wbProductDimAxis(meta) : ozonProductDimAxis(meta);
  if (axis !== 'length' && axis !== 'width' && axis !== 'height') return row;
  const links = normalizeMpFieldLinks(row?.mp_field_links);
  if (!isMpFieldLinked(links, 'product_dimensions', mp)) return row;
  return row;
}

function knownMpAttrLabel(bucket, attrId) {
  const id = String(attrId ?? '');
  const b = String(bucket || '').toLowerCase();
  if (b === 'ym' && id === '72668284') return 'Маркировка ТН ВЭД';
  if (b === 'wb') {
    if (id === WB_ITEM_DIM_CHARC.length) return 'Длина';
    if (id === WB_ITEM_DIM_CHARC.width) return 'Ширина';
    if (id === WB_ITEM_DIM_CHARC.height) return 'Высота';
  }
  return '';
}

/** Подпись столбца МП — как в схеме маркетплейса (без переименований вроде «Аналоги»). */
function formatMpColumnLabel(attrId, humanName, bucket = '') {
  const id = String(attrId);
  const h = humanName && String(humanName).trim()
    ? String(humanName).trim()
    : knownMpAttrLabel(bucket, id);
  if (h) return h;
  return `id ${id}`;
}

/** Подпись вида «id 123» — ещё не резолвнули имя характеристики. */
function isUnresolvedMpAttrLabel(label, attrId) {
  const id = String(attrId ?? '').trim();
  const s = String(label || '').trim();
  if (!s) return true;
  if (id && (s === id || s === `id ${id}` || s === `Параметр ${id}`)) return true;
  return /^id\s+\d+$/i.test(s);
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
  if (isStandaloneOemAttrName(raw)) return false;
  const h = raw.toLowerCase();
  const short = bucket === 'ozon' ? 'Ozon' : bucket === 'wb' ? 'WB' : 'ЯМ';
  const flat = `${short}: ${raw}`.toLowerCase();
  if (DUPLICATE_MP_CARD_ATTR_LABELS.has(flat)) return true;

  if (bucket === 'ozon') {
    if (isOzonPlainDescriptionAttr({ name: raw })) return true;
    const kind = classifyMarketplaceDimAttrName(raw);
    if (kind === 'pack') return true;
    const axis = ozonProductDimAxis(raw);
    if (kind === 'product' && axis !== 'length' && axis !== 'width' && axis !== 'height') return true;
    return false;
  }

  if (bucket === 'wb') {
    if (isWbCharcDuplicatingDedicatedField(raw)) return true;
    const kind = classifyMarketplaceDimAttrName(raw);
    if (kind === 'pack') return true;
    const axis = ozonProductDimAxis(raw);
    if (kind === 'product' && axis !== 'length' && axis !== 'width' && axis !== 'height') return true;
    if (/(длина|ширина|высота)/.test(h) && /упаковк|габарит/.test(h)) return true;
    if (/вес/.test(h) && /упаковк|брутто|brutto/.test(h)) return true;
    return false;
  }

  if (bucket === 'ym') {
    if (isYmOfferFieldParamName(raw)) return true;
    if (h === 'название' || h === 'название товара' || (h.startsWith('название') && !h.includes('модели') && !h.includes('группы'))) {
      return true;
    }
    if ((h.includes('описание') && (h.includes('товар') || h.includes('карточк'))) || h === 'описание товара') return true;
    const kind = classifyMarketplaceDimAttrName(raw);
    if (kind === 'pack') return true;
    if (kind === 'product') return true;
    if (/(длина|ширина|высота)/.test(h) && /упаковк|габарит/.test(h)) return true;
    if (/вес/.test(h) && /упаковк/.test(h)) return true;
    if ((h === 'вес' || h === 'вес товара' || /^вес товара\b/.test(h)) && !/упаковк/.test(h)) return true;
    return false;
  }

  return false;
}

/** Известные id атрибутов Ozon для габаритов/веса упаковки — не дублируем столбцами JSON */
const OZON_PACK_DIM_ATTR_IDS = new Set(['9802', '6605', '6606', '4497', '4383', '9799', '6859']);
/** charcID габаритов упаковки WB — не дублируем (вес — в wb_pack_weight; L/W/H товара — JSON-колонки) */
const WB_PACK_DIM_ATTR_IDS = new Set(['90849', '90745', '90846']);

/** Столбцы по объединению ключей атрибутов по всем загруженным товарам */
function buildMpAttrColumnDefs(products, labelMaps = { ozon: {}, wb: {}, ym: {} }) {
  const { oz, wb, ym } = collectAttrKeySets(products);
  const ozM = labelMaps?.ozon || {};
  const wbM = labelMaps?.wb || {};
  const ymM = labelMaps?.ym || {};
  const cols = [];
  for (const id of sortAttrIdsWithLabels(oz, ozM)) {
    if (isMpOfferFieldAttrId(id) || OZON_PACK_DIM_ATTR_IDS.has(String(id))) continue;
    const meta = ozM[id] || ozM[String(id)];
    const human = schemaAttrName(meta) || knownMpAttrLabel('ozon', id);
    if (isDuplicateMpCardJsonAttr('ozon', human)) continue;
    const dictionaryId = Number(meta?.dictionaryId) || 0;
    const isDict = dictionaryId > 0 || meta?.kind === 'dictionary';
    const kind = isDict ? 'dictionary' : meta?.kind || 'text';
    const input = mpAttrInputFromKind('ozon', kind);
    cols.push({
      key: `__mpAttr__ozon__${id}`,
      label: formatMpColumnLabel(id, human, 'ozon'),
      title: mpColumnTitleAttr('ozon', id, human, isDict),
      headerClass: 'mp-attr-head',
      input,
      minW: isDict ? 140 : 120,
      mpBucket: 'ozon',
      mpAttr: { bucket: 'ozon', attrId: id },
      dictionaryId: isDict ? dictionaryId : 0,
      dictOptions: null,
      _humanName: human || '',
    });
  }
  for (const id of sortAttrIdsWithLabels(wb, wbM)) {
    if (isMpOfferFieldAttrId(id) || WB_PACK_DIM_ATTR_IDS.has(String(id))) continue;
    const meta = wbM[id] || wbM[String(id)];
    const human = schemaAttrName(meta) || knownMpAttrLabel('wb', id);
    if (isDuplicateMpCardJsonAttr('wb', human)) continue;
    const options = Array.isArray(meta?.options) && meta.options.length ? meta.options : null;
    const kind = options ? 'dictionary' : meta?.kind || 'text';
    const isDict = kind === 'dictionary';
    cols.push({
      key: `__mpAttr__wb__${id}`,
      label: formatMpColumnLabel(id, human, 'wb'),
      title: mpColumnTitleAttr('wb', id, human, isDict),
      headerClass: 'mp-attr-head',
      input: mpAttrInputFromKind('wb', kind),
      minW: isDict ? 140 : 120,
      mpBucket: 'wb',
      mpAttr: { bucket: 'wb', attrId: id },
      dictionaryId: 0,
      dictOptions: options,
      _humanName: human || '',
    });
  }
  for (const id of sortAttrIdsWithLabels(ym, ymM)) {
    if (isMpOfferFieldAttrId(id)) continue;
    const meta = ymM[id] || ymM[String(id)];
    const human = schemaAttrName(meta) || knownMpAttrLabel('ym', id);
    if (isDuplicateMpCardJsonAttr('ym', human)) continue;
    const options = Array.isArray(meta?.options) && meta.options.length ? meta.options : null;
    const kind = options ? 'dictionary' : meta?.kind || 'text';
    const isDict = kind === 'dictionary';
    cols.push({
      key: `__mpAttr__ym__${id}`,
      label: formatMpColumnLabel(id, human, 'ym'),
      title: mpColumnTitleAttr('ym', id, human, isDict),
      headerClass: 'mp-attr-head',
      input: mpAttrInputFromKind('ym', kind),
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

/** Добавить столбцы по схеме категории МП (ТН ВЭД и др.), даже если ни у одного товара ещё нет значения. */
function mergeCategorySchemaMpAttrColumns(mpCols, labelMaps = {}) {
  const byKey = new Map(
    (mpCols || [])
      .filter((c) => c.mpAttr?.bucket && c.mpAttr?.attrId)
      .map((c) => [`${c.mpAttr.bucket}:${c.mpAttr.attrId}`, c])
  );
  const extra = [];
  for (const mp of ATTR_MP_CODES) {
    for (const [id, meta] of Object.entries(labelMaps?.[mp] || {})) {
      const k = `${mp}:${id}`;
      if (byKey.has(k)) continue;
      const human =
        schemaAttrName(meta) || knownMpAttrLabel(mp, id) || (String(id).trim() ? `Параметр ${id}` : '');
      if (!String(id).trim()) continue;
      if (isMpOfferFieldAttrId(id)) continue;
      if (mp === 'ym' && human && isYmParamDuplicatingDedicatedField(human)) continue;
      if (mp === 'wb' && human && isWbCharcDuplicatingDedicatedField(human)) continue;
      const col = extraLinkedMpAttrColumn(mp, id, human, labelMaps);
      if (col) {
        extra.push(col);
        byKey.set(k, col);
      }
    }
  }
  if (!extra.length) return mpCols || [];
  const baseKeys = new Set((mpCols || []).map((c) => c.key));
  return [...(mpCols || []), ...extra.filter((c) => !baseKeys.has(c.key))];
}

/** Как в карточке Ozon: offer_id → sku_ozon; партномер — JSON-атрибут категории, не дублируем полем оффера. */
function dedupeOzonOfferFieldColumns(cols) {
  const list = cols || [];
  const hasMfrArticleAttr = list.some(
    (c) =>
      c.mpAttr?.bucket === 'ozon' &&
      isOzonManufacturerArticleAttr({ id: c.mpAttr.attrId, name: c._humanName || c.label })
  );
  return list.filter((c) => {
    const offerId = String(c.mpOfferField?.offerId || '');
    if (offerId === '__ozon_offer_id__') return false;
    if (offerId === '__ozon_vendor_code__' && hasMfrArticleAttr) return false;
    return true;
  });
}

/** Несколько синонимов «артикул производителя» (7236) — одна колонка; OEM с другим id не трогаем. */
function dedupeOzonManufacturerArticleAttrColumns(cols) {
  const list = cols || [];
  const mfr = list.filter((c) => {
    if (c.mpAttr?.bucket !== 'ozon') return false;
    const name = c._humanName || c.label;
    if (isStandaloneOemAttrName(name)) return false;
    return isOzonManufacturerArticleAttr({ id: c.mpAttr.attrId, name });
  });
  if (mfr.length <= 1) return list;
  const keep =
    mfr.find((c) => String(c.mpAttr?.attrId) === String(OZON_PARTNUMBER_ATTR_ID)) || mfr[0];
  const drop = new Set(mfr.filter((c) => c.key !== keep.key).map((c) => c.key));
  return list.filter((c) => !drop.has(c.key));
}

function buildBulkMpAttrColumnDefs(products, erpCols, seedMaps, schemaMaps) {
  const mergedMaps = mergeMpLabelMaps(seedMaps, schemaMaps);
  bulkEditMpLabelMaps = mergedMaps;
  const merged = mergeCategorySchemaMpAttrColumns(
    mergeLinkedMpAttrColumns(buildMpAttrColumnDefs(products, mergedMaps), erpCols, mergedMaps),
    mergedMaps
  );
  return dedupeOzonManufacturerArticleAttrColumns(dedupeOzonOfferFieldColumns(merged));
}

function erpAttrColKey(attrId) {
  return `__erpAttr__${attrId}`;
}

function inputForErpAttrType(type) {
  if (type === 'checkbox') return 'checkbox';
  if (type === 'number' || isComputedAttrType(type)) return 'number';
  if (type === 'date') return 'date';
  if (type === 'dictionary') return 'select_erp_dict';
  if (isEditableAttrType(type)) return 'textarea';
  return 'text';
}

function parseErpAttributeValues(product) {
  const raw = product?.attribute_values;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null || value === '') continue;
    out[String(key)] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  }
  return out;
}

function parseAttributeManualMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === true || value === 'true' || value === 1 || value === '1') out[String(key)] = true;
  }
  return out;
}

/** Ключи слотов category.mp_field_links, из которых берём сопоставление для столбца. */
function dedicatedMapLookupKeys(fieldKey) {
  const key = String(fieldKey || '');
  if (!key) return [];
  const keys = [key];
  if (key === 'product_dimensions' || DEDICATED_PRODUCT_DIM_KEYS.includes(key)) {
    keys.push('product_dimensions', ...DEDICATED_PRODUCT_DIM_KEYS);
  } else if (key === 'dimensions' || DEDICATED_PACK_DIM_KEYS.includes(key)) {
    keys.push('dimensions', ...DEDICATED_PACK_DIM_KEYS);
  } else if (key === 'country') {
    keys.push('country');
  }
  return [...new Set(keys)];
}

function dedicatedMappedMpsFromCategories(
  categories,
  filterCategoryId,
  products,
  fieldKey,
  scopeCategoryIds = []
) {
  const cats = categories || [];
  const catId = String(filterCategoryId || '').trim();
  const union = new Set();
  const lookupKeys = dedicatedMapLookupKeys(fieldKey);
  const add = (cat) => {
    const links = normalizeCategoryDedicatedCharcLinks(cat?.mp_field_links);
    for (const k of lookupKeys) {
      for (const mp of mappedMpsFromAttrLinks(links[k])) union.add(mp);
    }
  };
  if (catId && catId !== FILTER_CATEGORY_NONE) {
    const cat = cats.find((c) => String(c.id) === catId);
    if (cat) add(cat);
    return [...union];
  }
  const catIds = new Set(
    resolveBulkEditCategoryIds(categories, filterCategoryId, products, scopeCategoryIds)
  );
  for (const c of cats) {
    if (catIds.size && !catIds.has(String(c.id))) continue;
    add(c);
  }
  return [...union];
}

function erpAttrMpLinksForId(categories, filterCategoryId, products, attrId, scopeCategoryIds = []) {
  const aid = String(attrId);
  const cats = categories || [];
  const pick = (cat) =>
    normalizeAttrMpLinks(cat?.attribute_mp_links?.[aid] ?? cat?.attribute_mp_links?.[attrId]);
  const catId = String(filterCategoryId || '').trim();
  if (catId && catId !== FILTER_CATEGORY_NONE) {
    const cat = cats.find((c) => String(c.id) === catId);
    return cat ? pick(cat) : normalizeAttrMpLinks(null);
  }
  let merged = normalizeAttrMpLinks(null);
  const catIds = new Set(
    resolveBulkEditCategoryIds(categories, filterCategoryId, products, scopeCategoryIds)
  );
  for (const c of cats) {
    if (catIds.size && !catIds.has(String(c.id))) continue;
    const links = pick(c);
    const next = normalizeAttrMpLinks(null);
    for (const mp of ATTR_MP_CODES) {
      next[mp] = normalizeAttrMpLinkList([...(merged[mp] || []), ...(links[mp] || [])]);
    }
    merged = next;
  }
  return merged;
}

function buildErpAttrColumnDefs(
  allAttributes,
  categories,
  filterCategoryId,
  products,
  scopeCategoryIds = []
) {
  const attrById = new Map((allAttributes || []).map((a) => [String(a.id), a]));
  const ids = new Set();
  const addFromCat = (cat) => {
    for (const id of cat?.attribute_ids || []) {
      if (id != null && String(id).trim() !== '') ids.add(String(id));
    }
    const am = cat?.attribute_mp_links;
    if (am && typeof am === 'object' && !Array.isArray(am)) {
      for (const id of Object.keys(am)) {
        if (id != null && String(id).trim() !== '') ids.add(String(id));
      }
    }
  };
  const catId = String(filterCategoryId || '').trim();
  if (catId && catId !== FILTER_CATEGORY_NONE) {
    const cat = (categories || []).find((c) => String(c.id) === catId);
    if (cat) addFromCat(cat);
  } else if (!catId) {
    const catIds = new Set(
      resolveBulkEditCategoryIds(categories, filterCategoryId, products, scopeCategoryIds)
    );
    for (const p of products || []) {
      const av = p.attribute_values;
      if (av && typeof av === 'object' && !Array.isArray(av)) {
        Object.keys(av).forEach((k) => ids.add(String(k)));
      }
    }
    for (const c of categories || []) {
      if (catIds.has(String(c.id))) addFromCat(c);
    }
  }
  for (const a of allAttributes || []) {
    if (isSystemPriceAttr(a)) ids.add(String(a.id));
  }
  const cols = [];
  for (const id of ids) {
    const attr = attrById.get(id);
    if (!attr) continue;
    // Системные поля «Основное» — колонки products.*, не attr_*
    if (isSystemMainFieldAttr(attr)) continue;
    const type = attr.type || 'text';
    const dict = Array.isArray(attr.dictionary_values) ? attr.dictionary_values : [];
    const mpLinks = erpAttrMpLinksForId(
      categories,
      filterCategoryId,
      products,
      id,
      scopeCategoryIds
    );
    const mapped = mappedMpsFromAttrLinks(mpLinks);
    cols.push({
      key: erpAttrColKey(id),
      label: attr.name || `Атр. ${id}`,
      title: [
        isComputedAttrType(type) && String(attr.formula || '').trim()
          ? `Формула: ${attr.formula}`
          : null,
        attrShowsRelatedFields(attr)
          ? `Основное · ${attr.name || id}. Редактируемое поле: попап со связанными МП`
          : null,
        mapped.length
          ? `Основное · ${attr.name || id}. Значки включают подстановку значения на сопоставленный МП`
          : `Основное · ${attr.name || id}`,
      ].filter(Boolean).join('. '),
      headerClass: 'erp-attr-head',
      input: inputForErpAttrType(type),
      minW: type === 'checkbox' ? 72 : isEditableAttrType(type) ? 160 : 120,
      erpAttr: {
        id,
        name: attr.name || '',
        type,
        dictionary_values: dict,
        mpLinks,
        formula: attr.formula || '',
        system_key: attr.system_key || '',
        show_related_fields: !!attr.show_related_fields,
      },
      showRelatedFields: attrShowsRelatedFields(attr),
      dictOptions: type === 'dictionary' ? dict.map((v) => ({ id: String(v), label: String(v) })) : null,
      mappedMps: mapped,
      linkFieldKey: erpAttrLinkFieldKey(id),
      linkSupportedMps: mapped,
      showLinkToggles: mapped.length > 0,
    });
  }
  cols.sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'ru'));
  return cols;
}

function extraLinkedMpAttrColumn(mp, attrId, humanName, labelMaps = {}) {
  const id = String(attrId);
  if (!id.trim() || isMpOfferFieldAttrId(id)) return null;
  if (mp === 'ozon' && OZON_PACK_DIM_ATTR_IDS.has(id)) return null;
  if (mp === 'wb' && WB_PACK_DIM_ATTR_IDS.has(id)) return null;
  const maps = labelMaps?.[mp] || {};
  const meta = maps[id] || maps[attrId];
  const human = schemaAttrName(meta) || (humanName && String(humanName).trim()) || '';
  if (isDuplicateMpCardJsonAttr(mp, human)) return null;
  if (mp === 'ozon') {
    const dictionaryId = Number(meta?.dictionaryId) || 0;
    const isDict = dictionaryId > 0 || meta?.kind === 'dictionary';
    const kind = isDict ? 'dictionary' : meta?.kind || 'text';
    return {
      key: mpAttrColKey('ozon', id),
      label: formatMpColumnLabel(id, human, 'ozon'),
      title: mpColumnTitleAttr('ozon', id, human, isDict),
      headerClass: 'mp-attr-head',
      input: mpAttrInputFromKind('ozon', kind),
      minW: isDict ? 140 : 120,
      mpBucket: 'ozon',
      mpAttr: { bucket: 'ozon', attrId: id },
      dictionaryId: isDict ? dictionaryId : 0,
      dictOptions: null,
      _humanName: human || '',
    };
  }
  const options = Array.isArray(meta?.options) && meta.options.length ? meta.options : null;
  const kind = options ? 'dictionary' : meta?.kind || 'text';
  const isDict = kind === 'dictionary';
  return {
    key: mpAttrColKey(mp, id),
    label: formatMpColumnLabel(id, human, mp),
    title: mpColumnTitleAttr(mp, id, human, isDict),
    headerClass: 'mp-attr-head',
    input: mpAttrInputFromKind(mp, kind),
    minW: isDict ? 140 : 120,
    mpBucket: mp,
    mpAttr: { bucket: mp, attrId: id },
    dictionaryId: 0,
    dictOptions: options,
    _humanName: human || '',
  };
}

/** Колонки характеристик МП, на которые ссылаются связи ручных атрибутов категории. */
function mergeLinkedMpAttrColumns(mpCols, erpCols, labelMaps = {}) {
  const byKey = new Map((mpCols || []).map((c) => [`${c.mpAttr?.bucket}:${c.mpAttr?.attrId}`, c]));
  const have = new Set(byKey.keys());
  const extra = [];
  const upgradeLabel = (col, humanName) => {
    if (!col?.mpAttr) return col;
    const human = String(humanName || '').trim();
    if (!human) return col;
    if (!isUnresolvedMpAttrLabel(col.label, col.mpAttr.attrId) && String(col._humanName || '').trim()) {
      return col;
    }
    const bucket = col.mpAttr.bucket;
    const id = col.mpAttr.attrId;
    const isDict = Number(col.dictionaryId) > 0 || col.input === 'select_dict';
    return {
      ...col,
      label: formatMpColumnLabel(id, human, bucket),
      title: mpColumnTitleAttr(bucket, id, human, isDict),
      _humanName: human,
    };
  };
  for (const erp of erpCols || []) {
    const links = erp.erpAttr?.mpLinks || {};
    for (const mp of ATTR_MP_CODES) {
      const entries = normalizeAttrMpLinkList(links[mp]);
      for (const entry of entries) {
        let target;
        try {
          target = resolveAttrMpLinkTarget(entry, mp, labelMaps);
        } catch {
          target = null;
        }
        if (!target) continue;
        if (target.kind === 'offer') {
          if (BULK_DEDICATED_OFFER_FIELD_IDS.has(String(target.offerId))) continue;
          const offerKey = `offer:${target.offerId}`;
          const maps = labelMaps?.[mp] || {};
          const meta = maps[target.offerId] || maps[String(target.offerId)];
          const human = schemaAttrName(meta) || entry.name || '';
          if (have.has(offerKey)) continue;
          have.add(offerKey);
          const offerCol = attachOfferFieldLinkMeta(
            extraLinkedMpOfferColumn(mp, target.offerId, human || entry.name),
            erpCols
          );
          if (offerCol) extra.push(offerCol);
          continue;
        }
        const attrId = target.attrId;
        if (!attrId) continue;
        const k = `${mp}:${attrId}`;
        const maps = labelMaps?.[mp] || {};
        const meta = maps[attrId] || maps[String(attrId)];
        const human = schemaAttrName(meta) || entry.name || '';
        if (have.has(k)) {
          const prev = byKey.get(k);
          const next = upgradeLabel(prev, human);
          if (next !== prev) byKey.set(k, next);
          continue;
        }
        have.add(k);
        const col = extraLinkedMpAttrColumn(mp, attrId, human || entry.name, labelMaps);
        if (col) {
          extra.push(col);
          byKey.set(k, col);
        }
      }
    }
  }
  for (const known of [
    { mp: 'ozon', id: String(OZON_BRAND_ATTR_ID), name: 'Бренд' },
    { mp: 'ozon', id: String(OZON_MANUFACTURER_COUNTRY_ATTR_ID), name: 'Страна-изготовитель' },
    { mp: 'ozon', id: String(OZON_ANNOTATION_ATTR_ID), name: 'Аннотация' },
  ]) {
    const k = `${known.mp}:${known.id}`;
    if (have.has(k)) {
      const prev = byKey.get(k);
      const next = upgradeLabel(prev, known.name);
      if (next !== prev) byKey.set(k, next);
      continue;
    }
    have.add(k);
    const col = extraLinkedMpAttrColumn(known.mp, known.id, known.name, labelMaps);
    if (col) {
      extra.push(col);
      byKey.set(k, col);
    }
  }
  for (const [id, meta] of Object.entries(labelMaps?.ozon || {})) {
    const human = schemaAttrName(meta);
    if (!isOzonNameAttr({ id, name: human }) && !isOzonAnnotationAttr({ id, name: human })) continue;
    const k = `ozon:${id}`;
    if (have.has(k)) {
      const prev = byKey.get(k);
      const next = upgradeLabel(prev, human);
      if (next !== prev) byKey.set(k, next);
      continue;
    }
    have.add(k);
    const col = extraLinkedMpAttrColumn('ozon', id, human, labelMaps);
    if (col) {
      extra.push(col);
      byKey.set(k, col);
    }
  }
  const base = (mpCols || []).map((c) => {
    const k = `${c.mpAttr?.bucket}:${c.mpAttr?.attrId}`;
    return c.mpAttr ? byKey.get(k) || c : c;
  });
  const merged = extra.length ? [...base, ...extra.filter((c) => !base.some((b) => b.key === c.key))] : base;
  return (merged || []).map((col) => {
    if (col.mpOfferField) return attachOfferFieldLinkMeta(col, erpCols);
    if (!col.mpAttr) return col;
    let next = col;
    if (!next.linkFieldKey && next.mpAttr.bucket === 'ozon') {
      const fake = { id: next.mpAttr.attrId, name: next._humanName };
      if (isOzonBrandAttr(fake)) next = { ...next, linkFieldKey: 'brand' };
      else if (isOzonManufacturerCountryAttr(fake)) next = { ...next, linkFieldKey: 'country' };
      else if (isOzonNameAttr(fake)) next = { ...next, linkFieldKey: 'name' };
      else if (isOzonAnnotationAttr(fake)) next = { ...next, linkFieldKey: 'description' };
      else if (ozonProductDimAxis(fake) && classifyMarketplaceDimAttrName(next._humanName || fake.name) === 'product') {
        next = { ...next, linkFieldKey: 'product_dimensions' };
      }
    }
    if (!next.linkFieldKey && next.mpAttr.bucket === 'wb') {
      const fake = { id: next.mpAttr.attrId, name: next._humanName, charcID: next.mpAttr.attrId };
      const axis = productDimAxisForMpAttr(fake, 'wb');
      if (axis && classifyMarketplaceDimAttrName(next._humanName || fake.name) === 'product') {
        next = { ...next, linkFieldKey: 'product_dimensions' };
      }
    }
    const erp = findErpAttrColForMpAttr(
      erpCols,
      next.mpAttr.bucket,
      next.mpAttr.attrId,
      labelMaps,
      next._humanName || next.label || ''
    );
    if (erp) {
      const attrMapped = mappedMpsFromAttrLinks(erp.erpAttr?.mpLinks);
      const linkFieldKey = erp.linkFieldKey || next.linkFieldKey;
      next = {
        ...next,
        mappedMps: next.mappedMps?.length ? next.mappedMps : [next.mpAttr.bucket],
        linkFieldKey,
        categoryLinked: true,
        linkSupportedMps: attrMapped.length ? attrMapped : [next.mpAttr.bucket],
      };
    }
    return next;
  });
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

function emptyBulkMpFieldLinks(erpAttrColDefs = []) {
  const links = emptyMpFieldLinks();
  for (const col of erpAttrColDefs || []) {
    const key = col?.linkFieldKey;
    if (isAttrMpFieldLinkKey(key)) links[key] = [];
  }
  return links;
}

/** Связи Main↔МП в сессии массового редактирования — всегда выкл. при загрузке (не из карточки товара). */
function bulkSessionMpFieldLinks(erpAttrColDefs = []) {
  return emptyBulkMpFieldLinks(erpAttrColDefs);
}

function rowToFormulaProduct(row) {
  return {
    cost: row?.cost,
    additional_expenses: row?.additionalExpenses,
    additionalExpenses: row?.additionalExpenses,
    min_price: row?.minPrice,
    minPrice: row?.minPrice,
    weight: row?.weight,
    length: row?.length,
    width: row?.width,
    height: row?.height,
    volume: row?.volume,
  };
}

function isBulkComputedLocked(row, attrId) {
  const aid = String(attrId);
  return (
    row?._erpAttrManualSession?.[aid] === true ||
    row?._erpAttrManualBaseline?.[aid] === true ||
    row?._erpAttrToolBaseline?.[aid] === true
  );
}

function applyBulkRowComputed(row, erpAttrColDefs = []) {
  const attrs = (erpAttrColDefs || []).map((c) => c.erpAttr).filter(Boolean);
  if (!attrs.some((a) => isComputedAttrType(a.type) && String(a.formula || '').trim())) {
    return row;
  }
  const values = {};
  const manual = {};
  for (const c of erpAttrColDefs || []) {
    if (!c?.erpAttr) continue;
    const aid = String(c.erpAttr.id);
    values[aid] = row[c.key] ?? '';
    if (isBulkComputedLocked(row, aid)) manual[aid] = true;
  }
  const { values: nextVals } = applyComputedAttributeValues({
    product: rowToFormulaProduct(row),
    attributes: attrs,
    values,
    manual,
  });
  let changed = false;
  const patched = { ...row };
  for (const c of erpAttrColDefs || []) {
    if (!isComputedAttrType(c?.erpAttr?.type)) continue;
    const aid = String(c.erpAttr.id);
    if (isBulkComputedLocked(row, aid)) continue;
    const nv = nextVals[aid] == null ? '' : String(nextVals[aid]);
    if (str(patched[c.key]) !== nv) {
      patched[c.key] = nv;
      changed = true;
    }
  }
  return changed ? patched : row;
}

function copyComputedErpToLinkedMp(row, erpAttrColDefs = [], mpAttrColDefs = []) {
  let next = row;
  for (const erpCol of erpAttrColDefs || []) {
    if (!isComputedAttrType(erpCol?.erpAttr?.type)) continue;
    if (!str(next[erpCol.key]).trim()) continue;
    for (const mp of mappedMpsFromAttrLinks(erpCol.erpAttr?.mpLinks)) {
      try {
        next = copyErpAttrToLinkedMp(next, erpCol, mp, bulkEditMpLabelMaps, mpAttrColDefs);
      } catch {
        /* ignore bad mapping for one cell */
      }
    }
  }
  return syncOfferFieldColsOnRow(next, mpAttrColDefs);
}

function markBulkComputedSessionManual(row, key, erpAttrColDefs = []) {
  const col = (erpAttrColDefs || []).find((c) => c.key === key && c.erpAttr);
  if (!col || !isComputedAttrType(col.erpAttr?.type)) return row;
  const aid = String(col.erpAttr.id);
  return {
    ...row,
    _erpAttrManualSession: { ...(row._erpAttrManualSession || {}), [aid]: true },
  };
}

function finalizeBulkRowAfterCellChange(row, key, erpAttrColDefs = [], mpAttrColDefs = []) {
  const next = applyBulkRowComputed(markBulkComputedSessionManual(row, key, erpAttrColDefs), erpAttrColDefs);
  return copyComputedErpToLinkedMp(next, erpAttrColDefs, mpAttrColDefs);
}

function applyCategoryTnVedToBulkRow(row, product, erpAttrColDefs = [], mpAttrColDefs = [], categories = []) {
  const code = categoryTnVedDigits(product, categories);
  if (!code) return row;

  const erpAttrs = (erpAttrColDefs || [])
    .filter((c) => c?.erpAttr)
    .map((c) => ({
      id: String(c.erpAttr.id),
      name: c.erpAttr.name || c.label || '',
      key: c.key,
    }));
  const erpPrev = {};
  for (const a of erpAttrs) erpPrev[a.id] = row[a.key] ?? '';
  const erpNext = applyTnVedAutofillToAttributes(erpAttrs, code, erpPrev, {
    getAttrKey: (a) => a.id,
    getAttrName: (a) => a.name,
  });

  const mpAttrs = (mpAttrColDefs || [])
    .filter((c) => c?.mpAttr)
    .map((c) => ({
      id: c.key,
      name: c._humanName || c.label || '',
    }));
  const mpPrev = {};
  for (const a of mpAttrs) mpPrev[a.id] = row[a.key] ?? '';
  const mpNext = applyTnVedAutofillToAttributes(mpAttrs, code, mpPrev, {
    getAttrKey: (a) => a.id,
    getAttrName: (a) => a.name,
  });

  let next = row;
  let changed = false;
  const take = (key, value, erpId) => {
    if (str(next[key]) === str(value ?? '')) return;
    if (!changed) next = { ...next };
    changed = true;
    next[key] = value ?? '';
    if (erpId && value) {
      next._erpAttrBaseline = { ...(next._erpAttrBaseline || {}), [erpId]: String(value) };
    }
  };
  for (const a of erpAttrs) take(a.key, erpNext[a.id], a.id);
  for (const a of mpAttrs) take(a.id, mpNext[a.id], null);
  return next;
}

function productToRow(p, mpAttrColDefs = [], lengthUnit = 'mm', weightUnit = 'g', erpAttrColDefs = [], categories = []) {
  const orgRaw = p.organization_id ?? p.organizationId;
  const supplierRaw = p.supplier_id ?? p.supplierId;
  const oz = normalizeJsonAttrs(p.ozon_attributes);
  const wb = normalizeJsonAttrs(p.wb_attributes);
  const ym = normalizeJsonAttrs(p.ym_attributes);
  const ozPack = readOzonPackDimsFromProduct(p, lengthUnit, weightUnit);
  const wbPack = readWbPackDimsFromProduct(p, lengthUnit, weightUnit);
  const ymPack = readYmPackDimsFromProduct(p, lengthUnit, weightUnit);
  const productDims = readProductDimsFromProduct(p, lengthUnit, weightUnit);
  const mpCountries = readMpCountriesFromProduct(p);
  let row = {
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
    barcodes: formatBarcodesCell(p.barcodes),
    sku_ozon: str(p.sku_ozon ?? p.marketplace_skus?.ozon ?? ''),
    ozon_product_id: str(p.ozon_product_id ?? p.marketplace_ozon_product_id ?? ''),
    sku_wb: str(p.sku_wb ?? p.marketplace_skus?.wb ?? ''),
    sku_ym: str(p.sku_ym ?? p.marketplace_skus?.ym ?? ''),
    ym_vendor_code: str(parseDraftBaseline(p.ym_draft).vendorCode),
    mp_ozon_name: str(p.mp_ozon_name),
    mp_ozon_description: str(p.mp_ozon_description),
    mp_ozon_brand: str(p.mp_ozon_brand),
    mp_wb_vendor_code: str(p.mp_wb_vendor_code),
    mp_wb_name: str(p.mp_wb_name),
    mp_wb_description: str(p.mp_wb_description),
    mp_wb_brand: str(p.mp_wb_brand),
    mp_ym_name: str(p.mp_ym_name),
    mp_ym_description: str(p.mp_ym_description),
    mp_field_links: bulkSessionMpFieldLinks(erpAttrColDefs),
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
    _erpAttrBaseline: parseErpAttributeValues(p),
    _erpAttrManualBaseline: parseAttributeManualMap(p.attribute_values_manual),
    _erpAttrToolBaseline: parseAttributeManualMap(p.attribute_values_tool),
    hasPricingStrategy: p.hasPricingStrategy === true,
    effectivePricingStrategyName: p.effectivePricingStrategyName || '',
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
  for (const c of erpAttrColDefs) {
    if (!c.erpAttr) continue;
    row[c.key] = row._erpAttrBaseline[String(c.erpAttr.id)] ?? '';
  }
  row = applyCategoryTnVedToBulkRow(row, p, erpAttrColDefs, mpAttrColDefs, categories);
  row = applyBulkRowComputed(row, erpAttrColDefs);
  for (const c of erpAttrColDefs) {
    if (!isComputedAttrType(c?.erpAttr?.type)) continue;
    const aid = String(c.erpAttr.id);
    if (isBulkComputedLocked(row, aid)) continue;
    const v = str(row[c.key]).trim();
    if (v) row._erpAttrBaseline[aid] = v;
    else delete row._erpAttrBaseline[aid];
  }
  for (const erpCol of erpAttrColDefs) {
    const erpVal = str(row[erpCol.key]).trim();
    if (!erpVal) continue;
    for (const mp of mappedMpsFromAttrLinks(erpCol.erpAttr?.mpLinks)) {
      try {
        row = copyErpAttrToLinkedMp(row, erpCol, mp, bulkEditMpLabelMaps, mpAttrColDefs);
      } catch {
        /* ignore bad mapping for one cell */
      }
    }
  }
  return syncOfferFieldColsOnRow(row, mpAttrColDefs);
}

function parseBarcodesCell(text) {
  return collectBarcodeStrings(text).filter((s) => s && !isCorruptBarcodeString(s));
}

function BulkBarcodeGenerateIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect x="1" y="2.5" width="1.4" height="11" rx="0.4" fill="currentColor" />
      <rect x="3.6" y="2.5" width="1" height="11" rx="0.4" fill="currentColor" />
      <rect x="5.8" y="2.5" width="2" height="11" rx="0.4" fill="currentColor" />
      <rect x="8.9" y="2.5" width="1" height="11" rx="0.4" fill="currentColor" />
      <rect x="11" y="2.5" width="1.6" height="11" rx="0.4" fill="currentColor" />
      <rect x="13.7" y="2.5" width="1.2" height="11" rx="0.4" fill="currentColor" />
    </svg>
  );
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
function buildUpdatePayload(original, current, mpAttrColDefs = [], lengthUnit = 'mm', weightUnit = 'g', erpAttrColDefs = []) {
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
  if (ob !== cb) {
    const nextBc = parseBarcodesCell(current.barcodes);
    if (nextBc.length) touch('barcodes', nextBc);
  }

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
    if (!eq(original.ym_vendor_code, current.ym_vendor_code)) {
      patchDraft('ym', { vendorCode: str(current.ym_vendor_code).trim() });
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
      (mp !== 'ym' && !eq(original[`${mp}_product_weight`], current[`${mp}_product_weight`]));
    for (const mp of ['ozon', 'wb', 'ym']) {
      const linked = isMpFieldLinked(links, 'product_dimensions', mp);
      if (mpProductChanged(mp) && !linked) {
        patchDraft(mp, {
          productDimensions: dimsFromDisplay(
            current[`${mp}_product_length`],
            current[`${mp}_product_width`],
            current[`${mp}_product_height`],
            mp === 'ym' ? '' : current[`${mp}_product_weight`]
          ),
        });
      } else if (productDimsTouched && linked) {
        patchDraft(mp, {
          productDimensions: dimsFromDisplay(
            current.product_length,
            current.product_width,
            current.product_height,
            mp === 'ym' ? '' : current.product_weight
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
      let after = attrsFromRow(current, mpAttrColDefs, bucket);
      after = mergeLinkedProductDimIntoMpAttrs(
        after,
        current,
        mpAttrColDefs,
        bucket,
        normalizeMpFieldLinks(current.mp_field_links),
        lengthUnit,
        weightUnit
      );
      if (stableAttrJson(before) !== stableAttrJson(after)) {
        const patch = {};
        for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (stableAttrJson({ v: before[k] }) === stableAttrJson({ v: after[k] })) continue;
          patch[k] = Object.prototype.hasOwnProperty.call(after, k) ? after[k] : null;
        }
        if (Object.keys(patch).length) touch(map[bucket], patch);
      }
    }
  }

  for (const col of mpAttrColDefs) {
    if (!col.mpOfferField) continue;
    if (eq(original[col.key], current[col.key])) continue;
    const formBefore = rowAsOfferFieldForm({
      ...original,
      ozon_draft:
        payload.ozon_draft ??
        parseDraftBaseline(original._ozonDraftBaseline ?? original._productRef?.ozon_draft),
      wb_draft:
        payload.wb_draft ??
        parseDraftBaseline(original._wbDraftBaseline ?? original._productRef?.wb_draft),
      ym_draft:
        payload.ym_draft ??
        parseDraftBaseline(original._ymDraftBaseline ?? original._productRef?.ym_draft),
    });
    const formAfter = applyMpOfferFieldToForm(
      rowAsOfferFieldForm({
        ...current,
        ozon_draft: formBefore.ozon_draft,
        wb_draft: formBefore.wb_draft,
        ym_draft: formBefore.ym_draft,
      }),
      col.mpOfferField.offerId,
      str(current[col.key])
    );
    patchPayloadFromOfferFieldForm(payload, touch, formBefore, formAfter);
  }

  if ((erpAttrColDefs || []).length > 0) {
    const before = { ...(original._erpAttrBaseline || {}) };
    const after = { ...before };
    let changed = false;
    for (const c of erpAttrColDefs) {
      if (!c?.erpAttr) continue;
      const aid = String(c.erpAttr.id);
      const nextVal = str(current[c.key]).trim();
      const prevVal = str(original[c.key]).trim();
      if (prevVal !== nextVal) changed = true;
      if (nextVal === '') {
        // Пустая ячейка без изменения не должна выкидывать значение из baseline.
        if (prevVal !== '') after[aid] = '';
      } else after[aid] = nextVal;
    }
    if (changed || stableAttrJson(before) !== stableAttrJson(after)) {
      touch('attribute_values', after);
      const manualAfter = { ...(original._erpAttrManualBaseline || {}) };
      const toolAfter = { ...(original._erpAttrToolBaseline || {}) };
      for (const c of erpAttrColDefs) {
        if (!isComputedAttrType(c?.erpAttr?.type)) continue;
        const aid = String(c.erpAttr.id);
        const nextVal = str(current[c.key]).trim();
        const prevVal = str(original[c.key]).trim();
        if (prevVal === nextVal) continue;
        if (nextVal === '') {
          delete manualAfter[aid];
          delete toolAfter[aid];
        } else if (current._erpAttrManualSession?.[aid] === true) {
          manualAfter[aid] = true;
          delete toolAfter[aid];
        }
      }
      touch('attribute_values_manual', manualAfter);
      touch('attribute_values_tool', toolAfter);
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

  for (const mp of ['ozon', 'wb', 'ym']) {
    const draftKey = `${mp}_draft`;
    const baselineKey =
      mp === 'ozon' ? '_ozonDraftBaseline' : mp === 'wb' ? '_wbDraftBaseline' : '_ymDraftBaseline';
    const fromRow = current[draftKey];
    if (!fromRow || typeof fromRow !== 'object' || Array.isArray(fromRow)) continue;
    const prev =
      payload[draftKey] && typeof payload[draftKey] === 'object'
        ? payload[draftKey]
        : parseDraftBaseline(original[baselineKey] ?? original._productRef?.[draftKey]);
    const merged = { ...prev, ...fromRow };
    if (stableAttrJson(prev) !== stableAttrJson(merged)) {
      touch(draftKey, merged);
    }
  }

  return payload;
}

/** Скаляры для JSON-атрибутов МП — Zod на PUT не принимает вложенные объекты в wb/ym. */
function sanitizeMpAttrsForApi(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (String(k).startsWith('__')) continue;
    if (v == null) {
      out[k] = null;
      continue;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'object') {
      if (
        !Array.isArray(v) &&
        (v.dictionary_value_id != null || v.value != null || v.id != null)
      ) {
        out[k] = v;
        continue;
      }
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
  const {
    _productRef,
    _ozonDraftBaseline,
    _wbDraftBaseline,
    _ymDraftBaseline,
    _mpAttrBaseline,
    _erpAttrBaseline,
    ...rest
  } = r;
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
    _erpAttrBaseline: { ...(_erpAttrBaseline || {}) },
    _erpAttrManualBaseline: { ...(r._erpAttrManualBaseline || {}) },
    _erpAttrToolBaseline: { ...(r._erpAttrToolBaseline || {}) },
    _erpAttrManualSession: { ...(r._erpAttrManualSession || {}) },
    _ozonDraftBaseline: _ozonDraftBaseline ? { ..._ozonDraftBaseline } : {},
    _wbDraftBaseline: _wbDraftBaseline ? { ..._wbDraftBaseline } : {},
    _ymDraftBaseline: _ymDraftBaseline ? { ..._ymDraftBaseline } : {},
    _productRef,
  };
}

const NEW_BULK_ROW_PREFIX = 'new:';
const CREATE_MODE_INITIAL_ROWS = 5;

function isNewBulkRowId(id) {
  return String(id || '').startsWith(NEW_BULK_ROW_PREFIX);
}

function isBulkCreateRowSavable(row) {
  return str(row?.name).trim() !== '' && str(row?.sku).trim() !== '';
}

function emptyProductStubForBulkRow(id, defaults = {}) {
  return {
    id,
    name: '',
    sku: '',
    product_type: defaults.productType === 'kit' ? 'kit' : 'product',
    categoryId: defaults.categoryId || null,
    organization_id: defaults.organizationId || null,
    supplier_id: defaults.supplierId || null,
    brand: defaults.brand || '',
    buyout_rate: 95,
    min_price: 50,
    barcodes: [],
    ozon_draft: {},
    wb_draft: {},
    ym_draft: {},
    ozon_attributes: {},
    wb_attributes: {},
    ym_attributes: {},
  };
}

function buildCreatePayload(original, current, mpAttrColDefs, lengthUnit, weightUnit, erpAttrColDefs) {
  if (!isBulkCreateRowSavable(current)) return null;
  const payload = buildUpdatePayload(
    original,
    current,
    mpAttrColDefs,
    lengthUnit,
    weightUnit,
    erpAttrColDefs
  );
  payload.name = str(current.name).trim();
  payload.sku = str(current.sku).trim();
  if (!payload.product_type) {
    payload.product_type = current.product_type === 'kit' ? 'kit' : 'product';
  }
  payload.unit = 'шт';
  return payload;
}

/** Оценка высоты строки для виртуализации (фото 3:4 + textarea). */
const BULK_ROW_ESTIMATE_PX = 60;
const BULK_ROW_OVERSCAN = 12;

function BulkPhotoCell({ product, sku, rowId, stickyClass, stickyStyle, onOpen }) {
  const url = getPrimaryProductImageUrl(product);
  const images = product?.images;
  const count = parseProductImages(images).length;
  const hasBad = useProductHasNon3x4Image(images);
  const openTitle = hasBad
    ? 'Есть изображение не 3:4'
    : url
      ? 'Управление изображениями'
      : 'Добавить изображения';
  return (
    <td className={stickyClass || undefined} style={stickyStyle}>
      <div className="products-bulk-thumb-wrap">
        <button
          type="button"
          className={`products-bulk-thumb products-bulk-thumb--btn${hasBad ? ' is-bad-aspect' : ''}`}
          onClick={() => onOpen()}
          title={openTitle}
          aria-label={
            url
              ? `Управление изображениями товара ${sku || rowId}`
              : `Добавить изображения для ${sku || rowId}`
          }
        >
          {url ? <img src={url} alt="" loading="lazy" /> : <span className="products-bulk-thumb-empty">+</span>}
        </button>
        {count > 0 ? (
          <button
            type="button"
            className="products-bulk-thumb-count"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            title={
              count > 1
                ? `Фото (${count}) — загрузить или удалить; OZ/WB/ЯМ — куда выгружать`
                : 'Управление изображениями'
            }
            aria-label={`Управление изображениями товара ${sku || rowId}`}
          >
            {count}
          </button>
        ) : null}
      </div>
    </td>
  );
}

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

function isPopupMainColumn(col, linkKey) {
  if (!col?.key || !linkKey) return false;
  if (col.key === linkKey) return true;
  if (col.erpAttr && col.linkFieldKey === linkKey) return true;
  return false;
}

function erpColShowsRelatedFields(erpCol) {
  return !!(erpCol?.showRelatedFields || attrShowsRelatedFields(erpCol?.erpAttr));
}

function findErpColByLinkFieldKey(erpAttrCols, linkKey) {
  if (!linkKey) return null;
  return (erpAttrCols || []).find((c) => c.linkFieldKey === linkKey) || null;
}

function isPopupTextColumn(col, erpAttrCols = []) {
  if (!col) return false;
  const k = String(col.key || '');
  const relatedFlag = (fieldKey) => {
    if (col.showRelatedFields != null) return !!col.showRelatedFields;
    // До миграции / без метаданных — как раньше: name/description с попапом
    if (fieldKey === 'name' || fieldKey === 'description') return true;
    return false;
  };
  if (k === 'name' || k === 'description') return relatedFlag(k);
  if (
    k === 'mp_wb_name' ||
    k === 'mp_wb_description' ||
    k === 'mp_ym_name' ||
    k === 'mp_ym_description' ||
    k === 'mp_ozon_name' ||
    k === 'mp_ozon_description'
  ) {
    const lk =
      col.linkFieldKey === 'name' || col.linkFieldKey === 'description'
        ? col.linkFieldKey
        : k.includes('description')
          ? 'description'
          : 'name';
    return relatedFlag(lk);
  }
  if (col.linkFieldKey === 'name' || col.linkFieldKey === 'description') {
    return relatedFlag(col.linkFieldKey);
  }
  if (col.mpAttr?.bucket === 'ozon') {
    const attr = { id: col.mpAttr.attrId, name: col._humanName || col.label };
    if (isOzonNameAttr(attr)) return relatedFlag('name');
    if (isOzonAnnotationAttr(attr)) return relatedFlag('description');
  }
  if (erpColShowsRelatedFields(col)) return true;
  const lk = col.linkFieldKey;
  if (lk && isAttrMpFieldLinkKey(lk) && (col.mpAttr || col.mpOfferField || col.mpBucket)) {
    return erpColShowsRelatedFields(findErpColByLinkFieldKey(erpAttrCols, lk));
  }
  return false;
}

function popupLinkFieldKey(col, erpAttrCols = []) {
  if (!col) return null;
  if (col.linkFieldKey === 'name' || col.linkFieldKey === 'description') return col.linkFieldKey;
  const k = String(col.key || '');
  if (k === 'name' || k === 'description') return k;
  if (erpColShowsRelatedFields(col) && col.linkFieldKey) return col.linkFieldKey;
  const lk = col.linkFieldKey;
  if (lk && isAttrMpFieldLinkKey(lk) && (col.mpAttr || col.mpOfferField || col.mpBucket)) {
    if (erpColShowsRelatedFields(findErpColByLinkFieldKey(erpAttrCols, lk))) return lk;
  }
  return null;
}

function popupFieldTitle(col) {
  if (!col) return 'Текст';
  if (col.key === 'name') return 'Основное · Название';
  if (col.key === 'description') return 'Основное · Описание';
  if (col.erpAttr) return `Основное · ${col.label || col.erpAttr.id}`;
  const raw = String(col.title || col._humanName || col.label || col.key);
  return raw.split('\n')[0].trim();
}

function collectPopupRelatedColumns(col, mpAttrCols = [], erpAttrCols = [], allColumns = []) {
  const linkKey = popupLinkFieldKey(col, erpAttrCols);
  if (!linkKey) return col ? [col] : [];
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (!c?.key || seen.has(c.key)) return;
    seen.add(c.key);
    out.push(c);
  };
  if (linkKey === 'name' || linkKey === 'description') {
    add(COLUMNS.find((c) => c.key === linkKey));
    const dedicated =
      linkKey === 'name' ? ['mp_wb_name', 'mp_ym_name'] : ['mp_wb_description', 'mp_ym_description'];
    for (const k of dedicated) add(COLUMNS.find((c) => c.key === k));
  } else if (isAttrMpFieldLinkKey(linkKey)) {
    add(findErpColByLinkFieldKey(erpAttrCols, linkKey));
  }
  for (const c of mpAttrCols || []) {
    if (c?.linkFieldKey === linkKey) add(c);
  }
  for (const c of allColumns || []) {
    if (!c || c.erpAttr) continue;
    if (c.linkFieldKey === linkKey && (c.mpBucket || c.mpAttr || c.mpOfferField)) add(c);
  }
  add(col);
  const rank = (c) => {
    if (isPopupMainColumn(c, linkKey)) return 0;
    if (c.mpAttr?.bucket === 'ozon' || c.mpBucket === 'ozon' || String(c.key).startsWith('mp_ozon_')) return 1;
    if (c.mpBucket === 'wb' || String(c.key).startsWith('mp_wb_')) return 2;
    if (c.mpBucket === 'ym' || String(c.key).startsWith('mp_ym_')) return 3;
    return 4;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

function popupDisplayedDraft(popupCol, textPopup, row, erpAttrCols, mpAttrCols) {
  const key = popupCol?.key;
  if (!key) return '';
  const linkKey = popupLinkFieldKey(popupCol, erpAttrCols);
  const independent = !!(textPopup?.independent && textPopup.independent[key]);
  const stillLinked =
    linkKey &&
    !isPopupMainColumn(popupCol, linkKey) &&
    !independent &&
    isBulkLinkedMpReadonly(row, key, erpAttrCols, mpAttrCols);
  if (stillLinked) {
    const mainCol = findErpColByLinkFieldKey(erpAttrCols, linkKey);
    const mainKey =
      linkKey === 'name' || linkKey === 'description'
        ? linkKey
        : mainCol?.key || linkKey;
    return String(textPopup?.drafts?.[mainKey] ?? textPopup?.drafts?.[linkKey] ?? '');
  }
  if (textPopup?.drafts && Object.prototype.hasOwnProperty.call(textPopup.drafts, key)) {
    return String(textPopup.drafts[key] ?? '');
  }
  return String(row?.[key] ?? '');
}

function rowWithPopupDraftLinks(row, textPopup, group, erpAttrCols = []) {
  if (!row) return row;
  const linkKey = popupLinkFieldKey(textPopup?.col, erpAttrCols);
  let next = { ...row, ...(textPopup?.drafts || {}) };
  if (!linkKey) return next;
  for (const c of group || []) {
    if (!c?.key || isPopupMainColumn(c, linkKey)) continue;
    if (!textPopup?.independent?.[c.key]) continue;
    const mp = bulkMpCodeForColumn(c.key) || c.mpAttr?.bucket || c.mpBucket;
    if (!mp) continue;
    next = {
      ...next,
      mp_field_links: setMpFieldLink(next.mp_field_links, linkKey, mp, false),
    };
  }
  return next;
}

const EMPTY_TEXT_POPUP = { open: false, rowId: null, col: null, drafts: {}, independent: {} };

function applyOneBulkCellChange(
  row,
  key,
  value,
  {
    erpAttrColumnDefs = [],
    mpAttrColumnDefs = [],
    lengthUnit = 'mm',
    weightUnit = 'g',
    ozonDictOptions = {},
  } = {}
) {
  let next = withSyncedLinkedFields(row, key, value, erpAttrColumnDefs, mpAttrColumnDefs);
  const fieldKey = bulkLinkFieldForColumn(key);
  if (fieldKey === 'country') {
    next = applyLinkedCountryToDictAttrColumns(
      next,
      next.country_of_origin,
      mpAttrColumnDefs,
      ozonDictOptions
    );
  }
  if (fieldKey === 'brand') {
    next = applyLinkedBrandToOzonAttrColumns(next, next.brand, mpAttrColumnDefs, ozonDictOptions);
  }
  if (fieldKey === 'name' || fieldKey === 'description' || fieldKey === 'product_dimensions') {
    next = applyLinkedOzonNameAndAnnotationColumns(next, mpAttrColumnDefs, lengthUnit, weightUnit);
  }
  const attrCol = (mpAttrColumnDefs || []).find((c) => c.key === key);
  if (attrCol) {
    next = syncOzonCardTextFromAttrColumn(next, attrCol, value);
    next = unlinkProductDimsIfMpDimAttrEdited(next, attrCol);
  }
  return finalizeBulkRowAfterCellChange(next, key, erpAttrColumnDefs, mpAttrColumnDefs);
}

function PinIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      className="products-bulk-pin-icon"
    >
      <path
        fill="currentColor"
        d="M16 3a1 1 0 0 1 .8 1.6l-2.2 2.93 1.47 4.42a1 1 0 0 1-.34 1.1l-1.73 1.38V21a1 1 0 1 1-2 0v-6.57l-1.73-1.38a1 1 0 0 1-.34-1.1l1.47-4.42L9.2 4.6A1 1 0 0 1 10 3h6z"
      />
    </svg>
  );
}

function HideColumnIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      className="products-bulk-hide-icon"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3l18 18M10.6 10.6A2 2 0 0 0 13.4 13.4M9.9 5.1A10.5 10.5 0 0 1 21 12c-.7 1.3-1.7 2.5-3 3.5M6.1 6.1A10.5 10.5 0 0 0 3 12c1.6 3.4 5.4 6 9 6 1.3 0 2.6-.3 3.7-.9"
      />
    </svg>
  );
}

function FillColumnIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      className="products-bulk-fill-icon"
    >
      <path
        fill="currentColor"
        d="M19.14 9.46 12.7 3.03a1 1 0 0 0-1.41 0L3.03 11.3a1 1 0 0 0 0 1.41l6.43 6.43a1 1 0 0 0 1.41 0l2.12-2.12 4.6-4.6a3.2 3.2 0 0 0 1.55-2.96zM9.15 17.43 4.44 12.72l7.05-7.05 4.71 4.71-7.05 7.05zM20.5 14.2c0 1.7-2.5 4.3-2.5 4.3s-2.5-2.6-2.5-4.3a2.5 2.5 0 1 1 5 0z"
      />
    </svg>
  );
}

export function ProductsBulkEdit() {
  const location = useLocation();
  const navigate = useNavigate();
  const createMode = location.state?.createMode === true;
  const initialBulkFilters = useMemo(
    () => resolveInitialBulkFilters(location.state),
    // только первый mount: location.state есть при переходе с «Товаров», после F5 — из storage
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
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
  const [categoryScopeReady, setCategoryScopeReady] = useState(() =>
    resolveInitialCategoryScope(location.state, initialBulkFilters)
  );
  const [categoryPickDraft, setCategoryPickDraft] = useState(() =>
    resolveInitialCategoryPickDraft(location.state, initialBulkFilters)
  );
  const [pickerHasUncategorized, setPickerHasUncategorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState(null);
  const [pushMpLoading, setPushMpLoading] = useState(null);
  const [pushMpMessage, setPushMpMessage] = useState(null);
  const [barcodeGeneratingId, setBarcodeGeneratingId] = useState(null);
  const [pullMpLoading, setPullMpLoading] = useState(null);
  const [pullMpMessage, setPullMpMessage] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(readBulkPageSize);
  const [totalProducts, setTotalProducts] = useState(0);

  const [filterOrganizationId, setFilterOrganizationId] = useState(() => {
    const v = initialBulkFilters?.organizationId;
    return v != null && v !== '' ? String(v) : '';
  });
  const bulkLimitOrgIds = useMemo(() => {
    const ids = new Set();
    if (filterOrganizationId) ids.add(String(filterOrganizationId));
    for (const r of rows) {
      const id = String(r?.organizationId || '').trim();
      if (id) ids.add(id);
    }
    return [...ids];
  }, [filterOrganizationId, rows]);
  const limitsByOrg = useMarketplaceFieldLimitsByOrg(bulkLimitOrgIds);
  const limitsForRow = useCallback(
    (row) => {
      const oid = String(row?.organizationId || filterOrganizationId || '').trim();
      return (oid && limitsByOrg[oid]) || emptyFieldLimitsByMp();
    },
    [filterOrganizationId, limitsByOrg]
  );
  const [filterBrandId, setFilterBrandId] = useState(() => {
    const v = initialBulkFilters?.brandId;
    return v != null && v !== '' ? String(v) : '';
  });
  const [filterCategoryId, setFilterCategoryId] = useState(() =>
    resolveInitialFilterCategoryId(location.state, initialBulkFilters)
  );
  const [filterProductType, setFilterProductType] = useState(() => {
    const v = initialBulkFilters?.productType;
    return v != null && String(v).trim() !== '' ? String(v).trim() : '';
  });
  useEffect(() => {
    if (!kitsEnabled && filterProductType) {
      setFilterProductType('');
    }
  }, [kitsEnabled, filterProductType]);
  const [filterUnlinkedMp, setFilterUnlinkedMp] = useState(() =>
    mpFilterSetFromState(initialBulkFilters?.unlinkedMp)
  );
  const [filterLinkedMp, setFilterLinkedMp] = useState(() =>
    mpFilterSetFromState(initialBulkFilters?.linkedMp)
  );
  const [listSearch, setListSearch] = useState(() => {
    const v = initialBulkFilters?.search;
    return v != null ? String(v) : '';
  });
  /** ERP-категории всей выборки по фильтрам (не только текущая страница) — для столбцов МП. */
  const [filterScopeCategoryIds, setFilterScopeCategoryIds] = useState([]);
  const [filtersOpen, setFiltersOpen] = useState(() => initialBulkFilters?.filtersOpen === true);
  /** null — до первой загрузки; при выборке с «Товаров» учитываются только выбранные id */
  const [showUncategorizedCategoryOption, setShowUncategorizedCategoryOption] = useState(null);
  const [appliedSelectedIds] = useState(() =>
    Array.isArray(location.state?.selectedIds)
      ? [...new Set(location.state.selectedIds.map((x) => str(x)).filter(Boolean))]
      : []
  );

  const bulkFilterUnlinkedKey = [...filterUnlinkedMp].sort().join(',');
  const bulkFilterLinkedKey = [...filterLinkedMp].sort().join(',');

  useEffect(() => {
    writeBulkEditFiltersStorage({
      organizationId: filterOrganizationId || '',
      brandId: filterBrandId || '',
      categoryId: categoryIdFromScopePick(categoryPickDraft),
      categoryPickDraft: categoryPickDraft || CATEGORY_SCOPE_UNSET,
      productType: filterProductType || '',
      search: listSearch || '',
      unlinkedMp: [...filterUnlinkedMp],
      linkedMp: [...filterLinkedMp],
      filtersOpen: !!filtersOpen,
    });
  }, [
    filterOrganizationId,
    filterBrandId,
    filterCategoryId,
    categoryPickDraft,
    filterProductType,
    listSearch,
    bulkFilterUnlinkedKey,
    bulkFilterLinkedKey,
    filtersOpen,
  ]);

  /** Снять filters из history.state — иначе F5 подставляет устаревшие фильтры «Товаров». */
  useEffect(() => {
    if (!location.state?.filters) return;
    const nextState = { ...(location.state || {}) };
    delete nextState.filters;
    navigate('/products/bulk-edit', { replace: true, state: nextState });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listSearchDebounceRef = useRef(null);
  const loadGenRef = useRef(0);
  const newBulkRowSeqRef = useRef(0);
  const currentPageRef = useRef(1);
  const pageSizeRef = useRef(pageSize);
  currentPageRef.current = currentPage;
  pageSizeRef.current = pageSize;

  const [bulkModal, setBulkModal] = useState({ open: false, column: null });
  const [bulkDraft, setBulkDraft] = useState('');
  const [textPopup, setTextPopup] = useState(EMPTY_TEXT_POPUP);
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
  const [imageLightbox, setImageLightbox] = useState({ urls: [], index: 0 });
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

  const [mpAttrColumnDefsState, setMpAttrColumnDefs] = useState([]);
  const [erpAttrColumnDefs, setErpAttrColumnDefs] = useState([]);
  const [allProductAttributes, setAllProductAttributes] = useState([]);
  const [mpLabelMaps, setMpLabelMaps] = useState({ ozon: {}, wb: {}, ym: {} });
  const mpAttrColumnDefs = useMemo(() => {
    const catId = String(filterCategoryId || '').trim();
    const catIds =
      catId && catId !== FILTER_CATEGORY_NONE
        ? new Set([catId])
        : new Set((filterScopeCategoryIds || []).map((id) => String(id)));
    return (mpAttrColumnDefsState || []).map((col) =>
      attachDedicatedMainFieldToMpColumn(col, categories, catIds, mpLabelMaps)
    );
  }, [mpAttrColumnDefsState, categories, filterCategoryId, filterScopeCategoryIds, mpLabelMaps]);
  /** Ozon: attrId → [{ id, label }] из getOzonAttributeValues (объединение по категориям страницы) */
  const [ozonBulkDictOptions, setOzonBulkDictOptions] = useState({});
  const ozonBulkDictOptionsRef = useRef(ozonBulkDictOptions);
  ozonBulkDictOptionsRef.current = ozonBulkDictOptions;
  const [showMpOzon, setShowMpOzon] = useState(() => readMpBucketVisibility().ozon);
  const [showMpWb, setShowMpWb] = useState(() => readMpBucketVisibility().wb);
  const [showMpYm, setShowMpYm] = useState(() => readMpBucketVisibility().ym);
  const [pinnedColumnKeys, setPinnedColumnKeys] = useState(() => readPinnedColumnKeys());
  const [hiddenColumnKeys, setHiddenColumnKeys] = useState(() => readHiddenColumnKeys());
  const [columnWidths, setColumnWidths] = useState(() => readColumnWidths());
  const [columnOrderKeys, setColumnOrderKeys] = useState(() => readColumnOrderKeys());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [columnsSearch, setColumnsSearch] = useState('');
  const columnsMenuRef = useRef(null);
  const columnsSearchRef = useRef(null);
  const colDragKeyRef = useRef(null);
  const colResizeRef = useRef(null);
  const [colDragOverKey, setColDragOverKey] = useState(null);

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
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_COL_WIDTHS, JSON.stringify(columnWidths));
      }
    } catch {
      /* ignore */
    }
  }, [columnWidths]);
  useEffect(() => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_COL_ORDER, JSON.stringify(columnOrderKeys));
      }
    } catch {
      /* ignore */
    }
  }, [columnOrderKeys]);

  useEffect(() => {
    if (!columnsMenuOpen) return undefined;
    const onDoc = (e) => {
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target)) {
        setColumnsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
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
    const out = [...erp, ...erpAttrColumnDefs];
    for (const bucket of ['ozon', 'wb', 'ym']) {
      if (!bucketVisible(bucket)) continue;
      const dedicated = COLUMNS.filter((c) => c.mpBucket === bucket);
      const attrs = visibleMpAttrColumnDefs.filter(
        (c) => c.mpAttr?.bucket === bucket || c.mpOfferField?.mp === bucket
      );
      out.push(...sortMpSectionColumns(dedicated, attrs));
    }
    const labeled = withDisplayUnitLabels(out, lengthUnit, weightUnit);
    const catIds = bulkEditCategoryIdSet(
      categories,
      filterCategoryId,
      rows,
      filterScopeCategoryIds
    );
    return labeled.map((col) => {
      let next = attachDedicatedMainFieldToMpColumn(col, categories, catIds, mpLabelMaps);
      if (col.mpBucket && BULK_DEDICATED_OFFER_FIELD_BY_COL[col.key]) {
        next = attachDedicatedOfferColumnLinkMeta(next, erpAttrColumnDefs);
        next = attachDedicatedMainFieldToMpColumn(next, categories, catIds, mpLabelMaps);
      }
      if (!col.mpBucket && !col.erpAttr && !col.mpAttr && !col.mpOfferField) {
        const lookupKey =
          (DEDICATED_MAIN_MAP_KEYS.includes(col.key) && col.key) ||
          (col.linkFieldKey && isDedicatedMpFieldLinkKey(col.linkFieldKey) && col.linkFieldKey) ||
          '';
        if (lookupKey) {
          const mapped = dedicatedMappedMpsFromCategories(
            categories,
            filterCategoryId,
            rows,
            lookupKey,
            filterScopeCategoryIds
          );
          if (mapped.length) {
            next = {
              ...col,
              mappedMps: mapped,
              linkSupportedMps:
                col.linkFieldKey === 'product_dimensions' || col.linkFieldKey === 'dimensions'
                  ? supportedMpsForFieldKey(col.linkFieldKey)
                  : mapped,
              showLinkToggles: col.showLinkToggles !== false,
            };
          }
        }
      }
      let relatedKey =
        next.key === 'name' || next.key === 'description'
          ? next.key
          : next.linkFieldKey === 'name' || next.linkFieldKey === 'description'
            ? next.linkFieldKey
            : '';
      if (!relatedKey && next.mpAttr?.bucket === 'ozon') {
        const fake = { id: next.mpAttr.attrId, name: next._humanName || next.label };
        if (isOzonNameAttr(fake)) relatedKey = 'name';
        else if (isOzonAnnotationAttr(fake)) relatedKey = 'description';
      }
      if (relatedKey) {
        next = {
          ...next,
          showRelatedFields: mainFieldShowsRelatedFields(allProductAttributes, relatedKey),
        };
      }
      return attachBulkCategoryLinkIndicators(
        next,
        erpAttrColumnDefs,
        mpLabelMaps,
        categories,
        filterCategoryId,
        rows,
        filterScopeCategoryIds
      );
    });
  }, [
    visibleMpAttrColumnDefs,
    erpAttrColumnDefs,
    mpLabelMaps,
    showMpOzon,
    showMpWb,
    showMpYm,
    supplierBindingEnabled,
    kitsEnabled,
    lengthUnit,
    weightUnit,
    categories,
    filterCategoryId,
    filterScopeCategoryIds,
    rows,
    allProductAttributes,
  ]);

  /** Сдвиг закреплённого / незакреплённого столбца перетаскиванием заголовка */
  const moveColumnByDrag = useCallback(
    (fromKey, toKey) => {
      const from = String(fromKey || '');
      const to = String(toKey || '');
      if (!from || !to || from === to) return;
      if (from === SELECT_COL_KEY || from === DEFAULT_STICKY_COL_KEY) return;
      if (to === SELECT_COL_KEY || to === DEFAULT_STICKY_COL_KEY) return;

      const fromPinned = pinnedColumnKeys.includes(from);
      const toPinned = pinnedColumnKeys.includes(to);
      if (fromPinned !== toPinned) return;

      if (fromPinned) {
        setPinnedColumnKeys((prev) => reorderKeyList(prev, from, to));
        return;
      }

      setColumnOrderKeys((prev) => {
        const pinnedSet = new Set(pinnedColumnKeys || []);
        const restKeys = (visibleColumns || [])
          .map((c) => c.key)
          .filter((k) => k && k !== DEFAULT_STICKY_COL_KEY && !pinnedSet.has(k));
        const base = applyColumnOrder(
          restKeys.map((k) => ({ key: k })),
          prev
        ).map((c) => c.key);
        return reorderKeyList(base, from, to);
      });
    },
    [pinnedColumnKeys, visibleColumns]
  );

  const startColumnResize = useCallback((e, colKey, startW) => {
    e.preventDefault();
    e.stopPropagation();
    const key = String(colKey || '');
    if (!key || key === SELECT_COL_KEY) return;
    colResizeRef.current = {
      key,
      startX: e.clientX,
      startW: clampColWidthPx(startW),
    };
    colDragKeyRef.current = null;
    setColDragOverKey(null);
    document.body.classList.add('products-bulk-col-resizing');

    const onMove = (ev) => {
      const st = colResizeRef.current;
      if (!st) return;
      const next = clampColWidthPx(st.startW + (ev.clientX - st.startX));
      setColumnWidths((prev) => {
        if (prev[st.key] === next) return prev;
        return { ...prev, [st.key]: next };
      });
    };
    const onUp = () => {
      colResizeRef.current = null;
      document.body.classList.remove('products-bulk-col-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const displayColumns = useMemo(() => {
    const hidden = new Set(hiddenColumnKeys || []);
    const pinned = new Set(pinnedColumnKeys || []);
    const q = String(columnsSearch || '').trim();
    const ordered = orderColumnsWithPins(visibleColumns, pinnedColumnKeys, columnOrderKeys).filter(
      (c) => {
        if (ALWAYS_VISIBLE_COL_KEYS.has(c.key) || pinned.has(c.key)) return true;
        if (q) return columnMatchesSearchQuery(c, q);
        return !hidden.has(c.key);
      }
    );
    const out = [SELECT_COL];
    const seen = new Set([SELECT_COL_KEY]);
    for (const col of ordered) {
      const key = String(col?.key || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(col);
    }
    return out;
  }, [visibleColumns, pinnedColumnKeys, hiddenColumnKeys, columnsSearch, columnOrderKeys]);

  const stickyLeftMap = useMemo(
    () => buildStickyLeftMap(displayColumns, pinnedColumnKeys, columnWidths),
    [displayColumns, pinnedColumnKeys, columnWidths]
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

  const hideColumnFromHeader = useCallback((colKey) => {
    const key = String(colKey || '');
    if (!key || ALWAYS_VISIBLE_COL_KEYS.has(key)) return;
    setPinnedColumnKeys((prev) => prev.filter((k) => k !== key));
    setHiddenColumnKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  const filteredColumnMenuItems = useMemo(() => {
    const q = String(columnsSearch || '').trim();
    return (visibleColumns || []).filter((col) => {
      if (q) return columnMatchesSearchQuery(col, q);
      return true;
    });
  }, [visibleColumns, columnsSearch]);

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
      const w = colHeaderWidthPx(col, columnWidths);
      const base = { minWidth: w, width: w, maxWidth: w };
      const meta = stickyLeftMap.get(col.key);
      if (!meta) return base;
      /* top тоже inline: Chrome иначе игнорирует CSS-top, если left задан через style */
      return {
        ...base,
        left: meta.left,
        top: header ? 0 : 'auto',
        width: meta.width,
        minWidth: meta.width,
        maxWidth: meta.width,
        zIndex: header ? 40 + meta.zIndex : meta.zIndex,
      };
    },
    [stickyLeftMap, columnWidths]
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
    currentPageRef.current = 1;
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
      const [cats, attrRes] = await Promise.all([
        loadCategories({ silent: true }),
        productAttributesApi.getAll().catch(() => ({ data: [] })),
      ]);
      const erpAttrs = Array.isArray(attrRes?.data) ? attrRes.data : [];
      setAllProductAttributes(erpAttrs);

      const org = partial.organizationId !== undefined ? partial.organizationId : filterOrganizationId;
      const brand = partial.brandId !== undefined ? partial.brandId : filterBrandId;
      const cat =
        partial.categoryId !== undefined
          ? categoryIdFromScopePick(
              partial.categoryId === '' || partial.categoryId === CATEGORY_SCOPE_ALL
                ? CATEGORY_SCOPE_ALL
                : partial.categoryId
            )
          : categoryIdFromScopePick(categoryPickDraft);
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
        const all = [];
        const CONC = 8;
        for (let i = 0; i < selectedIds.length; i += CONC) {
          if (gen !== loadGenRef.current) return;
          const chunk = selectedIds.slice(i, i + CONC);
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
            if (p?.id != null) all.push(p);
          }
        }
        const filtered = all.filter((p) => productMatchesBulkCategory(p, cat));
        total = filtered.length;
        list = filtered.slice(offset, offset + limit);
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

      const scopeCategoryIds = await fetchBulkEditScopeCategoryIds(
        baseParams,
        selectedIds,
        cat
      );
      if (gen !== loadGenRef.current) return;
      setFilterScopeCategoryIds(scopeCategoryIds);

      const erpCols = buildErpAttrColumnDefs(
        erpAttrs,
        cats || [],
        cat,
        list,
        scopeCategoryIds
      );
      const seedMaps = seedMpLabelMapsFromCategoryLinks(
        cats || [],
        cat,
        list,
        erpCols,
        scopeCategoryIds
      );
      const schemaMaps = await fetchMpAttributeLabelMaps(
        list,
        cats || [],
        cat,
        org,
        scopeCategoryIds
      );
      if (gen !== loadGenRef.current) return;
      const mergedMaps = mergeMpLabelMaps(seedMaps, schemaMaps);
      bulkEditMpLabelMaps = mergedMaps;
      setMpLabelMaps(mergedMaps);
      const mpCols = buildBulkMpAttrColumnDefs(list, erpCols, seedMaps, schemaMaps);
      setMpAttrColumnDefs(mpCols);
      setErpAttrColumnDefs(erpCols);
      const nextRows = list.filter(Boolean).map((p) =>
        productToRow(p, mpCols, lengthUnit, weightUnit, erpCols, cats || [])
      );
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
        void (async () => {
          const ozonDictAttrIds = [
            ...new Set(
              mpCols
                .filter((c) => c.mpAttr?.bucket === 'ozon' && Number(c.dictionaryId) > 0)
                .map((c) => String(c.mpAttr.attrId))
            ),
          ];
          const pairs = Array.isArray(mergedMaps.ozonPairs) ? mergedMaps.ozonPairs : [];
          let dictOut = {};
          if (ozonDictAttrIds.length > 0 && pairs.length > 0) {
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
            for (const [attrId, m] of Object.entries(merged)) {
              dictOut[attrId] = [...m.values()].sort((a, b) =>
                String(a.label).localeCompare(String(b.label), 'ru')
              );
            }
          }
          if (gen !== loadGenRef.current) return;
          setOzonBulkDictOptions(dictOut);

          // После загрузки справочников — дописать связанные страну/бренд в dict-колонки Ozon
          setRows((prev) =>
            prev.map((r) => {
              const links = normalizeMpFieldLinks(r.mp_field_links);
              let next = r;
              if (['ozon', 'wb', 'ym'].some((mp) => isMpFieldLinked(links, 'country', mp))) {
                const countryText = str(r.country_of_origin).trim();
                if (countryText) {
                  next = applyLinkedCountryToDictAttrColumns(next, countryText, mpCols, dictOut);
                }
              }
              if (isMpFieldLinked(links, 'brand', 'ozon') && str(r.brand).trim()) {
                next = applyLinkedBrandToOzonAttrColumns(next, r.brand, mpCols, dictOut);
              }
              next = applyLinkedOzonNameAndAnnotationColumns(next, mpCols, lengthUnit);
              return next;
            })
          );
        })();
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
    categoryPickDraft,
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

  const allocNewBulkRowId = useCallback(() => {
    newBulkRowSeqRef.current += 1;
    return `${NEW_BULK_ROW_PREFIX}${Date.now()}_${newBulkRowSeqRef.current}`;
  }, []);

  const buildCreateRowDefaults = useCallback(
    () => ({
      categoryId: filterCategoryId || '',
      organizationId: filterOrganizationId || '',
      productType: filterProductType || 'product',
    }),
    [filterCategoryId, filterOrganizationId, filterProductType]
  );

  const initCreateRows = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setLoadError(null);
    setSaveMessage(null);
    try {
      const [cats, attrRes] = await Promise.all([
        loadCategories({ silent: true }),
        productAttributesApi.getAll().catch(() => ({ data: [] })),
      ]);
      if (gen !== loadGenRef.current) return;
      const erpAttrs = Array.isArray(attrRes?.data) ? attrRes.data : [];
      setAllProductAttributes(erpAttrs);
      const cat = filterCategoryId;
      const scopeCategoryIds = await fetchBulkEditScopeCategoryIds(
        {
          organizationId: filterOrganizationId || undefined,
          categoryId: cat || undefined,
          productType: filterProductType || undefined,
        },
        [],
        cat
      );
      if (gen !== loadGenRef.current) return;
      setFilterScopeCategoryIds(scopeCategoryIds);
      const erpCols = buildErpAttrColumnDefs(
        erpAttrs,
        cats || [],
        cat,
        [],
        scopeCategoryIds
      );
      const seedMaps = seedMpLabelMapsFromCategoryLinks(
        cats || [],
        cat,
        [],
        erpCols,
        scopeCategoryIds
      );
      const schemaMaps = await fetchMpAttributeLabelMaps(
        [],
        cats || [],
        cat,
        filterOrganizationId,
        scopeCategoryIds
      );
      if (gen !== loadGenRef.current) return;
      const mergedMapsInit = mergeMpLabelMaps(seedMaps, schemaMaps);
      bulkEditMpLabelMaps = mergedMapsInit;
      setMpLabelMaps(mergedMapsInit);
      const mpColsInitial = buildBulkMpAttrColumnDefs([], erpCols, seedMaps, schemaMaps);
      setMpAttrColumnDefs(mpColsInitial);
      setErpAttrColumnDefs(erpCols);
      setShowUncategorizedCategoryOption(false);
      setTotalProducts(CREATE_MODE_INITIAL_ROWS);
      setCurrentPage(1);

      const defaults = buildCreateRowDefaults();
      const nextRows = [];
      const orig = {};
      for (let i = 0; i < CREATE_MODE_INITIAL_ROWS; i += 1) {
        const id = allocNewBulkRowId();
        const stub = emptyProductStubForBulkRow(id, defaults);
        const row = productToRow(stub, mpColsInitial, lengthUnit, weightUnit, erpCols, cats || []);
        nextRows.push(row);
        orig[id] = cloneRow(row);
      }
      setRows(nextRows);
      setOriginals(orig);
      clearChangedForPush();
      setOzonBulkDictOptions({});
      hasUnsavedChangesRef.current = true;
      setHasUnsavedChanges(true);
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      setLoadError(e?.response?.data?.message || e?.message || 'Ошибка подготовки таблицы');
      setRows([]);
      setOriginals({});
      setMpAttrColumnDefs([]);
      setTotalProducts(0);
    } finally {
      if (gen === loadGenRef.current) {
        setLoading(false);
      }
    }
  }, [
    loadCategories,
    filterCategoryId,
    buildCreateRowDefaults,
    allocNewBulkRowId,
    lengthUnit,
    weightUnit,
    clearChangedForPush,
  ]);

  const addCreateRows = useCallback((count = 1) => {
    const n = Math.max(1, Math.min(50, Number(count) || 1));
    const defaults = buildCreateRowDefaults();
    const added = [];
    const origPatch = {};
    for (let i = 0; i < n; i += 1) {
      const id = allocNewBulkRowId();
      const stub = emptyProductStubForBulkRow(id, defaults);
      const row = productToRow(
        stub,
        mpAttrColumnDefs,
        lengthUnit,
        weightUnit,
        erpAttrColumnDefs,
        categories || []
      );
      added.push(row);
      origPatch[id] = cloneRow(row);
    }
    setOriginals((o) => ({ ...o, ...origPatch }));
    setRows((list) => {
      const nextLen = list.length + added.length;
      setTotalProducts((t) => (createMode ? nextLen : Math.max(0, Number(t) || 0) + added.length));
      return [...list, ...added];
    });
    markDirty();
    queueMicrotask(() => {
      const el = bulkScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [
    buildCreateRowDefaults,
    allocNewBulkRowId,
    mpAttrColumnDefs,
    erpAttrColumnDefs,
    categories,
    lengthUnit,
    weightUnit,
    markDirty,
    createMode,
  ]);

  useEffect(() => {
    const fromPick = categoryIdFromScopePick(categoryPickDraft);
    if (fromPick === String(filterCategoryId || '')) return;
    setFilterCategoryId(fromPick);
  }, [categoryPickDraft, filterCategoryId]);

  useEffect(() => {
    if (!categoryScopeReady) return;
    if (createMode) {
      initCreateRows();
    } else {
      loadProducts();
    }
  }, [loadProducts, initCreateRows, categoryScopeReady, createMode]);

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
      if (createMode) return;
      void loadProducts({ organizationId: v, page: 1 });
    });
  };

  const handleFilterBrandChange = (e) => {
    const v = e.target.value;
    requestLeaveGuard(() => {
      setFilterBrandId(v);
      setCurrentPage(1);
      currentPageRef.current = 1;
      if (createMode) return;
      void loadProducts({ brandId: v, page: 1 });
    });
  };

  const handleFilterProductTypeChange = (e) => {
    const v = e.target.value;
    requestLeaveGuard(() => {
      setFilterProductType(v);
      setCurrentPage(1);
      if (createMode) return;
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
      if (createMode) return;
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
      if (createMode) return;
      void loadProducts({ linkedMp: nextLinked, unlinkedMp: nextUnlinked, page: 1 });
    });
  };

  const handleListSearchChange = (e) => {
    const v = e.target.value;
    setListSearch(v);
    if (createMode) return;
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
      if (createMode) return;
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
    if (createMode) return;
    const next = Math.min(Math.max(1, page), totalPages);
    if (next === currentPage) return;
    requestLeaveGuard(() => {
      setCurrentPage(next);
      void loadProducts({ page: next });
    });
  };

  const handlePageSizeChange = (e) => {
    if (createMode) return;
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

  const renderAddRowsButtons = () => {
    const disabled = saving || loading;
    return (
      <div className="products-bulk-add-rows">
        <Button
          className="btn-shadow"
          variant="secondary"
          size="small"
          type="button"
          onClick={() => addCreateRows(1)}
          disabled={disabled}
          title="Добавить одну пустую строку"
        >
          + Добавить строку
        </Button>
        <Button
          className="btn-shadow"
          variant="secondary"
          size="small"
          type="button"
          onClick={() => addCreateRows(5)}
          disabled={disabled}
          title="Добавить 5 пустых строк"
        >
          + 5 строк
        </Button>
        <Button
          className="btn-shadow"
          variant="secondary"
          size="small"
          type="button"
          onClick={() => addCreateRows(10)}
          disabled={disabled}
          title="Добавить 10 пустых строк"
        >
          + 10 строк
        </Button>
      </div>
    );
  };

  const renderBulkListPager = (placement) => {
    if (createMode) return null;
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

  const openImageLightbox = useCallback((images, index = 0) => {
    const list = normalizeProductImagesOrder(parseProductImages(images));
    const urls = list
      .map((img) => resolveProductImageUrl(img?.url || img?.src || img?.link || ''))
      .filter(Boolean);
    if (!urls.length) return;
    const clicked = resolveProductImageUrl(
      list[index]?.url || list[index]?.src || list[index]?.link || ''
    );
    const i = clicked ? urls.indexOf(clicked) : index;
    setImageLightbox({ urls, index: i >= 0 ? i : 0 });
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

  const handleBulkRestoreImageAspect3x4 = useCallback(
    async (imageId) => {
      const productId = imagesModal.productId;
      if (!productId || !imageId) return;
      setImagesModal((m) => ({ ...m, aspectLoadingId: String(imageId), error: '' }));
      try {
        const r = await productsApi.restoreImageAspect3x4(productId, imageId);
        const list = applyImagesToRow(productId, extractImagesFromApiPayload(r));
        setImagesModal((m) => ({ ...m, images: list, aspectLoadingId: '', error: '' }));
      } catch (e) {
        setImagesModal((m) => ({
          ...m,
          aspectLoadingId: '',
          error: e?.response?.data?.error || e?.message || 'Не удалось вернуть исходное фото',
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
    const ctx = {
      erpAttrColumnDefs,
      mpAttrColumnDefs,
      lengthUnit,
      weightUnit,
      ozonDictOptions: ozonBulkDictOptionsRef.current,
    };
    setRows((prev) => prev.map((r) => applyOneBulkCellChange(r, key, bulkDraft, ctx)));
    setBulkModal({ open: false, column: null });
  };

  const updateCell = useCallback((id, key, value) => {
    markChangedForPush(id);
    markDirty();
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        return applyOneBulkCellChange(r, key, value, {
          erpAttrColumnDefs,
          mpAttrColumnDefs,
          lengthUnit,
          weightUnit,
          ozonDictOptions: ozonBulkDictOptionsRef.current,
        });
      })
    );
  }, [markChangedForPush, markDirty, mpAttrColumnDefs, erpAttrColumnDefs, lengthUnit, weightUnit]);

  const updateCells = useCallback((id, pairs) => {
    if (!id || !Array.isArray(pairs) || pairs.length === 0) return;
    markChangedForPush(id);
    markDirty();
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        let next = r;
        for (const [key, value] of pairs) {
          next = applyOneBulkCellChange(next, key, value, {
            erpAttrColumnDefs,
            mpAttrColumnDefs,
            lengthUnit,
            weightUnit,
            ozonDictOptions: ozonBulkDictOptionsRef.current,
          });
        }
        return next;
      })
    );
  }, [markChangedForPush, markDirty, mpAttrColumnDefs, erpAttrColumnDefs, lengthUnit, weightUnit]);

  const handleGenerateBarcode = useCallback(
    async (row) => {
      const id = row?.id;
      if (id == null) return;
      setBarcodeGeneratingId(id);
      try {
        const savedId = isNewBulkRowId(id) ? undefined : id;
        const body = await productsApi.generateBarcode({
          productId: savedId,
          organizationId: row.organizationId || undefined,
        });
        const code = coerceBarcodeString(body?.data?.barcode ?? body?.barcode ?? body?.data);
        if (!code || isCorruptBarcodeString(code)) throw new Error('Не удалось сгенерировать штрихкод');
        updateCell(id, 'barcodes', code);
      } catch (e) {
        window.alert(e?.response?.data?.message || e?.message || 'Не удалось сгенерировать штрихкод');
      } finally {
        setBarcodeGeneratingId(null);
      }
    },
    [updateCell]
  );

  /** Тумблеры в шапке: включают/выключают связь для всех строк на экране. */
  const applyBulkLinkToRow = useCallback(
    (r, fieldKey, mp, enable, supported) => {
      let next = {
        ...r,
        mp_field_links: setMpFieldLink(r.mp_field_links, fieldKey, mp, enable, supported),
      };
      if (!enable) return next;
      next = copyMainFieldToMp(next, fieldKey, mp, erpAttrColumnDefs, mpAttrColumnDefs);
      if (fieldKey === 'country') {
        next = applyLinkedCountryToDictAttrColumns(
          next,
          next.country_of_origin,
          mpAttrColumnDefs,
          ozonBulkDictOptionsRef.current
        );
      }
      if (fieldKey === 'brand' && mp === 'ozon') {
        next = applyLinkedBrandToOzonAttrColumns(
          next,
          next.brand,
          mpAttrColumnDefs,
          ozonBulkDictOptionsRef.current
        );
      }
      if ((fieldKey === 'name' || fieldKey === 'description') && mp === 'ozon') {
        next = applyLinkedOzonNameAndAnnotationColumns(next, mpAttrColumnDefs, lengthUnit, weightUnit);
      }
      if (fieldKey === 'product_dimensions') {
        next = applyLinkedMpProductDimAttrColumns(next, mpAttrColumnDefs, lengthUnit, weightUnit);
      }
      return syncOfferFieldColsOnRow(next, mpAttrColumnDefs);
    },
    [erpAttrColumnDefs, mpAttrColumnDefs, lengthUnit, weightUnit]
  );

  const bulkLinkableFieldDefs = useMemo(() => {
    const seen = new Map();
    for (const col of displayColumns || []) {
      if (!col.linkFieldKey || seen.has(col.linkFieldKey)) continue;
      const mapped = Array.isArray(col.mappedMps) ? col.mappedMps : [];
      const canToggle =
        col.showLinkToggles ||
        (col.erpAttr && mapped.length > 0) ||
        (mapped.length > 0 && !col.mpBucket && !col.mpAttr && !col.mpOfferField);
      if (!canToggle) continue;
      const supported =
        col.linkSupportedMps ||
        (col.linkFieldKey === 'product_dimensions' || col.linkFieldKey === 'dimensions'
          ? supportedMpsForFieldKey(col.linkFieldKey)
          : mapped.length
            ? mapped
            : undefined);
      seen.set(col.linkFieldKey, supported);
    }
    return [...seen.entries()].map(([fieldKey, supported]) => ({ fieldKey, supported }));
  }, [displayColumns]);

  const toggleBulkHeaderFieldLink = useCallback(
    (fieldKey, mp) => {
      if (!rows.length) return;
      const def = bulkLinkableFieldDefs.find((d) => d.fieldKey === fieldKey);
      const supported =
        fieldKey === 'product_dimensions' || fieldKey === 'dimensions'
          ? undefined
          : def?.supported;
      const anyOn = rows.some((r) =>
        isMpFieldLinked(normalizeMpFieldLinks(r.mp_field_links), fieldKey, mp)
      );
      const enable = !anyOn;
      markChangedForPush(rows.map((r) => r.id));
      markDirty();
      setRows((prev) => prev.map((r) => applyBulkLinkToRow(r, fieldKey, mp, enable, supported)));
    },
    [rows, markChangedForPush, markDirty, bulkLinkableFieldDefs, applyBulkLinkToRow]
  );

  const toggleBulkMasterMpLink = useCallback(() => {
    if (!rows.length || !bulkLinkableFieldDefs.length) return;
    const anyOn = rows.some((r) =>
      bulkLinkableFieldDefs.some(({ fieldKey, supported }) =>
        supportedMpsForFieldKey(fieldKey, supported).some((mp) =>
          isMpFieldLinked(normalizeMpFieldLinks(r.mp_field_links), fieldKey, mp)
        )
      )
    );
    const enable = !anyOn;
    markChangedForPush(rows.map((r) => r.id));
    markDirty();
    setRows((prev) =>
      prev.map((r) => {
        let next = r;
        for (const { fieldKey, supported } of bulkLinkableFieldDefs) {
          for (const mp of supportedMpsForFieldKey(fieldKey, supported)) {
            next = applyBulkLinkToRow(next, fieldKey, mp, enable, supported);
          }
        }
        return next;
      })
    );
  }, [rows, bulkLinkableFieldDefs, markChangedForPush, markDirty, applyBulkLinkToRow]);

  const mpLinksFingerprint = useMemo(
    () => rows.map((r) => linksSignature(r.mp_field_links)).join('\n'),
    [rows]
  );

  const headerLinksByField = useMemo(() => {
    const keys = new Set();
    for (const col of displayColumns || []) {
      if (col.linkFieldKey) keys.add(col.linkFieldKey);
      if (col.mpAttr || col.mpOfferField || col.mpBucket) {
        const resolved = resolveBulkMpColumnLinkFieldKey(col, erpAttrColumnDefs);
        if (resolved) keys.add(resolved);
      }
    }
    for (const r of rows) {
      const links = normalizeMpFieldLinks(r.mp_field_links);
      for (const fk of Object.keys(links)) {
        if (Array.isArray(links[fk]) && links[fk].length) keys.add(fk);
      }
    }
    const out = {};
    for (const fieldKey of keys) {
      const base = { ...emptyMpFieldLinks(), [fieldKey]: [] };
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
  }, [mpLinksFingerprint, displayColumns, erpAttrColumnDefs, rows.length]);

  const headerLinksForField = useCallback(
    (fieldKey) => headerLinksByField[fieldKey] || emptyMpFieldLinks(),
    [headerLinksByField]
  );

  const headerMasterMpActive = useMemo(() => {
    if (!rows.length || !bulkLinkableFieldDefs.length) return false;
    return rows.some((r) =>
      bulkLinkableFieldDefs.some(({ fieldKey, supported }) =>
        supportedMpsForFieldKey(fieldKey, supported).some((mp) =>
          isMpFieldLinked(normalizeMpFieldLinks(r.mp_field_links), fieldKey, mp)
        )
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpLinksFingerprint, bulkLinkableFieldDefs, rows.length]);

  const handleSave = async (opts = {}) => {
    const suppressPushOffer = opts?.suppressPushOffer === true;
    if (!opts?.skipLimitConfirm) {
      const limitViolations = rows.flatMap((r) =>
        collectBulkRowLimitViolations(r, limitsForRow(r), { mpAttrColumnDefs })
      );
      if (!confirmFieldLimitViolations(limitViolations, 'сохранить')) {
        return { ok: 0, errorCount: 0, cancelled: true };
      }
    }
    setSaving(true);
    setSaveMessage(null);
    const errors = [];
    const savedIds = [];
    let ok = 0;
    let createdCount = 0;
    let skippedEmpty = 0;
    try {
      for (const r of rows) {
        if (isNewBulkRowId(r.id)) {
          const orig = originals[r.id];
          if (!orig) continue;
          const payload = buildCreatePayload(
            orig,
            r,
            mpAttrColumnDefs,
            lengthUnit,
            weightUnit,
            erpAttrColumnDefs
          );
          if (!payload) {
            skippedEmpty += 1;
            continue;
          }
          try {
            const wrap = await productsApi.create(payload);
            const u = wrap?.data !== undefined ? wrap.data : wrap;
            let nextRow = productToRow(
              u,
              mpAttrColumnDefs,
              lengthUnit,
              weightUnit,
              erpAttrColumnDefs,
              categories
            );
            nextRow = {
              ...nextRow,
              mp_field_links: normalizeMpFieldLinks(r.mp_field_links),
            };
            nextRow = preserveBulkDimFieldsAfterSave(nextRow, r, payload, lengthUnit, weightUnit);
            const newId = str(u?.id ?? nextRow.id);
            setOriginals((o) => {
              const next = { ...o };
              delete next[r.id];
              next[newId] = cloneRow(nextRow);
              return next;
            });
            setRows((list) =>
              list.map((row) => (row.id === r.id ? { ...nextRow, id: newId, _productRef: u } : row))
            );
            markChangedForPush(newId);
            savedIds.push(newId);
            ok += 1;
            createdCount += 1;
          } catch (e) {
            const msg = e?.response?.data?.message || e?.response?.data?.error || e?.message || 'Ошибка';
            errors.push({ id: r.id, sku: r.sku, msg });
          }
          continue;
        }
        const orig = originals[r.id];
        if (!orig) continue;
        const payload = buildUpdatePayload(orig, r, mpAttrColumnDefs, lengthUnit, weightUnit, erpAttrColumnDefs);
        if (Object.keys(payload).length === 0) continue;
        try {
          const wrap = await productsApi.update(r.id, payload);
          const u = wrap?.data !== undefined ? wrap.data : wrap;
          let nextRow = productToRow(u, mpAttrColumnDefs, lengthUnit, weightUnit, erpAttrColumnDefs, categories);
          nextRow = {
            ...nextRow,
            mp_field_links: normalizeMpFieldLinks(r.mp_field_links),
          };
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
        if (ok > 0) {
          if (createMode && createdCount > 0) {
            const parts = [`Создано товаров: ${createdCount}.`];
            if (skippedEmpty > 0) parts.push(`Пропущено пустых строк: ${skippedEmpty}.`);
            setSaveMessage(parts.join(' '));
          } else {
            setSaveMessage(ok > 0 ? `Сохранено изменений: ${ok}.` : 'Нет изменений для сохранения.');
          }
        } else if (createMode && skippedEmpty > 0) {
          setSaveMessage('Заполните название и артикул (SKU) хотя бы в одной строке.');
        } else {
          setSaveMessage('Нет изменений для сохранения.');
        }
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
        Object.keys(buildUpdatePayload(orig, r, mpAttrColumnDefs, lengthUnit, weightUnit, erpAttrColumnDefs)).length > 0
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
      const pushMps = expandPushMarketplaces(marketplaces);
      const pushViolations = rows
        .filter((r) => productIds.includes(str(r.id)))
        .flatMap((r) =>
          collectBulkRowLimitViolations(r, limitsForRow(r), { mpAttrColumnDefs }).filter((v) =>
            pushMps.includes(v.mp)
          )
        );
      if (!confirmFieldLimitViolations(pushViolations, 'отправить на маркетплейс')) return;
    }
    if (dirtyAmong.length > 0) {
      const saveResult = await handleSave({
        suppressPushOffer: true,
        skipLimitConfirm: !skipConfirm,
      });
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
      const nmById = new Map();
      for (const it of Array.isArray(data?.items) ? data.items : []) {
        const wb = (it?.results || []).find((r) => r?.marketplace === 'wb' && r?.ok);
        const nm = wb?.nmId ?? wb?.sku_wb;
        if (it?.productId != null && nm != null && String(nm).trim() !== '') {
          nmById.set(str(it.productId), String(nm).trim());
        }
      }
      if (nmById.size > 0) {
        setRows((prev) =>
          prev.map((r) => {
            const nm = nmById.get(str(r.id));
            return nm ? { ...r, sku_wb: nm } : r;
          })
        );
        setOriginals((prev) => {
          const next = { ...prev };
          for (const [id, nm] of nmById) {
            if (next[id]) next[id] = { ...next[id], sku_wb: nm };
          }
          return next;
        });
      }
      const barcodeById = new Map();
      for (const it of Array.isArray(data?.items) ? data.items : []) {
        const code = (it?.results || [])
          .map((r) => coerceBarcodeString(r?.barcodeSent))
          .find((s) => s && !isCorruptBarcodeString(s));
        if (it?.productId != null && code) barcodeById.set(str(it.productId), code);
      }
      if (barcodeById.size > 0) {
        setRows((prev) =>
          prev.map((r) => {
            const code = barcodeById.get(str(r.id));
            if (!code || parseBarcodesCell(r.barcodes).length) return r;
            return { ...r, barcodes: code };
          })
        );
        setOriginals((prev) => {
          const next = { ...prev };
          for (const [id, code] of barcodeById) {
            if (next[id] && !parseBarcodesCell(next[id].barcodes).length) {
              next[id] = { ...next[id], barcodes: code };
            }
          }
          return next;
        });
      }
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
      return createMode ? 'Выберите категорию для новых товаров' : 'Выберите категорию';
    }
    const n = rows.length;
    if (createMode) {
      const draftCount = rows.filter((r) => isNewBulkRowId(r.id)).length;
      return draftCount > 0
        ? `${n} строк · ${draftCount} новых (заполните название и SKU, затем «Сохранить»)`
        : `${n} строк`;
    }
    const sel = appliedSelectedIds.length;
    if (sel > 0) return `${n} на странице из ${sel} выбранных`;
    return `${n} на странице`;
  }, [categoryScopeReady, createMode, rows, appliedSelectedIds.length]);

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
    const linked = isBulkLinkedMpReadonly(row, col.key, erpAttrColumnDefs, mpAttrColumnDefs);
    const vRaw = linked
      ? bulkLinkedMirrorValue(row, col.key, erpAttrColumnDefs, mpAttrColumnDefs, lengthUnit, weightUnit)
      : row[col.key];
    const v =
      col.key === 'barcodes'
        ? formatBarcodesCell(vRaw)
        : col.mpAttr || col.input === 'select_dict' || col.input === 'select_erp_dict'
          ? stringifyMpAttrValue(vRaw)
          : vRaw;
    const overLimit = bulkCellLimitHit(row, col, limitsForRow(row), v);
    const limitInfo = isPopupTextColumn(col, erpAttrColumnDefs)
      ? bulkCellLimitInfo(row, col, limitsForRow(row), v)
      : null;
    const erpAid = col.erpAttr?.id != null ? String(col.erpAttr.id) : '';
    const toolChanged = !!(
      erpAid &&
      row._erpAttrToolBaseline?.[erpAid] &&
      str(v).trim() === str(row._erpAttrBaseline?.[erpAid] ?? '').trim()
    );
    const common = {
      className: `products-bulk-cell-input${
        dimDirty ? ' products-bulk-dim-dirty' : ''
      }${linked ? ' products-bulk-cell-linked' : ''}${overLimit ? ' products-bulk-cell-over-limit' : ''}${
        toolChanged ? ' products-bulk-cell-tool' : ''
      }`,
      value: v ?? '',
      onChange: (e) => updateCell(row.id, col.key, e.target.value),
      title: dimLocked
        ? OZON_DIMS_LOCK_TITLE
        : toolChanged
          ? 'Изменено другим инструментом (стратегия или обновление мин. цен)'
        : overLimit
          ? formatLimitHitTitle(overLimit)
        : linked
          ? 'Связано с «Основным». Правка отвяжет это поле у строки'
          : col.title || undefined,
    };

    if (col.key === 'mp_wb_brand') {
      return (
        <WbBrandSuggest
          className={common.className}
          value={str(v)}
          onChange={(next) => updateCell(row.id, col.key, next)}
          organizationId={row.organizationId || filterOrganizationId}
          title={common.title}
          disabled={linked}
        />
      );
    }

    if (col.input === 'checkbox') {
      const checked = v === 'true' || v === true;
      return (
        <input
          type="checkbox"
          className="form-check-input m-0"
          checked={checked}
          onChange={(e) => updateCell(row.id, col.key, e.target.checked ? 'true' : 'false')}
          title={col.title || col.label}
        />
      );
    }
    if (isPopupTextColumn(col, erpAttrColumnDefs)) {
      const preview = String(v ?? '').trim();
      const countOver = !!limitInfo?.over;
      const countLabel = formatLimitCountLabel(limitInfo, v);
      return (
        <button
          type="button"
          className={`products-bulk-text-popup-btn${countOver ? ' is-over-limit' : ''}${
            linked ? ' is-linked' : ''
          }`}
          onClick={() => {
            const group = collectPopupRelatedColumns(
              col,
              mpAttrColumnDefs,
              erpAttrColumnDefs,
              displayColumns
            );
            const drafts = {};
            for (const c of group) {
              const cellLinked = isBulkLinkedMpReadonly(
                row,
                c.key,
                erpAttrColumnDefs,
                mpAttrColumnDefs
              );
              drafts[c.key] = String(
                cellLinked
                  ? bulkLinkedMirrorValue(
                      row,
                      c.key,
                      erpAttrColumnDefs,
                      mpAttrColumnDefs,
                      lengthUnit,
                      weightUnit
                    )
                  : row[c.key] ?? ''
              );
            }
            setTextPopup({
              open: true,
              rowId: row.id,
              col,
              drafts,
              independent: {},
            });
          }}
          title={
            countOver
              ? formatLimitHitTitle(limitInfo)
              : linked
                ? 'Связано с «Основным». Нажмите, чтобы править (правка отвяжет поле)'
                : 'Открыть редактирование'
          }
        >
          <span className="products-bulk-text-popup-preview">{preview || '—'}</span>
          <span className={`products-bulk-text-popup-count${countOver ? ' is-over' : ''}`}>
            {countLabel}
          </span>
        </button>
      );
    }
    if (col.input === 'date') {
      return <input {...common} type="date" />;
    }
    if (col.input === 'select_erp_dict') {
      const options = Array.isArray(col.dictOptions) ? col.dictOptions : [];
      return (
        <select
          className={`products-bulk-cell-input${overLimit ? ' products-bulk-cell-over-limit' : ''}`}
          value={v ?? ''}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
          title={overLimit ? formatLimitHitTitle(overLimit) : col.title || col.label}
        >
          <option value="">—</option>
          {options.map((opt) => (
            <option key={String(opt.id)} value={String(opt.id)}>
              {opt.label || opt.id}
            </option>
          ))}
        </select>
      );
    }
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
    if (col.input === 'select_bool') {
      const raw = str(v).trim().toLowerCase();
      const boolValue =
        raw === 'true' || raw === '1' || raw === 'да' || raw === 'yes'
          ? 'true'
          : raw === 'false' || raw === '0' || raw === 'нет' || raw === 'no'
            ? 'false'
            : '';
      return (
        <select
          className="products-bulk-cell-input"
          value={boolValue}
          onChange={(e) => updateCell(row.id, col.key, e.target.value)}
          title={col.title || col.label}
        >
          <option value="">—</option>
          <option value="true">Да</option>
          <option value="false">Нет</option>
        </select>
      );
    }
    if (col.key === 'barcodes') {
      const generating = barcodeGeneratingId === row.id;
      return (
        <span className="products-bulk-barcode-cell">
          <input
            {...common}
            className={`${common.className} products-bulk-barcode-input`}
            type="text"
            autoComplete="off"
            placeholder=""
          />
          <button
            type="button"
            className={`products-bulk-barcode-generate${generating ? ' is-busy' : ''}`}
            disabled={generating}
            title="Сгенерировать штрихкод"
            aria-label="Сгенерировать штрихкод"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleGenerateBarcode(row);
            }}
          >
            <BulkBarcodeGenerateIcon />
          </button>
        </span>
      );
    }
    if (col.input === 'textarea') {
      return <input {...common} type="text" autoComplete="off" />;
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
  const textPopupRow = textPopup.open
    ? rows.find((r) => str(r.id) === str(textPopup.rowId))
    : null;
  const textPopupGroup =
    textPopup.col && textPopupRow
      ? collectPopupRelatedColumns(
          textPopup.col,
          mpAttrColumnDefs,
          erpAttrColumnDefs,
          displayColumns
        )
      : [];
  const textPopupLinkKey = popupLinkFieldKey(textPopup.col, erpAttrColumnDefs);
  const textPopupSyntheticRow =
    textPopupRow && textPopup.col
      ? rowWithPopupDraftLinks(textPopupRow, textPopup, textPopupGroup, erpAttrColumnDefs)
      : null;
  const textPopupModalTitle = textPopup.col
    ? `${
        textPopupLinkKey === 'name'
          ? 'Название'
          : textPopupLinkKey === 'description'
            ? 'Описание'
            : textPopup.col.erpAttr
              ? textPopup.col.label || 'Редактируемое поле'
              : popupFieldTitle(textPopup.col)
      }${textPopupRow?.sku ? ` · ${textPopupRow.sku}` : ''}`
    : '';

  return (
    <div key={location.key} className="products-bulk-page">
      <PageTitle
        iconClass="pe-7s-box2"
        iconBgClass="bg-mean-fruit"
        title={createMode ? 'Массовое добавление товаров' : 'Массовое редактирование'}
        subtitle={subtitle}
        actions={(
          <div className="d-flex flex-wrap align-items-center gap-2">
            {categoryScopeReady && !loading ? (
              <>
                {hasUnsavedChanges ? (
                  <span className="text-warning small d-none d-md-inline">Есть изменения</span>
                ) : null}
                {renderAddRowsButtons()}
                {rows.length > 0 ? (
                <Button
                  className="btn-shadow"
                  variant="primary"
                  size="small"
                  type="button"
                  onClick={handleSaveClick}
                  disabled={
                    saving ||
                    (!hasUnsavedChanges && !rows.some((r) => isNewBulkRowId(r.id)))
                  }
                >
                  {saving ? 'Сохранение…' : createMode ? 'Создать товары' : 'Сохранить'}
                </Button>
                ) : null}
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
                  <div className="products-bulk-toolbar-row">
                    <div className="products-bulk-category-scope">
                      <select
                        id="bulk-category-scope-pick"
                        className="form-select form-select-sm products-bulk-category-scope-select"
                        value={categoryScopeReady ? categoryPickDraft : CATEGORY_SCOPE_UNSET}
                        onChange={handleCategoryScopeChange}
                        aria-label={
                          createMode
                            ? 'Категория для новых товаров'
                            : 'Категория для массового редактирования'
                        }
                        title={
                          createMode
                            ? 'Категория определяет столбцы атрибутов для новых товаров'
                            : 'Категория для редактирования'
                        }
                      >
                        {!categoryScopeReady ? (
                          <option value={CATEGORY_SCOPE_UNSET} disabled>
                            Категория…
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
                    </div>
                    {categoryScopeReady ? (
                      <>
                    <div className="products-bulk-toolbar-search">
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
                        disabled={createMode}
                        title={createMode ? 'Поиск недоступен при добавлении новых товаров' : undefined}
                      />
                    </div>
                      <div className="products-bulk-columns-menu" ref={columnsMenuRef}>
                        <div className="products-bulk-columns-toolbar">
                          <input
                            ref={columnsSearchRef}
                            id="bulk-columns-search"
                            type="search"
                            className="form-control form-control-sm products-bulk-columns-search"
                            placeholder="Столбцы…"
                            value={columnsSearch}
                            onChange={(e) => {
                              setColumnsSearch(e.target.value);
                              setColumnsMenuOpen(true);
                            }}
                            onFocus={() => setColumnsMenuOpen(true)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Escape') setColumnsMenuOpen(false);
                            }}
                            autoComplete="off"
                            aria-label="Поиск по названию столбца"
                            aria-expanded={columnsMenuOpen}
                            aria-controls="bulk-columns-list"
                          />
                          {hiddenColumnKeys.length > 0 ? (
                            <span className="badge bg-secondary rounded-pill" title="Скрыто столбцов">
                              {hiddenColumnKeys.length}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-outline-secondary btn-sm products-bulk-columns-show-all"
                            onClick={() => {
                              showAllColumns();
                              setColumnsMenuOpen(true);
                            }}
                            disabled={hiddenColumnKeys.length === 0}
                            title="Показать все скрытые столбцы"
                          >
                            Все
                          </button>
                        </div>
                        {columnsMenuOpen ? (
                          <div className="products-bulk-columns-panel" role="listbox" id="bulk-columns-list">
                            <div className="products-bulk-columns-list">
                              {filteredColumnMenuItems.length === 0 ? (
                                <div className="text-muted small py-2 px-1">Нет столбцов по запросу</div>
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
                        className="btn-shadow products-bulk-filters-btn"
                        onClick={() => setFiltersOpen((o) => !o)}
                        aria-expanded={filtersOpen}
                        title="Организация, бренд, тип, связь с МП, столбцы атрибутов"
                      >
                        {filtersOpen ? '▼ Фильтры' : '▶ Фильтры'}
                        {activeFiltersCount > 0 ? (
                          <span className="badge bg-primary ms-1 rounded-pill">{activeFiltersCount}</span>
                        ) : null}
                      </Button>
                      </>
                    ) : null}
                  </div>
                  {categoryScopeReady ? (
                  <div className="products-bulk-scoped-ui">
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
                      <div className="products-bulk-filters-row products-bulk-filters-row--attrs">
                        <div className="products-bulk-filter-item products-bulk-filter-item--attrs">
                          <span className="text-muted small d-block mb-1">Атрибуты МП</span>
                          <div className="d-flex flex-wrap align-items-center gap-2 gap-md-3">
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
                                Ozon
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
                                WB
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
                                Я.Маркет
                              </label>
                            </div>
                            {mpAttrColumnDefs.length > 0 ? (
                              <span
                                className="text-muted small text-nowrap"
                                title="Число видимых столбцов по JSON-атрибутам маркетплейсов (включённые тумблеры)"
                              >
                                {visibleMpAttrColumnDefs.length > 0
                                  ? `столбцов: ${visibleMpAttrColumnDefs.length}`
                                  : 'скрыты'}
                              </span>
                            ) : (
                              <span className="text-muted small text-nowrap">не найдены</span>
                            )}
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
                  {!createMode ? (
                  <>
                  <div className="products-bulk-mp-toggles-row d-flex flex-wrap align-items-center gap-2">
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
                  </>
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
            <p className="text-muted mb-0">{createMode ? 'Подготовка таблицы…' : 'Загрузка товаров…'}</p>
          ) : rows.length === 0 ? (
            <div className="products-bulk-empty">
              <p className="text-muted mb-2">
                {createMode ? 'Нет строк для добавления.' : 'Нет товаров для отображения.'}
              </p>
              {renderAddRowsButtons()}
              {!createMode ? (
                <p className="text-muted small mb-0 mt-2">
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0 align-baseline"
                    onClick={() => requestLeaveGuard(() => navigate('/products'))}
                  >
                    Перейти в «Товары»
                  </button>
                  {', при необходимости выберите строки или задайте фильтры.'}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="products-bulk-table-xclip">
            <div className="products-bulk-table-wrap">
          <table className="products-bulk-table">
            <thead>
              <tr>
                {displayColumns.map((col) => {
                  const showMasterMp = col.key === SELECT_COL_KEY;
                  const isMpDataColumn = !!(col.mpBucket || col.mpAttr || col.mpOfferField);
                  const showLinkToggles = !!(col.showLinkToggles && col.linkFieldKey && !isMpDataColumn);
                  const categoryLinked = bulkMpColumnCategoryLinked(
                    col,
                    erpAttrColumnDefs,
                    mpLabelMaps,
                    categories,
                    filterCategoryId,
                    rows,
                    filterScopeCategoryIds
                  );
                  const mpCode = col.mpBucket || col.mpAttr?.bucket || col.mpOfferField?.mp || '';
                  const showCategoryLinkIcon = categoryLinked && !isMpDataColumn && !showLinkToggles;
                  // Столбцы МП: скрепка только если связь настроена в категории.
                  const showFromMain = !!(isMpDataColumn && categoryLinked);
                  const fromMainLinked =
                    showFromMain && mpCode
                      ? bulkMpColumnLinkKeys(col, erpAttrColumnDefs).some((k) =>
                          isMpFieldLinked(headerLinksForField(k), k, mpCode)
                        )
                      : false;
                  const canFill = !(col.readonly || col.noBulk);
                  const showMpRow =
                    showMasterMp ||
                    showLinkToggles ||
                    showFromMain ||
                    showCategoryLinkIcon;
                  const showChromeRow =
                    (col.key !== SELECT_COL_KEY && col.key !== DEFAULT_STICKY_COL_KEY) || canFill;
                  const showPinHide =
                    col.key !== SELECT_COL_KEY && col.key !== DEFAULT_STICKY_COL_KEY;

                  if (col.key === SELECT_COL_KEY) {
                    return (
                      <th
                        key={col.key}
                        className={`${colStickyClass(col)} products-bulk-select-col`.trim()}
                        style={colStickyStyle(col, { header: true })}
                        scope="col"
                      >
                        <div className="products-bulk-th-stack">
                          <div className="products-bulk-th-row products-bulk-th-row--title products-bulk-select-head">
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
                          </div>
                          <div className="products-bulk-th-row products-bulk-th-row--chrome" aria-hidden="true" />
                          <div className="products-bulk-th-row products-bulk-th-row--mp">
                            {rows.length > 0 && bulkLinkableFieldDefs.length > 0 ? (
                              <MarketplaceToggle
                                active={headerMasterMpActive}
                                size={14}
                                color="#334155"
                                title={
                                  headerMasterMpActive
                                    ? 'Снять связь со всеми полями «Основное» → Ozon / WB / ЯМ'
                                    : 'Связать все поля «Основное» с Ozon / WB / ЯМ'
                                }
                                onToggle={toggleBulkMasterMpLink}
                              >
                                МП
                              </MarketplaceToggle>
                            ) : null}
                          </div>
                        </div>
                      </th>
                    );
                  }

                  return (
                    <th
                      key={col.key}
                      className={`${colStickyClass(col)} ${col.headerClass || ''} ${mpColClassName(col)} ${
                        colDragOverKey === col.key ? 'is-col-drag-over' : ''
                      } ${
                        col.key !== DEFAULT_STICKY_COL_KEY ? 'products-bulk-th--draggable' : ''
                      }`.trim()}
                      style={colStickyStyle(col, { header: true })}
                      draggable={col.key !== DEFAULT_STICKY_COL_KEY}
                      onDragStart={(e) => {
                        if (colResizeRef.current) {
                          e.preventDefault();
                          return;
                        }
                        if (col.key === DEFAULT_STICKY_COL_KEY) {
                          e.preventDefault();
                          return;
                        }
                        colDragKeyRef.current = col.key;
                        try {
                          e.dataTransfer.setData('text/plain', col.key);
                          e.dataTransfer.effectAllowed = 'move';
                        } catch {
                          /* ignore */
                        }
                      }}
                      onDragEnd={() => {
                        colDragKeyRef.current = null;
                        setColDragOverKey(null);
                      }}
                      onDragOver={(e) => {
                        const from = colDragKeyRef.current;
                        if (!from || from === col.key) return;
                        if (col.key === DEFAULT_STICKY_COL_KEY) return;
                        const fromPinned = pinnedColumnKeys.includes(from);
                        const toPinned = pinnedColumnKeys.includes(col.key);
                        if (fromPinned !== toPinned) return;
                        e.preventDefault();
                        try {
                          e.dataTransfer.dropEffect = 'move';
                        } catch {
                          /* ignore */
                        }
                        if (colDragOverKey !== col.key) setColDragOverKey(col.key);
                      }}
                      onDragLeave={() => {
                        if (colDragOverKey === col.key) setColDragOverKey(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from =
                          colDragKeyRef.current ||
                          (() => {
                            try {
                              return e.dataTransfer.getData('text/plain');
                            } catch {
                              return '';
                            }
                          })();
                        setColDragOverKey(null);
                        colDragKeyRef.current = null;
                        moveColumnByDrag(from, col.key);
                      }}
                      title={
                        col.key !== DEFAULT_STICKY_COL_KEY
                          ? `${col.title || col.label || ''} — перетащите для смены порядка`
                          : col.title || undefined
                      }
                    >
                      <div className="products-bulk-th-stack">
                        <div className="products-bulk-th-row products-bulk-th-row--title">
                          <span
                            className="products-bulk-th-text"
                            title={col.title || col.hint || col.label || undefined}
                          >
                            {col.label}
                          </span>
                        </div>
                        <div className="products-bulk-th-row products-bulk-th-row--chrome">
                          {showChromeRow ? (
                            <>
                              {showPinHide && !ALWAYS_VISIBLE_COL_KEYS.has(col.key) ? (
                                <button
                                  type="button"
                                  className="products-bulk-pin-btn products-bulk-hide-btn"
                                  title="Скрыть столбец"
                                  aria-label={`Скрыть столбец ${col.label || col.key}`}
                                  draggable={false}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    hideColumnFromHeader(col.key);
                                  }}
                                >
                                  <HideColumnIcon />
                                </button>
                              ) : null}
                              {showPinHide ? (
                                <button
                                  type="button"
                                  className={`products-bulk-pin-btn${
                                    pinnedColumnKeys.includes(col.key) ? ' is-pinned' : ''
                                  }`}
                                  title={
                                    pinnedColumnKeys.includes(col.key)
                                      ? 'Открепить столбец'
                                      : 'Закрепить столбец слева (после артикула)'
                                  }
                                  aria-label={
                                    pinnedColumnKeys.includes(col.key)
                                      ? 'Открепить столбец'
                                      : 'Закрепить столбец'
                                  }
                                  aria-pressed={pinnedColumnKeys.includes(col.key)}
                                  draggable={false}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    togglePinColumn(col.key);
                                  }}
                                >
                                  <PinIcon />
                                </button>
                              ) : null}
                              {canFill ? (
                                <button
                                  type="button"
                                  className="products-bulk-fill-btn"
                                  onClick={() => openBulk(col)}
                                  title={`Заполнить столбец «${col.label || col.key}»`}
                                  aria-label={`Заполнить столбец ${col.label || col.key}`}
                                  draggable={false}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                  <FillColumnIcon />
                                </button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                        <div className="products-bulk-th-row products-bulk-th-row--mp">
                          {showMpRow ? (
                            <>
                              {showLinkToggles ? (
                                <MpFieldLinkToggles
                                  fieldKey={col.linkFieldKey}
                                  links={headerLinksForField(col.linkFieldKey)}
                                  onToggle={toggleBulkHeaderFieldLink}
                                  supportedMps={col.linkSupportedMps || col.mappedMps}
                                  size={14}
                                />
                              ) : null}
                              {showFromMain ? (
                                <MpFromMainLinkIcon
                                  linked={fromMainLinked}
                                  title={
                                    fromMainLinked
                                      ? 'Значение берётся с вкладки «Основное»'
                                      : 'Связь с «Основным» выключена — своё значение на МП'
                                  }
                                />
                              ) : null}
                              {showCategoryLinkIcon ? (
                                <MpFromMainLinkIcon linked={false} title={MP_CATEGORY_LINK_ICON_TITLE} />
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </div>
                      <span
                        className="products-bulk-col-resizer"
                        title="Изменить ширину столбца"
                        onMouseDown={(e) =>
                          startColumnResize(e, col.key, colHeaderWidthPx(col, columnWidths))
                        }
                        onDragStart={(e) => e.preventDefault()}
                      />
                    </th>
                  );
                })}
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
                          {isNewBulkRowId(row.id) ? 'новый' : row.id}
                        </td>
                      );
                    }
                    if (col.key === '_photo') {
                      return (
                        <BulkPhotoCell
                          key={col.key}
                          product={row._productRef}
                          sku={row.sku}
                          rowId={row.id}
                          stickyClass={colStickyClass(col)}
                          stickyStyle={colStickyStyle(col)}
                          onOpen={() => openImagesModal(row)}
                        />
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
            Кнопка <strong>Сделать 3:4</strong> под каждым фото — привести изображение к формату 3:4;
            после этого можно <strong>Вернуть оригинал</strong>. Нажмите на фото, чтобы увеличить.
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
                const canRestore = canRestoreImageAspect3x4(img);
                return (
                  <div key={id || `img-${index}`} className="products-bulk-images-card">
                    <ProductImageAspectFrame img={img} className="products-bulk-images-card-media">
                      {url ? (
                        <button
                          type="button"
                          className="products-bulk-images-zoom"
                          title="Увеличить"
                          aria-label="Увеличить изображение"
                          onClick={() => openImageLightbox(imagesModal.images, index)}
                        >
                          <img src={url} alt="" />
                        </button>
                      ) : (
                        <span className="text-muted">∅</span>
                      )}
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
                    </ProductImageAspectFrame>
                    <button
                      type="button"
                      className={`products-bulk-images-aspect-btn${canRestore ? ' is-restore' : ''}`}
                      disabled={imagesModal.loading || aspectBusy || !id}
                      onClick={() =>
                        void (canRestore
                          ? handleBulkRestoreImageAspect3x4(id)
                          : handleBulkFitImageAspect3x4(id))
                      }
                    >
                      {aspectBusy
                        ? (canRestore ? 'Возврат оригинала…' : 'Приведение к 3:4…')
                        : (canRestore ? 'Вернуть оригинал' : 'Сделать 3:4')}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={!!(textPopup.open && textPopup.col && textPopupRow)}
        onClose={() => setTextPopup(EMPTY_TEXT_POPUP)}
        title={textPopupModalTitle}
        size="large"
      >
        {textPopup.col && textPopupRow ? (
          <div>
            <div className="products-bulk-text-popup-group">
              {textPopupGroup.map((c) => {
                const linkKey = popupLinkFieldKey(c, erpAttrColumnDefs);
                const isMain = isPopupMainColumn(c, linkKey);
                const stillLinked =
                  linkKey &&
                  !isMain &&
                  !textPopup.independent?.[c.key] &&
                  isBulkLinkedMpReadonly(
                    textPopupSyntheticRow || textPopupRow,
                    c.key,
                    erpAttrColumnDefs,
                    mpAttrColumnDefs
                  );
                const val = popupDisplayedDraft(
                  c,
                  textPopup,
                  textPopupRow,
                  erpAttrColumnDefs,
                  mpAttrColumnDefs
                );
                const limitInfo = bulkCellLimitInfo(
                  textPopupSyntheticRow || textPopupRow,
                  c,
                  limitsForRow(textPopupSyntheticRow || textPopupRow),
                  val
                );
                const isDesc =
                  linkKey === 'description' || String(c.key || '').includes('description');
                return (
                  <div key={c.key} className="products-bulk-text-popup-field">
                    <div className="products-bulk-text-popup-field-head">
                      <label htmlFor={`bulk-text-popup-${c.key}`}>{popupFieldTitle(c)}</label>
                      {stillLinked ? (
                        <span className="products-bulk-text-popup-field-linked">
                          связано с основным
                        </span>
                      ) : null}
                    </div>
                    <textarea
                      id={`bulk-text-popup-${c.key}`}
                      className={`form-control products-bulk-text-editor${
                        limitInfo?.over ? ' is-over-limit' : ''
                      }`}
                      value={val}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setTextPopup((prev) => {
                          const nextIndependent = { ...(prev.independent || {}) };
                          if (linkKey && !isMain) nextIndependent[c.key] = true;
                          const nextDrafts = { ...(prev.drafts || {}), [c.key]: nextVal };
                          return {
                            ...prev,
                            drafts: nextDrafts,
                            independent: nextIndependent,
                          };
                        });
                      }}
                      rows={isDesc || isEditableAttrType(c.erpAttr?.type) ? 8 : 4}
                      autoFocus={c.key === textPopup.col.key}
                    />
                    {limitInfo?.items?.length ? (
                      <MarketplaceFieldLimitHint items={limitInfo.items} />
                    ) : (
                      <div className="mp-field-limit-hint">{String(val || '').length}</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="d-flex justify-content-end gap-2 mt-3">
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => setTextPopup(EMPTY_TEXT_POPUP)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                variant="primary"
                size="small"
                onClick={() => {
                  const linkKey = textPopupLinkKey;
                  const drafts = textPopup.drafts || {};
                  const independent = textPopup.independent || {};
                  const pairs = [];
                  const mainCol =
                    textPopupGroup.find((c) => isPopupMainColumn(c, linkKey)) || textPopup.col;
                  const mainKey = mainCol?.key;
                  if (
                    mainKey &&
                    Object.prototype.hasOwnProperty.call(drafts, mainKey) &&
                    String(drafts[mainKey] ?? '') !== String(textPopupRow[mainKey] ?? '')
                  ) {
                    pairs.push([mainKey, drafts[mainKey]]);
                  }
                  for (const c of textPopupGroup) {
                    if (isPopupMainColumn(c, linkKey)) continue;
                    if (independent[c.key]) pairs.push([c.key, drafts[c.key] ?? '']);
                  }
                  if (!pairs.length) {
                    const key = textPopup.col.key;
                    const nextVal = drafts[key] ?? '';
                    if (String(nextVal) !== String(textPopupRow[key] ?? '')) {
                      pairs.push([key, nextVal]);
                    }
                  }
                  if (pairs.length) updateCells(textPopup.rowId, pairs);
                  setTextPopup(EMPTY_TEXT_POPUP);
                }}
              >
                Готово
              </Button>
            </div>
          </div>
        ) : null}
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
            {bulkModalCol.input === 'checkbox' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="true">Да</option>
                <option value="false">Нет</option>
              </select>
            ) : bulkModalCol.input === 'select_erp_dict' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="">— очистить / не задано</option>
                {(bulkModalCol.dictOptions || []).map((opt) => (
                  <option key={String(opt.id)} value={String(opt.id)}>
                    {opt.label || opt.id}
                  </option>
                ))}
              </select>
            ) : bulkModalCol.input === 'date' ? (
              <input
                className="form-control products-bulk-modal-field"
                type="date"
                value={bulkDraft}
                onChange={(e) => setBulkDraft(e.target.value)}
                autoFocus
              />
            ) : bulkModalCol.input === 'select_dict' ? (
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
            ) : bulkModalCol.input === 'select_bool' ? (
              <select className="form-control" value={bulkDraft} onChange={(e) => setBulkDraft(e.target.value)} autoFocus>
                <option value="">— очистить / не задано</option>
                <option value="true">Да</option>
                <option value="false">Нет</option>
              </select>
            ) : bulkModalCol.input === 'textarea' ? (
              <>
              <textarea
                className={`form-control products-bulk-modal-field${
                  isPopupTextColumn(bulkModalCol, erpAttrColumnDefs) &&
                  bulkCellLimitInfo(rows[0], bulkModalCol, limitsForRow(rows[0] || {}), bulkDraft)?.over
                    ? ' is-over-limit'
                    : ''
                }`}
                value={bulkDraft}
                onChange={(e) => setBulkDraft(e.target.value)}
                rows={isPopupTextColumn(bulkModalCol, erpAttrColumnDefs) ? 10 : 6}
                autoFocus
              />
              {isPopupTextColumn(bulkModalCol, erpAttrColumnDefs) ? (
                (() => {
                  const info = rows[0]
                    ? bulkCellLimitInfo(rows[0], bulkModalCol, limitsForRow(rows[0]), bulkDraft)
                    : { length: String(bulkDraft || '').length, items: [] };
                  return info.items?.length ? (
                    <MarketplaceFieldLimitHint items={info.items} />
                  ) : (
                    <div className="mp-field-limit-hint">{String(bulkDraft || '').length}</div>
                  );
                })()
              ) : null}
              </>
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

      {imageLightbox.urls.length > 0 ? (
        <ImageLightbox
          urls={imageLightbox.urls}
          index={imageLightbox.index}
          onIndexChange={(i) => setImageLightbox((prev) => ({ ...prev, index: i }))}
          onClose={() => setImageLightbox({ urls: [], index: 0 })}
        />
      ) : null}

      </div>
      ) : null}
    </div>
  );
}
