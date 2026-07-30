/**
 * ProductForm Component
 * Форма создания/редактирования товара
 */

import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import { Button } from '../../common/Button/Button';
import { Modal } from '../../common/Modal/Modal';
import { productAttributesApi } from '../../../services/productAttributes.api';
import { integrationsApi } from '../../../services/integrations.api';
import { productsApi } from '../../../services/products.api';
import { getApiSessionContext } from '../../../services/apiSession.js';
import { userCategoriesApi } from '../../../services/userCategories.api';
import { MP_LINK_MAX } from '../../../constants/marketplaceLinks.js';
import { sanitizeWbVendorCode } from '../../../utils/wbVendorCode.js';
import { ProductMarketplaceLinkSection } from './ProductMarketplaceLinkSection.jsx';
import { ProductCompetitorsTab } from './ProductCompetitorsTab.jsx';
import {
  canUsePrintHelper,
  openProductLabelPrintTab,
  useProductLabelPrint,
} from '../../../hooks/useProductLabelPrint.js';
import { resolveApiBaseUrl } from '../../../services/api.js';
import { createAsyncQueue } from '../../../utils/asyncQueue.js';
import { COUNTRY_OPTIONS } from '../../../constants/countryOptions.js';
import { certificatesApi } from '../../../services/certificates.api.js';
import { brandsApi } from '../../../services/brands.api.js';
import {
  applyCertAutofillToAttributes,
  certSourceHasAnyDocument,
  filterBrandCertsForCategory,
} from '../../../utils/productCertAttributeAutofill.js';
import {
  BARCODE_MP_TOGGLES,
  EMPTY_BARCODE_ROW,
  barcodesForForm,
  barcodesFromWbSizes,
  coerceBarcodeString,
  isCorruptBarcodeString,
  normalizeBarcodeRows,
} from '../../../utils/productBarcodes.js';
import { MarketplaceToggle } from '../../common/MarketplaceToggle/MarketplaceToggle.jsx';
import { MpFieldLabel, MpFieldLinkToggles, MpValueDiffBadges } from '../../common/MpFieldLinkToggles/MpFieldLinkToggles.jsx';
import { useAuth } from '../../../context/AuthContext.jsx';
import { isProfileKitsEnabled, isProfileProductSupplierBindingEnabled } from '../../../utils/profileFlags.js';
import { useSuppliers } from '../../../hooks/useSuppliers';
import {
  buildMpBaseline,
  formatDirtyMpList,
  getDirtyMarketplaces,
  isMpAttrDirty,
  isMpFieldDirty,
  MP_LABELS,
} from '../../../utils/productMpDirty.js';
import {
  buildMpAttrDisplayByName,
  getMainAttrMpDiffs,
  getMainCardFieldMpDiffs,
} from '../../../utils/productAttrMpDiff.js';
import {
  applyLinkedMpFieldsFromMain,
  convertDimensionsForMarketplace,
  cmToMm,
  createMpFieldLinks,
  erpDimsToYmWeightDimensions,
  filterYmCategoryAttributesForForm,
  getMpDraftCountry,
  getMpDraftDimensionsMm,
  getYmDraftCountry,
  getYmDraftWeightDimensions,
  isMpFieldLinked,
  isYmParamDuplicatingDedicatedField,
  kgToGrams,
  mmToCm,
  normalizeMpFieldLinks,
  toggleMpFieldLink,
  withMpDraftPatch,
  withYmDraftCountry,
  ymWeightDimensionsToErp,
} from '../../../utils/productMpFieldLinks.js';
import {
  WB_ITEM_DIM_CHARC,
  WB_PACK_DIM_CHARC,
  classifyMarketplaceDimAttrName,
  formatVolumeLitersLabel,
  isCoveredByDedicatedProductDimFields,
  isWbDedicatedDimCharcId,
} from '../../../utils/marketplaceDimensions.js';
import './ProductForm.css';

const TYPE_LABELS = { text: 'Текст', checkbox: 'Флажок', number: 'Число', date: 'Дата', dictionary: 'Словарь' };

/** Readonly «Объём» рядом с габаритами (мм или см). */
function DimVolumeReadonly({ length, width, height, unit = 'mm', id }) {
  const label = formatVolumeLitersLabel(length, width, height, unit);
  return (
    <div className="col-6 col-md-3">
      <label className="form-label" htmlFor={id}>
        Объём
      </label>
      <div
        id={id}
        role="status"
        aria-live="polite"
        className="form-control form-control-sm"
        style={{
          display: 'flex',
          alignItems: 'center',
          background: 'rgba(0,0,0,0.03)',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: label ? 'var(--text)' : 'var(--muted)',
        }}
      >
        {label || '—'}
      </div>
    </div>
  );
}

/** Порядок в массиве = порядок на карточке; первый элемент — главное фото. */
function normalizeProductImagesOrder(images) {
  const arr = Array.isArray(images) ? [...images] : [];
  if (arr.length === 0) return [];
  const primIdx = arr.findIndex((i) => i?.primary === true);
  let ordered;
  if (primIdx > 0) {
    const p = arr[primIdx];
    ordered = [...arr.slice(0, primIdx), ...arr.slice(primIdx + 1)];
    ordered.unshift(p);
  } else {
    ordered = [...arr];
  }
  return ordered.map((img, i) => ({ ...img, primary: i === 0 }));
}

function reorderImagesByIndex(images, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return images;
  const next = [...images];
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  return next.map((img, i) => ({ ...img, primary: i === 0 }));
}

/** Ответ { data: Image[] } от upload/delete/getImages или уже массив */
function extractImagesFromApiPayload(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function filterDroppedImageFiles(fileList) {
  return Array.from(fileList || []).filter((f) => typeof f.type === 'string' && f.type.startsWith('image/'));
}

function dataTransferHasFiles(dt) {
  if (!dt?.types) return false;
  try {
    return dt.types.contains ? dt.types.contains('Files') : Array.from(dt.types).includes('Files');
  } catch {
    return false;
  }
}

/** Переключатель маркетплейса на превью (иконка поверх фото). */
function ProductImageMpToggle({ active, title, color, textColor = '#fff', children, onToggle }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={title}
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      style={{
        width: 22,
        height: 22,
        borderRadius: '6px',
        border: active ? '1px solid rgba(255,255,255,0.9)' : '1px solid rgba(255,255,255,0.25)',
        cursor: 'pointer',
        fontSize: '7px',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        color: textColor,
        background: active ? color : 'rgba(40,40,40,0.75)',
        opacity: active ? 1 : 0.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

/** Сопоставление с логикой импорта Ozon: нормализация подписи словаря */
function normOzonAttrLabel(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function ozonDictEntryText(o) {
  if (!o || typeof o !== 'object') return '';
  const raw = o.value ?? o.info ?? o.title ?? o.name ?? o.label ?? '';
  return String(raw).trim();
}

/** Сохранённое в БД значение: id или текст из таблицы/Excel → элемент справочника Ozon */
function findOzonDictEntryForStored(stored, options) {
  if (stored === undefined || stored === null) return null;
  const str = String(stored).trim();
  if (!str) return null;
  if (!Array.isArray(options) || options.length === 0) return null;
  const byId = options.find((o) => o && String(o.id) === str);
  if (byId) return byId;
  const n = normOzonAttrLabel(str);
  const byExact = options.find((o) => normOzonAttrLabel(ozonDictEntryText(o)) === n);
  if (byExact) return byExact;
  let best = null;
  let bestLen = 0;
  for (const o of options) {
    const t = normOzonAttrLabel(ozonDictEntryText(o));
    if (!t || !n) continue;
    if (t.includes(n) || n.includes(t)) {
      if (!best || t.length > bestLen) {
        best = o;
        bestLen = t.length;
      }
    }
  }
  return best;
}

function normalizeAttrName(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function isEmptyMarketplaceValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => isEmptyMarketplaceValue(x));
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** Значение характеристики WB для хранения в wb_attributes (строка/число/boolean). */
function normalizeWbAttributeScalar(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (Array.isArray(v)) {
    const s = v.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join('; ');
    return s;
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  }
  return String(v);
}

function mergeWbCharacteristicsIntoValues(characteristics, prev = {}) {
  const next = { ...prev };
  if (!Array.isArray(characteristics)) return next;
  for (const c of characteristics) {
    const id = c?.id ?? c?.characteristic_id ?? c?.charcID;
    const key = id != null ? String(id) : String(c?.name ?? c?.characteristic_name ?? '').trim();
    if (!key) continue;
    if (!isEmptyMarketplaceValue(next[key])) continue;
    const raw = c?.value;
    const normalized = normalizeWbAttributeScalar(raw);
    if (isEmptyMarketplaceValue(normalized)) continue;
    next[key] = normalized;
  }
  return next;
}

function resolveWbSubjectIdFromMappings(mm) {
  if (!mm || typeof mm !== 'object') return 0;
  const raw = mm.wb ?? mm.wb_subject_id ?? mm.wbSubjectId ?? null;
  const n = raw != null ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function vatCodeToText(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  if (c === 'NO_VAT') return 'Без НДС';
  if (c === 'VAT_22') return '22';
  if (c === 'VAT_20') return '20';
  if (c === 'VAT_10') return '10';
  if (c === 'VAT_7') return '7';
  if (c === 'VAT_5') return '5';
  return '';
}

/** Как у useProducts: ответ GET /products { ok, data: Product[] }. */
function normalizeProductsFromListPayload(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw?.data)) return raw.data.filter(Boolean);
  if (Array.isArray(raw?.data?.data)) return raw.data.data.filter(Boolean);
  if (Array.isArray(raw?.items)) return raw.items.filter(Boolean);
  return [];
}

const KIT_SUGGEST_DEBOUNCE_MS = 280;
const KIT_SUGGEST_LIMIT = 40;

/** Подпись товара в строке комплектующих */
function formatKitProductLabel(p) {
  if (!p || p.id == null) return '';
  const sku = String(p.sku || '').trim();
  const name = String(p.name || '').trim();
  if (sku && name) return `${sku} — ${name}`;
  return sku || name || `Товар #${p.id}`;
}

/** Подпись из блока комплектующих в карточке товара (GET /products/:id до догрузки полных карточек) */
function labelFromKitApiHint(part) {
  if (!part) return '';
  const sku = String(part.component_sku || part.product_sku || '').trim();
  const name = String(part.product_name || part.component_name || '').trim();
  if (sku && name) return `${sku} — ${name}`;
  return sku || name || '';
}

/** Организация для запросов к МП: карточка → товар в БД → фильтр списка → сессия */
function resolveKitPickerOrganizationId(formOrgId, productsListOrganizationId, productOrgId) {
  const fromF =
    formOrgId != null && formOrgId !== '' && String(formOrgId).trim() !== ''
      ? String(formOrgId).trim()
      : '';
  const fromProduct =
    productOrgId != null && String(productOrgId).trim() !== ''
      ? String(productOrgId).trim()
      : '';
  const fromList =
    productsListOrganizationId != null && String(productsListOrganizationId).trim() !== ''
      ? String(productsListOrganizationId).trim()
      : '';
  const { organizationId: sessOrg } = getApiSessionContext();
  const fromSession = sessOrg != null && String(sessOrg).trim() !== '' ? String(sessOrg).trim() : '';
  return fromF || fromProduct || fromList || fromSession || undefined;
}

/** Себестоимость > 0 для расчёта % наценки; иначе null. */
function parsePositiveCost(cost) {
  const n = parseFloat(cost);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ₽ → % от себестоимости (2 знака). Пусто, если cost неизвестен. */
function minMarkupRubToPercent(rub, cost) {
  const c = parsePositiveCost(cost);
  if (c == null) return '';
  const r = parseFloat(rub);
  if (!Number.isFinite(r)) return '';
  return String(Math.round((r / c) * 10000) / 100);
}

/** % от себестоимости → ₽ (2 знака). Пусто, если cost неизвестен. */
function minMarkupPercentToRub(percent, cost) {
  const c = parsePositiveCost(cost);
  if (c == null) return '';
  const p = parseFloat(percent);
  if (!Number.isFinite(p)) return '';
  return String(Math.round(c * (p / 100) * 100) / 100);
}

const EMPTY_PRODUCT_FORM_DATA = {
    name: '',
    sku: '',
    product_type: 'product',
    categoryId: '',
    organizationId: '',
    supplierId: '',
    brand: '',
  country_of_origin: '',
    cost: '',
  additionalExpenses: '',
    minPrice: '',
    /** UI-only: % от себестоимости; в БД канонично хранится min_price (₽). */
    minMarkupPercent: '',
    minProfitOzon: '',
    minProfitWb: '',
    minProfitYm: '',
    description: '',
    sku_ozon: '',
    /** Редактируемое поле числового product_id Ozon (сохраняется как marketplace_ozon_product_id) */
    ozon_product_id: '',
    sku_wb: '',
    sku_ym: '',
    ym_market_sku: '',
    buyout_rate: 95,
    barcodes: [{ ...EMPTY_BARCODE_ROW }],
    weight: '',
    length: '',
    width: '',
    height: '',
    product_weight: '',
    product_length: '',
    product_width: '',
    product_height: '',
    volume: '',
    kit_components: [],
  attributeValues: {},
  mp_wb_vendor_code: '',
  mp_wb_name: '',
  mp_wb_description: '',
  mp_wb_brand: '',
  mp_ym_name: '',
  mp_ym_description: '',
  mp_ozon_name: '',
  mp_ozon_description: '',
  mp_ozon_brand: '',
  mp_field_links: createMpFieldLinks(),
  ozon_draft: {},
  wb_draft: {},
  ym_draft: {},
};

/** Полный JSON ответа МП после «Обновить с …» — чтобы видеть, какие поля реально пришли. */
function MpApiResponseDump({ data, open, onToggle, label = 'Сырой ответ API' }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  let json = '';
  try {
    json = JSON.stringify(data, null, 2);
  } catch {
    json = String(data);
  }
  const topKeys = Object.keys(data);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="mp-api-response-dump" style={{ marginTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-link p-0"
          style={{ fontSize: 12 }}
          onClick={onToggle}
        >
          {open ? `Свернуть ${label}` : `Показать ${label}`}
        </button>
        {open ? (
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={copy}>
            {copied ? 'Скопировано' : 'Копировать JSON'}
          </button>
        ) : null}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        Ключи верхнего уровня ({topKeys.length}): {topKeys.join(', ') || '—'}
      </div>
      {open ? (
        <pre
          style={{
            marginTop: 8,
            maxHeight: 420,
            overflow: 'auto',
            fontSize: 11,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            background: 'rgba(0,0,0,0.04)',
            borderRadius: 6,
            padding: 10,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {json}
        </pre>
      ) : null}
    </div>
  );
}

/** Поля габаритов/веса YM (см/кг). При связи — из ERP; без связи — только ym_draft. */
function YmPackagingDimensionFields({ formData, onChange, idPrefix = 'ym-dim' }) {
  const linked = isMpFieldLinked(formData?.mp_field_links, 'dimensions', 'ym');
  const draftWd = getYmDraftWeightDimensions(formData) || {};
  const dimFields = [
    { key: 'length', label: 'Длина упаковки', unit: 'см', step: '0.1', placeholder: '26' },
    { key: 'width', label: 'Ширина упаковки', unit: 'см', step: '0.1', placeholder: '16.5' },
    { key: 'height', label: 'Высота упаковки', unit: 'см', step: '0.1', placeholder: '6.7' },
  ];

  const displayCm = (key) => {
    if (linked) {
      const mm = Number(formData?.[key]);
      return Number.isFinite(mm) && mm > 0 ? String(Math.round(mm) / 10) : '';
    }
    const cm = Number(draftWd[key]);
    return Number.isFinite(cm) && cm > 0 ? String(cm) : '';
  };
  const displayWeightKg = () => {
    if (linked) {
      const g = Number(formData?.weight);
      return Number.isFinite(g) && g > 0 ? String(Math.round(g) / 1000) : '';
    }
    const kg = Number(draftWd.weight);
    return Number.isFinite(kg) && kg > 0 ? String(kg) : '';
  };

  return (
    <div className="row g-3" data-testid="ym-packaging-dims">
      {dimFields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        return (
          <div className="col-12 col-md-6 col-lg-4" key={f.key}>
            <label className="form-label" htmlFor={id}>
              {f.label}
              <span style={{ fontSize: '10px', color: 'var(--muted)', marginLeft: 4 }}>({f.unit})</span>
            </label>
            <input
              id={id}
              type="number"
              className="form-control form-control-sm"
              step={f.step}
              min="0"
              placeholder={f.placeholder}
              value={displayCm(f.key)}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          </div>
        );
      })}
      <div className="col-12 col-md-6 col-lg-4">
        <label className="form-label" htmlFor={`${idPrefix}-weight`}>
          Вес с упаковкой
          <span style={{ fontSize: '10px', color: 'var(--muted)', marginLeft: 4 }}>(кг)</span>
        </label>
        <input
          id={`${idPrefix}-weight`}
          type="number"
          className="form-control form-control-sm"
          step="0.001"
          min="0"
          placeholder="1.289"
          value={displayWeightKg()}
          onChange={(e) => onChange('weight', e.target.value)}
        />
      </div>
      <DimVolumeReadonly
        id={`${idPrefix}-volume`}
        unit="cm"
        length={displayCm('length')}
        width={displayCm('width')}
        height={displayCm('height')}
      />
    </div>
  );
}

/**
 * value — см (длина/ширина/высота) или кг (вес), как в инпутах YM.
 * Связь dimensions↔ym: пишет ERP мм/г + зеркало в ym_draft.
 * Без связи: только ym_draft.weightDimensions.
 */
function applyYmPackagingDimChange(prev, key, value) {
  const linked = isMpFieldLinked(prev.mp_field_links, 'dimensions', 'ym');
  const prevDraft =
    prev.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
      ? prev.ym_draft
      : {};
  const prevWd =
    prevDraft.weightDimensions && typeof prevDraft.weightDimensions === 'object'
      ? { ...prevDraft.weightDimensions }
      : linked
        ? erpDimsToYmWeightDimensions(prev) || {}
        : {};

  const nextWd = { ...prevWd };
  if (value === '' || value == null) {
    delete nextWd[key];
  } else {
    const n = Number(String(value).replace(',', '.'));
    if (Number.isFinite(n) && n > 0) nextWd[key] = n;
    else delete nextWd[key];
  }

  const next = {
    ...prev,
    ym_draft: {
      ...prevDraft,
      weightDimensions: nextWd,
    },
  };

  if (linked) {
    if (key === 'weight') {
      next.weight = value === '' || value == null ? '' : (kgToGrams(value) != null ? String(kgToGrams(value)) : '');
    } else {
      next[key] = value === '' || value == null ? '' : (cmToMm(value) != null ? String(cmToMm(value)) : '');
    }
  }
  return next;
}

/**
 * Артикул / страна / габариты на вкладке Ozon|WB — всегда редактируемые.
 * Связь с «Основным» — двусторонний синхрон; без связи — ozon_draft / wb_draft.
 */
function MpSkuCountryDimsEditor({
  mp,
  formData,
  onSkuChange,
  onCountryChange,
  onDimChange,
  onProductDimChange = null,
  itemAttrValues = null,
  onItemAttrChange = null,
  itemAttrLabels = null,
  productAttrFields = null,
}) {
  const code = String(mp || '').toLowerCase();
  const linkedSku = isMpFieldLinked(formData.mp_field_links, 'sku', code);
  const linkedCountry = isMpFieldLinked(formData.mp_field_links, 'country', code);
  const linkedDims = isMpFieldLinked(formData.mp_field_links, 'dimensions', code);
  const skuValue = linkedSku
    ? formData.sku || ''
    : code === 'ozon'
      ? formData.sku_ozon || ''
      : code === 'wb'
        ? formData.mp_wb_vendor_code || ''
        : '';
  const countryValue = linkedCountry
    ? formData.country_of_origin || ''
    : getMpDraftCountry(formData, code);
  const dimsMm = linkedDims
    ? {
        length: formData.length,
        width: formData.width,
        height: formData.height,
        weight: formData.weight,
      }
    : getMpDraftDimensionsMm(formData, code) || {};
  const d = convertDimensionsForMarketplace(code, dimsMm);
  const dimDisp = (key) => (d[key] != null ? String(d[key]) : '');
  const skuLabel = code === 'wb' ? 'vendorCode (WB)' : 'Артикул (Ozon)';
  const packDimFields = [
    { key: 'length', label: `Длина упаковки (${d.lengthUnit})` },
    { key: 'width', label: `Ширина упаковки (${d.lengthUnit})` },
    { key: 'height', label: `Высота упаковки (${d.lengthUnit})` },
    {
      key: 'weight',
      label: `Вес с упаковкой (${d.weightUnit})`,
    },
  ];
  const showWbItemAttrs = code === 'wb' && typeof onItemAttrChange === 'function';
  const itemFields = [
    { key: WB_ITEM_DIM_CHARC.length, fallback: 'Длина товара' },
    { key: WB_ITEM_DIM_CHARC.width, fallback: 'Ширина товара' },
    { key: WB_ITEM_DIM_CHARC.height, fallback: 'Высота товара' },
  ];
  const mainProductFields = [
    { key: 'product_length', label: 'Длина товара (мм)' },
    { key: 'product_width', label: 'Ширина товара (мм)' },
    { key: 'product_height', label: 'Высота товара (мм)' },
    { key: 'product_weight', label: 'Вес товара (г)' },
  ];
  const showMainProductDims = code === 'ozon' && typeof onProductDimChange === 'function';
  const ozonYmProductFields = Array.isArray(productAttrFields) ? productAttrFields : [];

  return (
    <div data-testid={`mp-meta-dims-${code}`}>
      <div className="row g-3">
      <div className="col-md-4">
        <label className="form-label" htmlFor={`${code}-tab-sku`}>
          {skuLabel}
          {linkedSku ? <span className="mp-field-linked-hint"> · синхрон с Основным</span> : null}
        </label>
        <input
          id={`${code}-tab-sku`}
          type="text"
          className="form-control form-control-sm"
          value={skuValue}
          onChange={(e) => onSkuChange(e.target.value)}
        />
      </div>
      <div className="col-md-4">
        <label className="form-label" htmlFor={`${code}-tab-country`}>
          Страна
          {linkedCountry ? (
            <span className="mp-field-linked-hint"> · синхрон с Основным</span>
          ) : (
            <span className="mp-field-linked-hint"> · только {code === 'wb' ? 'WB' : 'Ozon'}</span>
          )}
        </label>
        <input
          id={`${code}-tab-country`}
          type="text"
          className="form-control form-control-sm"
          value={countryValue}
          onChange={(e) => onCountryChange(e.target.value)}
          list={`${code}-country-list`}
          placeholder="Например, Китай"
        />
        <datalist id={`${code}-country-list`}>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div className="col-12">
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Габариты товара</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
          {code === 'wb'
            ? 'Характеристики предмета WB (см), без упаковки.'
            : 'Размеры и вес самого товара (без упаковки), как на вкладке «Основное».'}
        </div>
        {showWbItemAttrs ? (
          <div className="row g-2">
            {itemFields.map((f) => {
              const label = (itemAttrLabels && itemAttrLabels[f.key]) || `${f.fallback} (см)`;
              const val = itemAttrValues?.[f.key] ?? '';
              return (
                <div className="col-6 col-md-3" key={f.key}>
                  <label className="form-label" htmlFor={`wb-item-attr-${f.key}`}>
                    {label}
                  </label>
                  <input
                    id={`wb-item-attr-${f.key}`}
                    type="number"
                    className="form-control form-control-sm"
                    min="0"
                    step="0.1"
                    value={val}
                    onChange={(e) => onItemAttrChange(f.key, e.target.value)}
                  />
                </div>
              );
            })}
            <DimVolumeReadonly
              id={`${code}-product-volume`}
              unit="cm"
              length={itemAttrValues?.[WB_ITEM_DIM_CHARC.length]}
              width={itemAttrValues?.[WB_ITEM_DIM_CHARC.width]}
              height={itemAttrValues?.[WB_ITEM_DIM_CHARC.height]}
            />
          </div>
        ) : showMainProductDims ? (
          <div className="row g-2">
            {mainProductFields.map((f) => (
              <div className="col-6 col-md-3" key={f.key}>
                <label className="form-label" htmlFor={`${code}-${f.key}`}>
                  {f.label}
                </label>
                <input
                  id={`${code}-${f.key}`}
                  type="number"
                  className="form-control form-control-sm"
                  min="0"
                  step="1"
                  value={formData[f.key] ?? ''}
                  onChange={(e) => onProductDimChange(f.key, e.target.value)}
                />
              </div>
            ))}
            <DimVolumeReadonly
              id={`${code}-product-volume`}
              unit="mm"
              length={formData.product_length}
              width={formData.product_width}
              height={formData.product_height}
            />
            {ozonYmProductFields.length > 0 ? (
              <div className="col-12" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                Дополнительно из атрибутов категории Ozon:
              </div>
            ) : null}
            {ozonYmProductFields.map((f) => (
              <div className="col-6 col-md-3" key={`attr-${f.key}`}>
                <label className="form-label" htmlFor={`${code}-product-attr-${f.key}`}>
                  {f.label}
                </label>
                <input
                  id={`${code}-product-attr-${f.key}`}
                  type="text"
                  className="form-control form-control-sm"
                  value={f.value}
                  onChange={(e) => f.onChange(e.target.value)}
                />
              </div>
            ))}
          </div>
        ) : ozonYmProductFields.length > 0 ? (
          <div className="row g-2">
            {ozonYmProductFields.map((f) => (
              <div className="col-6 col-md-3" key={f.key}>
                <label className="form-label" htmlFor={`${code}-product-attr-${f.key}`}>
                  {f.label}
                </label>
                <input
                  id={`${code}-product-attr-${f.key}`}
                  type="text"
                  className="form-control form-control-sm"
                  value={f.value}
                  onChange={(e) => f.onChange(e.target.value)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Заполните габариты товара на вкладке «Основное».
          </div>
        )}
      </div>

      <div className="col-12">
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          Габариты упаковки
          {linkedDims ? (
            <span className="mp-field-linked-hint"> · синхрон с Основным</span>
          ) : (
            <span className="mp-field-linked-hint"> · только {code === 'wb' ? 'WB' : 'Ozon'}</span>
          )}
        </div>
        {code === 'wb' ? (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            Как в кабинете WB (см / кг). Если габариты упаковки меньше фактических — возможен штраф.
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
            Габариты для логистики Ozon (мм / г).
          </div>
        )}
        <div className="row g-2">
          {packDimFields.map((f) => (
            <div className="col-6 col-md-3" key={f.key}>
              <label className="form-label" htmlFor={`${code}-dim-${f.key}`}>
                {f.label}
              </label>
              <input
                id={`${code}-dim-${f.key}`}
                type="number"
                className="form-control form-control-sm"
                min="0"
                step={code === 'wb' ? (f.key === 'weight' ? '0.001' : '0.1') : '1'}
                value={dimDisp(f.key)}
                onChange={(e) => onDimChange(f.key, e.target.value)}
              />
            </div>
          ))}
          <DimVolumeReadonly
            id={`${code}-pack-volume`}
            unit={code === 'wb' ? 'cm' : 'mm'}
            length={dimDisp('length')}
            width={dimDisp('width')}
            height={dimDisp('height')}
          />
        </div>
      </div>
      </div>
    </div>
  );
}

export const ProductForm = React.forwardRef(function ProductForm({
  product,
  categories = [],
  brands = [],
  organizations = [],
  products = [],
  /** Фильтр организации со страницы списка — если в карточке не выбрана, подставляем для поиска комплектующих */
  productsListOrganizationId = '',
  initialTab = 'main',
  onSubmit,
  onCancel: _onCancel,
  onProductUpdate,
  onDeleteProduct,
  onArchiveProduct,
  canDeleteProduct = false,
  canArchiveProduct = false,
}, ref) {
  const { profile } = useAuth();
  const kitsEnabled = isProfileKitsEnabled(profile);
  const supplierBindingEnabled = isProfileProductSupplierBindingEnabled(profile);
  const { suppliers } = useSuppliers();
  const productFormDomId = useId();
  const mpBaselineRef = useRef(null);
  /** Последнее поле мин. наценки, которое правил пользователь: 'rub' | 'percent'. */
  const minMarkupLastEditedRef = useRef('rub');
  const [printHelperUrl, setPrintHelperUrl] = useState('');
  const { printProductLabel, printing: labelPrinting, error: labelPrintError } =
    useProductLabelPrint(printHelperUrl);

  useEffect(() => {
    let cancelled = false;
    fetch(`${resolveApiBaseUrl().replace(/\/$/, '')}/config`)
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setPrintHelperUrl((body?.data?.printHelperUrl ?? '').trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Локальное состояние для хранения актуальных данных товара
  const [currentProduct, setCurrentProduct] = useState(product);
  const [participationFlags, setParticipationFlags] = useState({
    canDelete: canDeleteProduct,
    canArchive: canArchiveProduct,
    reasons: product?.participationReasons || [],
  });

  const [formData, setFormData] = useState(() => ({ ...EMPTY_PRODUCT_FORM_DATA }));
  
  const [errors, setErrors] = useState({});
  const [calculatedVolume, setCalculatedVolume] = useState('');
  const [allAttributes, setAllAttributes] = useState([]);
  const [ozonAttributes, setOzonAttributes] = useState([]);
  const [ozonAttributesLoading, setOzonAttributesLoading] = useState(false);
  const [ozonAttributeValues, setOzonAttributeValues] = useState({});
  const [ozonDictValues, setOzonDictValues] = useState({});
  const [ozonAttributesError, setOzonAttributesError] = useState('');
  /** Пара desc/type после ответа GET marketplace-attributes (бэкенд разрешает один id по дереву Ozon) */
  const [ozonResolvedPair, setOzonResolvedPair] = useState({ descId: null, typeId: 0 });
  const [activeTab, setActiveTab] = useState(() => {
    const t = String(initialTab || 'main').trim();
    return ['main', 'ozon', 'wb', 'ym', 'competitors'].includes(t) ? t : 'main';
  });
  const [kitModalOpen, setKitModalOpen] = useState(false);
  /** По одной строке UI на каждое комплектующее: текст поиска, подсказки */
  const [kitRowsUi, setKitRowsUi] = useState([]);
  /** Карточки по id для подписей, если строки списка товаров не содержат товар */
  const [kitPickerExtras, setKitPickerExtras] = useState([]);
  const [kitPickerError, setKitPickerError] = useState('');
  const kitModalWasOpenRef = useRef(false);
  const kitSuggestTimersRef = useRef({});
  const kitSuggestGenByRowRef = useRef({});
  /** Актуальные параметры без лишних пересозданий колбэков */
  const kitSearchDepsRef = useRef({});
  kitSearchDepsRef.current = {
    formOrganizationId: formData.organizationId,
    productsListOrganizationId,
    excludeProductId: currentProduct?.id,
  };
  const [ozonSyncLoading, setOzonSyncLoading] = useState(false);
  const [ozonSyncError, setOzonSyncError] = useState('');
  const [ozonSyncSuccess, setOzonSyncSuccess] = useState('');
  const [syncedOzonProductId, setSyncedOzonProductId] = useState(null);
  /** Полные данные товара с Ozon после «Обновить данные с Ozon» (отображаются во вкладке Ozon) */
  const [ozonFetchedProduct, setOzonFetchedProduct] = useState(null);
  /** Раскрыт ли блок «Все поля» с Ozon */
  const [ozonShowAllFields, setOzonShowAllFields] = useState(false);
  // Wildberries: загрузка карточки товара
  const [wbSyncLoading, setWbSyncLoading] = useState(false);
  const [wbSyncError, setWbSyncError] = useState('');
  const [wbSyncSuccess, setWbSyncSuccess] = useState('');
  /** Полные данные товара с WB после «Обновить данные с WB» (отображаются во вкладке WB) */
  const [wbFetchedProduct, setWbFetchedProduct] = useState(null);
  /** Раскрыт ли блок «Все поля» с WB */
  const [wbShowAllFields, setWbShowAllFields] = useState(false);
  /** Значения характеристик WB (id -> value) для редактирования, аналогично ozon_attributes */
  const [wbAttributeValues, setWbAttributeValues] = useState({});
  /** Список характеристик категории WB (схема), кэшируется на backend */
  const [wbCategoryAttributes, setWbCategoryAttributes] = useState([]);
  const [wbCategoryAttributesLoading, setWbCategoryAttributesLoading] = useState(false);
  const [wbCategoryAttributesError, setWbCategoryAttributesError] = useState('');
  /** Характеристики категории Яндекс.Маркета + значения для ym_attributes */
  const [ymCategoryAttributes, setYmCategoryAttributes] = useState([]);
  const [ymCategoryAttributesLoading, setYmCategoryAttributesLoading] = useState(false);
  const [ymCategoryAttributesError, setYmCategoryAttributesError] = useState('');
  const [ymAttributeValues, setYmAttributeValues] = useState({});
  const [ymSyncLoading, setYmSyncLoading] = useState(false);
  const [ymSyncError, setYmSyncError] = useState('');
  const [ymSyncSuccess, setYmSyncSuccess] = useState('');
  /** Данные с Яндекс.Маркета после «Обновить данные с YM» */
  const [ymFetchedProduct, setYmFetchedProduct] = useState(null);
  /** Раскрыт ли сырой ответ API YM */
  const [ymShowAllFields, setYmShowAllFields] = useState(false);
  // Images (ERP storage + targeting marketplaces)
  const [productImages, setProductImages] = useState([]);
  const [imageUploadLoading, setImageUploadLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageDropActive, setImageDropActive] = useState(false);
  const imageFileInputRef = useRef(null);
  const [brandCategoryCerts, setBrandCategoryCerts] = useState([]);
  /** Для каких товаров уже подставили вес/габариты из карточки */
  const ozonFilledFromProductIdRef = useRef(null);
  /** ID товара, для которого уже синхронизировали атрибуты из ozonFetchedProduct в форму */
  const ozonSyncedFromFetchedRef = useRef(null);

  // Синхронизация с пропом product: смена карточки или режим «Создать» (product === null)
  useEffect(() => {
    if (product) {
      console.log('[ProductForm] Product prop changed:', {
        product_id: product.id,
        buyout_rate: product.buyout_rate,
        buyout_rate_type: typeof product.buyout_rate,
        full_product: product
      });
      setCurrentProduct(product);
      setOzonFetchedProduct(null);
      setOzonShowAllFields(false);
      setOzonResolvedPair({ descId: null, typeId: 0 });
      setWbFetchedProduct(null);
      setWbShowAllFields(false);
      setWbAttributeValues({});
      setYmFetchedProduct(null);
      setYmShowAllFields(false);
      setYmAttributeValues({});
      setProductImages([]);
      setImageError('');
      ozonFilledFromProductIdRef.current = null;
      ozonSyncedFromFetchedRef.current = null;
      minMarkupLastEditedRef.current = 'rub';
    } else {
      setCurrentProduct(null);
      setFormData({ ...EMPTY_PRODUCT_FORM_DATA });
      setOzonAttributeValues({});
      setWbAttributeValues({});
      setYmAttributeValues({});
      setOzonFetchedProduct(null);
      setOzonShowAllFields(false);
      setWbFetchedProduct(null);
      setWbShowAllFields(false);
      setProductImages([]);
      setImageError('');
      setSyncedOzonProductId(null);
      setOzonSyncError('');
      setOzonSyncSuccess('');
      setWbSyncError('');
      setWbSyncSuccess('');
      setYmSyncError('');
      setYmSyncSuccess('');
      setYmFetchedProduct(null);
      setYmShowAllFields(false);
      setCalculatedVolume('');
      setErrors({});
      const t = String(initialTab || 'main').trim();
      setActiveTab(['main', 'ozon', 'wb', 'ym', 'competitors'].includes(t) ? t : 'main');
      ozonFilledFromProductIdRef.current = null;
      ozonSyncedFromFetchedRef.current = null;
      minMarkupLastEditedRef.current = 'rub';
    }
  }, [product]);

  useEffect(() => {
    const pid = product?.id;
    if (!pid) {
      setParticipationFlags({ canDelete: false, canArchive: false, reasons: [] });
      return;
    }
    setParticipationFlags({
      canDelete: canDeleteProduct,
      canArchive: canArchiveProduct,
      reasons: product?.participationReasons || [],
    });
    let cancelled = false;
    (async () => {
      try {
        const res = await productsApi.getParticipation(pid);
        const data = res?.data ?? res;
        if (cancelled || !data) return;
        const reasons = data.reasons || [];
        setParticipationFlags({
          canDelete: data.canDelete === true,
          canArchive: Boolean(data.hasParticipation) && !Boolean(data.isArchived),
          reasons,
        });
        setCurrentProduct((prev) =>
          prev && String(prev.id) === String(pid)
            ? {
                ...prev,
                canDelete: data.canDelete === true,
                hasParticipation: Boolean(data.hasParticipation),
                participationReasons: reasons,
                isArchived: Boolean(data.isArchived ?? prev.isArchived),
              }
            : prev
        );
      } catch {
        /* список/карточка уже могли передать флаги */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [product?.id, canDeleteProduct, canArchiveProduct, product?.participationReasons]);

  // Заполняем форму данными товара при редактировании
  useEffect(() => {
    if (currentProduct) {
      const buyoutRate = currentProduct.buyout_rate !== undefined && currentProduct.buyout_rate !== null 
        ? Number(currentProduct.buyout_rate)
        : 95;
      
      console.log('[ProductForm] Loading product data into form:', {
        buyout_rate_from_product: currentProduct.buyout_rate,
        buyout_rate_type: typeof currentProduct.buyout_rate,
        buyout_rate_processed: buyoutRate,
        product_id: currentProduct.id,
        full_product: currentProduct
      });

      minMarkupLastEditedRef.current = 'rub';
      setFormData({
        name: currentProduct.name || '',
        sku: currentProduct.sku || '',
        product_type: currentProduct.product_type === 'kit' ? 'kit' : 'product',
        categoryId: (currentProduct.categoryId ?? currentProduct.user_category_id ?? '').toString(),
        organizationId: currentProduct.organization_id != null ? String(currentProduct.organization_id) : (currentProduct.organizationId != null ? String(currentProduct.organizationId) : ''),
        supplierId:
          currentProduct.supplier_id != null
            ? String(currentProduct.supplier_id)
            : currentProduct.supplierId != null
              ? String(currentProduct.supplierId)
              : '',
        brand: currentProduct.brand || '',
        country_of_origin: currentProduct.country_of_origin || '',
        cost: currentProduct.cost || '',
        additionalExpenses: (() => {
          const v = currentProduct.additionalExpenses ?? currentProduct.additional_expenses;
          return v != null && v !== '' && !isNaN(Number(v)) ? String(v) : '';
        })(),
        minPrice: (currentProduct.minPrice != null && currentProduct.minPrice !== '' && !isNaN(Number(currentProduct.minPrice)))
          ? String(currentProduct.minPrice)
          : '',
        minMarkupPercent: (() => {
          const rub =
            currentProduct.minPrice != null && currentProduct.minPrice !== '' && !isNaN(Number(currentProduct.minPrice))
              ? String(currentProduct.minPrice)
              : '';
          const cost = currentProduct.cost || '';
          return rub !== '' ? minMarkupRubToPercent(rub, cost) : '';
        })(),
        minProfitOzon: (() => {
          const v = currentProduct.minProfitOzon ?? currentProduct.min_profit_ozon;
          return v != null && v !== '' && !isNaN(Number(v)) ? String(v) : '';
        })(),
        minProfitWb: (() => {
          const v = currentProduct.minProfitWb ?? currentProduct.min_profit_wb;
          return v != null && v !== '' && !isNaN(Number(v)) ? String(v) : '';
        })(),
        minProfitYm: (() => {
          const v = currentProduct.minProfitYm ?? currentProduct.min_profit_ym;
          return v != null && v !== '' && !isNaN(Number(v)) ? String(v) : '';
        })(),
        description: currentProduct.description || '',
        sku_ozon: currentProduct.sku_ozon || '',
        ozon_product_id:
          currentProduct.ozon_product_id != null && currentProduct.ozon_product_id !== ''
            ? String(currentProduct.ozon_product_id)
            : '',
        sku_wb: currentProduct.sku_wb || '',
        sku_ym: currentProduct.sku_ym || '',
        ym_market_sku:
          currentProduct.ym_market_sku != null && currentProduct.ym_market_sku !== ''
            ? String(currentProduct.ym_market_sku)
            : currentProduct.ym_product_id != null && currentProduct.ym_product_id !== ''
              ? String(currentProduct.ym_product_id)
              : '',
        buyout_rate: buyoutRate,
        barcodes: barcodesForForm(currentProduct.barcodes),
        weight: currentProduct.weight || '',
        length: currentProduct.length || '',
        width: currentProduct.width || '',
        height: currentProduct.height || '',
        product_weight: (() => {
          const v = currentProduct.product_weight ?? currentProduct.productWeight;
          if (v != null && v !== '') return String(v);
          const attrs =
            currentProduct.ozon_attributes && typeof currentProduct.ozon_attributes === 'object'
              ? currentProduct.ozon_attributes
              : null;
          if (!attrs) return '';
          for (const id of ['4497', '4383', 4497, 4383]) {
            const raw = attrs[id];
            if (raw == null || raw === '') continue;
            const s = String(raw).trim().replace(',', '.');
            if (/^\d+(\.\d+)?$/.test(s)) return s;
          }
          return '';
        })(),
        product_length: (() => {
          const v = currentProduct.product_length ?? currentProduct.productLength;
          return v != null && v !== '' ? String(v) : '';
        })(),
        product_width: (() => {
          const v = currentProduct.product_width ?? currentProduct.productWidth;
          return v != null && v !== '' ? String(v) : '';
        })(),
        product_height: (() => {
          const v = currentProduct.product_height ?? currentProduct.productHeight;
          return v != null && v !== '' ? String(v) : '';
        })(),
        volume: currentProduct.volume || '',
        kit_components: Array.isArray(currentProduct.kit_components) && currentProduct.kit_components.length > 0
          ? currentProduct.kit_components.map((c) => {
              const pid = c.productId ?? c.component_product_id;
              const hint = labelFromKitApiHint(c);
              return {
                productId: pid,
                quantity: c.quantity || 1,
                ...(hint ? { kit_hint_label: hint } : {}),
              };
            })
          : [],
        attributeValues: currentProduct.attribute_values && typeof currentProduct.attribute_values === 'object'
          ? Object.fromEntries(
              Object.entries(currentProduct.attribute_values).map(([k, v]) => [
                String(k),
                v === undefined || v === null
                  ? ''
                  : typeof v === 'boolean'
                    ? (v ? 'true' : 'false')
                    : String(v)
              ])
            )
          : {},
        mp_wb_vendor_code: currentProduct.mp_wb_vendor_code || '',
        mp_wb_name: currentProduct.mp_wb_name || '',
        mp_wb_description: currentProduct.mp_wb_description || '',
        mp_wb_brand: currentProduct.mp_wb_brand || '',
        mp_ym_name: currentProduct.mp_ym_name || '',
        mp_ym_description: currentProduct.mp_ym_description || '',
        mp_ozon_name: currentProduct.mp_ozon_name || '',
        mp_ozon_description: currentProduct.mp_ozon_description || '',
        mp_ozon_brand: currentProduct.mp_ozon_brand || '',
        mp_field_links: normalizeMpFieldLinks(currentProduct.mp_field_links),
        ozon_draft:
          currentProduct.ozon_draft && typeof currentProduct.ozon_draft === 'object' && !Array.isArray(currentProduct.ozon_draft)
            ? currentProduct.ozon_draft
            : {},
        wb_draft:
          currentProduct.wb_draft && typeof currentProduct.wb_draft === 'object' && !Array.isArray(currentProduct.wb_draft)
            ? currentProduct.wb_draft
            : {},
        ym_draft:
          currentProduct.ym_draft && typeof currentProduct.ym_draft === 'object' && !Array.isArray(currentProduct.ym_draft)
            ? currentProduct.ym_draft
            : {},
      });
      setFormData((prev) => applyLinkedMpFieldsFromMain(prev, prev.mp_field_links));
      const ozonAttrs = currentProduct.ozon_attributes && typeof currentProduct.ozon_attributes === 'object'
        ? Object.fromEntries(
            Object.entries(currentProduct.ozon_attributes).map(([k, v]) => {
              let val = v;
              if (val === undefined || val === null) val = '';
              else if (typeof val === 'object' && !Array.isArray(val)) {
                val = val.dictionary_value_id ?? val.value ?? val.id ?? '';
              }
              return [String(k), val === '' || val == null ? '' : String(val)];
            })
          )
        : {};
      setOzonAttributeValues(ozonAttrs);
      const wbAttrs = currentProduct.wb_attributes && typeof currentProduct.wb_attributes === 'object'
        ? Object.fromEntries(
            Object.entries(currentProduct.wb_attributes).map(([k, v]) => [
              String(k),
              normalizeWbAttributeScalar(v)
            ])
          )
        : {};
      setWbAttributeValues(wbAttrs);
      // Если габариты товара в ERP пустые — подставить из характеристик предмета WB (см → мм)
      const itemL = wbAttrs[WB_ITEM_DIM_CHARC.length];
      const itemW = wbAttrs[WB_ITEM_DIM_CHARC.width];
      const itemH = wbAttrs[WB_ITEM_DIM_CHARC.height];
      if (itemL || itemW || itemH) {
        setFormData((prev) => {
          const next = { ...prev };
          const fillMm = (cmVal, key) => {
            if (next[key] != null && String(next[key]).trim() !== '') return;
            const mm = cmToMm(cmVal);
            if (mm != null) next[key] = String(mm);
          };
          fillMm(itemL, 'product_length');
          fillMm(itemW, 'product_width');
          fillMm(itemH, 'product_height');
          return next;
        });
      }
      const ymAttrs = currentProduct.ym_attributes && typeof currentProduct.ym_attributes === 'object'
        ? Object.fromEntries(
            Object.entries(currentProduct.ym_attributes).flatMap(([k, v]) => {
              const key = String(k);
              const pairs = [[key, v]];
              // Нормализация ключей вида "Комплект (14805799)" -> "14805799"
              const match = key.match(/\((\d+)\)\s*$/);
              if (match?.[1]) {
                pairs.push([match[1], v]);
              }
              return pairs;
            })
          )
        : {};
      setYmAttributeValues(ymAttrs);

      setProductImages(normalizeProductImagesOrder(currentProduct.images));

      mpBaselineRef.current = buildMpBaseline({
        fields: {
          mp_wb_vendor_code: currentProduct.mp_wb_vendor_code || '',
          mp_wb_name: currentProduct.mp_wb_name || '',
          mp_wb_description: currentProduct.mp_wb_description || '',
          mp_wb_brand: currentProduct.mp_wb_brand || '',
          mp_ym_name: currentProduct.mp_ym_name || '',
          mp_ym_description: currentProduct.mp_ym_description || '',
          mp_ozon_name: currentProduct.mp_ozon_name || '',
          mp_ozon_description: currentProduct.mp_ozon_description || '',
          mp_ozon_brand: currentProduct.mp_ozon_brand || '',
        },
        ozonAttrs,
        wbAttrs,
        ymAttrs,
      });
    }
    // Только смена товара по id: иначе при новом объекте product с тем же id форма перезаписывается
    // и быстрый ввод со сканера в поле баркода сбрасывается.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- намеренно только id, не весь объект currentProduct
  }, [currentProduct?.id]);

  // Загрузка списка атрибутов для выбора по категории
  useEffect(() => {
    let cancelled = false;
    productAttributesApi.getAll().then((res) => {
      if (cancelled) return;
      const list = res?.data || [];
      setAllAttributes(list);
    }).catch(() => { if (!cancelled) setAllAttributes([]); });
    return () => { cancelled = true; };
  }, []);

  // Атрибуты, привязанные к выбранной категории (категория содержит attribute_ids)
  const categoryAttributes = useMemo(() => {
    const cid = formData.categoryId ? String(formData.categoryId) : '';
    if (!cid || !categories.length) return [];
    const category = categories.find((c) => String(c.id) === cid);
    const ids = (category?.attribute_ids || []).map((x) => String(x));
    if (!ids.length) return [];
    return allAttributes.filter((a) => ids.includes(String(a.id)));
  }, [allAttributes, categories, formData.categoryId]);

  // Источник значений сертификата: сначала категория товара, затем бренд
  const selectedCategoryForCert = useMemo(() => {
    const cid = String(formData.categoryId || '').trim();
    if (!cid) return null;
    return categories.find((c) => String(c.id) === cid) || null;
  }, [categories, formData.categoryId]);

  const selectedBrandForCert = useMemo(() => {
    const b = String(formData.brand || '').trim().toLowerCase();
    if (!b) return null;
    return brands.find((x) => String(x?.name || '').trim().toLowerCase() === b) || null;
  }, [brands, formData.brand]);

  useEffect(() => {
    const br = selectedBrandForCert;
    const catId = String(formData.categoryId || '').trim();
    if (!br?.id || !catId) {
      setBrandCategoryCerts([]);
      return;
    }
    let cancelled = false;
    certificatesApi
      .getAll({ brandId: br.id, includeExpired: false })
      .then((res) => {
        if (cancelled) return;
        const all = Array.isArray(res?.data) ? res.data : [];
        setBrandCategoryCerts(filterBrandCertsForCategory(all, catId));
      })
      .catch(() => {
        if (!cancelled) setBrandCategoryCerts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBrandForCert?.id, formData.categoryId]);

  const mpMappingByMarketplace = useMemo(() => {
    const br = selectedBrandForCert;
    const map = {};
    const list = br?.marketplace_mappings ?? br?.marketplaceMappings ?? [];
    for (const row of list) {
      const mp = String(row.marketplace || '').toLowerCase();
      if (mp) map[mp] = row;
    }
    return map;
  }, [selectedBrandForCert]);

  const selectedOrganization = useMemo(() => {
    const oid = String(formData.organizationId || '').trim();
    if (!oid) return null;
    return organizations.find((o) => String(o.id) === oid) || null;
  }, [organizations, formData.organizationId]);

  const orgVatText = useMemo(() => {
    const code = selectedOrganization?.vat ?? '';
    return vatCodeToText(code);
  }, [selectedOrganization]);

  const certSource = useMemo(() => {
    const cat = selectedCategoryForCert || {};
    const br = selectedBrandForCert || {};
    const registry = Array.isArray(brandCategoryCerts) ? brandCategoryCerts : [];
    const certRow = registry.find((c) => c.document_type === 'certificate') || registry[0] || null;
    const declRow = registry.find((c) => c.document_type === 'declaration') || null;
    const regRow = registry.find((c) => c.document_type === 'registration') || null;

    const pickStr = (a, b) => {
      const v = a != null ? a : b;
      if (v === undefined || v === null) return '';
      const s = String(v).trim();
      return s;
    };

    const pickDate = (a, b) => {
      const s = pickStr(a, b);
      if (!s) return '';
      return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
    };

    const certificate = {
      number: pickStr(certRow?.certificate_number, pickStr(cat.certificate_number, br.certificate_number || cat.certificateNumber)),
      validFrom: pickDate(certRow?.valid_from, pickStr(cat.certificate_valid_from, br.certificate_valid_from)),
      validTo: pickDate(certRow?.valid_to, pickStr(cat.certificate_valid_to, br.certificate_valid_to)),
    };
    const declaration = {
      number: pickStr(declRow?.certificate_number, pickStr(cat.declaration_number, br.declaration_number)),
      validFrom: pickDate(declRow?.valid_from, pickStr(cat.declaration_valid_from, br.declaration_valid_from)),
      validTo: pickDate(declRow?.valid_to, pickStr(cat.declaration_valid_to, br.declaration_valid_to)),
    };
    const registration = {
      number: pickStr(regRow?.certificate_number, pickStr(cat.registration_number, br.registration_number)),
      validFrom: pickDate(regRow?.valid_from, pickStr(cat.registration_valid_from, br.registration_valid_from)),
      validTo: pickDate(regRow?.valid_to, pickStr(cat.registration_valid_to, br.registration_valid_to)),
    };

    const primaryDocType =
      certRow?.document_type || declRow?.document_type || regRow?.document_type || 'certificate';

    const number = firstNonEmpty(
      certificate.number,
      declaration.number,
      registration.number
    );
    const validFrom = firstNonEmpty(certificate.validFrom, declaration.validFrom, registration.validFrom);
    const validTo = firstNonEmpty(certificate.validTo, declaration.validTo, registration.validTo);

    return {
      certificate,
      declaration,
      registration,
      primaryDocType,
      number: number ? String(number).slice(0, 1000) : '',
      validFrom,
      validTo,
    };
  }, [selectedCategoryForCert, selectedBrandForCert, brandCategoryCerts]);

  function firstNonEmpty(...vals) {
    for (const v of vals) {
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  const resolveOzonEnumValue = useCallback(
    (attr, textValue) => {
      const attrId = attr?.id;
      const dict = attrId != null ? ozonDictValues[attrId] : null;
      if (!Array.isArray(dict) || dict.length === 0) return textValue;
      const norm = normalizeAttrName(textValue);
      const hit = dict.find((v) => normalizeAttrName(v.value ?? v.name ?? '') === norm);
      if (hit?.id != null) return String(hit.id);
      const partial = dict.find((v) => normalizeAttrName(v.value ?? v.name ?? '').includes(norm));
      if (partial?.id != null) return String(partial.id);
      return textValue;
    },
    [ozonDictValues]
  );

  // Подгружаем выбранную категорию по ID для актуальных marketplace_mappings
  const [categoryDetails, setCategoryDetails] = useState(null);
  const [categoryDetailsLoading, setCategoryDetailsLoading] = useState(false);
  useEffect(() => {
    const cid = formData.categoryId ? String(formData.categoryId).trim() : '';
    if (!cid) {
      setCategoryDetails(null);
      return;
    }
    let cancelled = false;
    setCategoryDetailsLoading(true);
    userCategoriesApi.getById(cid)
      .then((res) => {
        if (cancelled) return;
        const raw = res?.data ?? res;
        const cat = (raw && (raw.id != null || raw.name)) ? raw : (raw?.data && (raw.data.id != null || raw.data.name)) ? raw.data : null;
        setCategoryDetails(cat || null);
      })
      .catch(() => {
        if (!cancelled) setCategoryDetails(null);
      })
      .finally(() => { if (!cancelled) setCategoryDetailsLoading(false); });
    return () => { cancelled = true; };
  }, [formData.categoryId]);

  /**
   * Категория для маппингов маркетплейсов: только если categoryDetails соответствует выбранному categoryId.
   * Иначе берём строку из списка categories — иначе после смены категории остаются чужие Ozon/WB/YM и поля не грузятся.
   */
  const categoryResolvedForMappings = useMemo(() => {
    const cid = formData.categoryId ? String(formData.categoryId).trim() : '';
    if (!cid) return null;
    if (categoryDetails && String(categoryDetails.id) === cid) return categoryDetails;
    return categories.find((c) => String(c.id) === cid) ?? null;
  }, [formData.categoryId, categoryDetails, categories]);

  // Ozon: категория и тип (из подгруженной категории или из списка: ozon_description_category_id/ozon_type_id либо composite "descId_typeId" в ozon)
  const { ozonCategoryId, ozonTypeId } = useMemo(() => {
    const cid = formData.categoryId ? String(formData.categoryId) : '';
    if (!cid) return { ozonCategoryId: null, ozonTypeId: 0 };
    const category = categoryResolvedForMappings;
    let mm = category?.marketplace_mappings ?? category?.marketplaceMappings;
    if (typeof mm === 'string') {
      try {
        mm = JSON.parse(mm || '{}');
      } catch (_) {
        mm = {};
      }
    }
    if (!mm || typeof mm !== 'object') return { ozonCategoryId: null, ozonTypeId: 0 };
    const descIdFromFields = (mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId) != null
      ? String(mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId).trim() : null;
    const typeIdFromFields = (mm.ozon_type_id ?? mm.ozonTypeId) != null
      ? Number(mm.ozon_type_id ?? mm.ozonTypeId) : 0;
    if (descIdFromFields && typeIdFromFields > 0) {
      return { ozonCategoryId: descIdFromFields, ozonTypeId: typeIdFromFields };
    }
    const ozonRaw = mm.ozon;
    const ozon = ozonRaw != null ? String(ozonRaw).trim() : null;
    if (!ozon) return { ozonCategoryId: null, ozonTypeId: 0 };
    const underscoreIdx = ozon.indexOf('_');
    if (underscoreIdx > 0) {
      const descId = ozon.slice(0, underscoreIdx).trim() || null;
      const typePart = ozon.slice(underscoreIdx + 1).trim();
      const typeId = typePart ? parseInt(typePart, 10) : 0;
      if (descId && Number.isFinite(typeId) && typeId > 0) {
        return { ozonCategoryId: descId, ozonTypeId: typeId };
      }
    }
    const typeId = (mm.ozon_type_id ?? mm.ozonTypeId) != null ? Number(mm.ozon_type_id ?? mm.ozonTypeId) : 0;
    return { ozonCategoryId: ozon, ozonTypeId: Number.isFinite(typeId) ? typeId : 0 };
  }, [formData.categoryId, categoryResolvedForMappings]);

  /** Есть ли в сопоставлении ERP→Ozon хотя бы ozon или полная пара полей (чтобы запросить схему атрибутов с API) */
  const hasOzonMarketplaceMapping = useMemo(() => {
    const cid = formData.categoryId ? String(formData.categoryId) : '';
    if (!cid) return false;
    const category = categoryResolvedForMappings;
    if (!category) return false;
    let mm = category?.marketplace_mappings ?? category?.marketplaceMappings;
    if (typeof mm === 'string') {
      try { mm = JSON.parse(mm || '{}'); } catch (_) { mm = {}; }
    }
    if (!mm || typeof mm !== 'object') return false;
    const oz = mm.ozon != null ? String(mm.ozon).trim() : '';
    if (oz) return true;
    const d = mm.ozon_description_category_id ?? mm.ozonDescriptionCategoryId;
    const t = mm.ozon_type_id ?? mm.ozonTypeId;
    if (d != null && String(d).trim() !== '' && t != null && Number(t) > 0) return true;
    return false;
  }, [formData.categoryId, categoryResolvedForMappings]);

  const ozonDescIdForApi = useMemo(() => {
    if (ozonResolvedPair.descId != null && String(ozonResolvedPair.descId).trim() !== '') {
      return String(ozonResolvedPair.descId).trim();
    }
    return ozonCategoryId != null ? String(ozonCategoryId) : '';
  }, [ozonResolvedPair.descId, ozonCategoryId]);

  const ozonTypeIdForApi = useMemo(() => {
    if (ozonResolvedPair.typeId > 0) return ozonResolvedPair.typeId;
    return ozonTypeId > 0 ? ozonTypeId : 0;
  }, [ozonResolvedPair.typeId, ozonTypeId]);

  // WB: subjectId категории из marketplace_mappings (для подгрузки характеристик категории)
  const wbSubjectId = useMemo(() => {
    const cid = formData.categoryId ? String(formData.categoryId) : '';
    if (!cid) return 0;
    const category = categoryResolvedForMappings;
    let mm = category?.marketplace_mappings ?? category?.marketplaceMappings;
    if (typeof mm === 'string') {
      try { mm = JSON.parse(mm || '{}'); } catch (_) { mm = {}; }
    }
    return resolveWbSubjectIdFromMappings(mm);
  }, [formData.categoryId, categoryResolvedForMappings]);

  const effectiveWbSubjectId = useMemo(() => {
    if (wbSubjectId > 0) return wbSubjectId;
    const fromCard = wbFetchedProduct?.subjectID ?? wbFetchedProduct?.subjectId;
    const n = fromCard != null ? Number(fromCard) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [wbSubjectId, wbFetchedProduct]);

  const wbAttributesOrganizationId = useMemo(
    () =>
      resolveKitPickerOrganizationId(
        formData.organizationId,
        productsListOrganizationId,
        currentProduct?.organization_id ?? currentProduct?.organizationId
      ),
    [formData.organizationId, productsListOrganizationId, currentProduct?.organization_id, currentProduct?.organizationId]
  );

  // Яндекс.Маркет: id листовой категории (строка цифр — без потери точности для длинных id)
  const ymMarketCategoryId = useMemo(() => {
    const category = categoryResolvedForMappings;
    if (!category) return '';
    let mm = category.marketplace_mappings ?? category.marketplaceMappings;
    if (typeof mm === 'string') {
      try { mm = JSON.parse(mm || '{}'); } catch (_) { mm = {}; }
    }
    if (!mm || typeof mm !== 'object') return '';
    const raw = mm.ym ?? mm.yandex;
    if (raw == null || raw === '') return '';
    const s = String(raw).trim().replace(/\s+/g, '');
    return /^\d+$/.test(s) ? s : '';
  }, [categoryResolvedForMappings]);

  // Загрузка схемы атрибутов Ozon — только на вкладке Ozon (не грузим при открытии карточки на «Основное»)
  useEffect(() => {
    if (activeTab !== 'ozon') return undefined;
    const userCategoryId = formData.categoryId ? String(formData.categoryId).trim() : '';
    if (!userCategoryId || !hasOzonMarketplaceMapping) {
      setOzonAttributes([]);
      setOzonResolvedPair({ descId: null, typeId: 0 });
      setOzonAttributesError('');
      return;
    }
    let cancelled = false;
    setOzonAttributesLoading(true);
    setOzonAttributesError('');
    userCategoriesApi.getMarketplaceAttributes(userCategoryId, 'ozon')
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? res;
        setOzonAttributes(Array.isArray(list) ? list : []);
        const op = res?.ozon_pair;
        if (op && (op.description_category_id != null || op.type_id != null)) {
          setOzonResolvedPair({
            descId: op.description_category_id != null ? String(op.description_category_id) : null,
            typeId: Number(op.type_id) || 0
          });
        } else {
          setOzonResolvedPair({ descId: null, typeId: 0 });
        }
        setOzonDictValues({});
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[ProductForm] Ozon category attributes load failed:', err);
          setOzonAttributes([]);
          setOzonResolvedPair({ descId: null, typeId: 0 });
          const msg = err?.response?.data?.error || err?.message || 'Ошибка загрузки атрибутов Ozon.';
          setOzonAttributesError(msg);
        }
      })
      .finally(() => { if (!cancelled) setOzonAttributesLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, formData.categoryId, hasOzonMarketplaceMapping]);

  // Автоподстановка значений документа в Ozon-атрибуты по названию поля
  useEffect(() => {
    if (!ozonAttributes?.length) return;
    if (!certSourceHasAnyDocument(certSource)) return;
    setOzonAttributeValues((prev) =>
      applyCertAutofillToAttributes(ozonAttributes, certSource, prev, {
        getAttrKey: (attr) => String(attr.id),
        getAttrName: (attr) => attr?.name ?? '',
        resolveEnumValue: resolveOzonEnumValue,
      })
    );
  }, [ozonAttributes, certSource, resolveOzonEnumValue]);

  // Автоподстановка НДС в Ozon-атрибуты (по названию поля)
  useEffect(() => {
    if (!ozonAttributes?.length) return;
    if (!orgVatText) return;
    setOzonAttributeValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const attr of ozonAttributes) {
        const key = String(attr.id);
        if (!isEmptyMarketplaceValue(next[key])) continue;
        const n = normalizeAttrName(attr?.name);
        const isVatField = /\bндс\b/.test(n) || (/ставк/.test(n) && /\bндс\b/.test(n)) || /\bvat\b/.test(n);
        if (!isVatField) continue;
        next[key] = orgVatText;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [ozonAttributes, orgVatText]);

  const handleOzonAttributeChange = useCallback((attrId, value) => {
    setOzonAttributeValues((prev) => ({ ...prev, [String(attrId)]: value }));
  }, []);

  const ozonDictQueueRef = useRef(null);
  if (!ozonDictQueueRef.current) {
    ozonDictQueueRef.current = createAsyncQueue(2);
  }
  const ozonDictInflightRef = useRef(new Set());

  const loadOzonDictValues = useCallback((attrId) => {
    if (!ozonDescIdForApi || !ozonTypeIdForApi || ozonTypeIdForApi <= 0) return;
    const key = String(attrId);
    if (ozonDictInflightRef.current.has(key)) return;
    ozonDictInflightRef.current.add(key);
    ozonDictQueueRef.current(() =>
      integrationsApi
        .getOzonAttributeValues(attrId, ozonDescIdForApi, ozonTypeIdForApi, { limit: 500 })
        .then(({ result }) => {
          setOzonDictValues((prev) => {
            if (Array.isArray(prev[attrId])) return prev;
            return { ...prev, [attrId]: result || [] };
          });
        })
        .catch((err) => {
          console.warn('[ProductForm] Ozon attribute values load failed:', err);
          setOzonDictValues((prev) => {
            if (Array.isArray(prev[attrId])) return prev;
            return { ...prev, [attrId]: [] };
          });
        })
        .finally(() => {
          ozonDictInflightRef.current.delete(key);
        })
    );
  }, [ozonDescIdForApi, ozonTypeIdForApi]);

  // WB: загрузка атрибутов категории (схема) — только на вкладке WB
  useEffect(() => {
    if (activeTab !== 'wb') return undefined;
    const userCategoryId = formData.categoryId ? String(formData.categoryId).trim() : '';
    if (!userCategoryId || !effectiveWbSubjectId || effectiveWbSubjectId <= 0) {
      setWbCategoryAttributes([]);
      setWbCategoryAttributesError('');
      return undefined;
    }
    if (!wbAttributesOrganizationId) {
      setWbCategoryAttributes([]);
      setWbCategoryAttributesError('Выберите организацию — атрибуты WB запрашиваются из кабинета этой организации.');
      return undefined;
    }
    let cancelled = false;
    setWbCategoryAttributesLoading(true);
    setWbCategoryAttributesError('');
    userCategoriesApi.getMarketplaceAttributes(userCategoryId, 'wb', {
      organizationId: wbAttributesOrganizationId,
      subjectId: effectiveWbSubjectId !== wbSubjectId ? effectiveWbSubjectId : undefined
    })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? res;
        setWbCategoryAttributes(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[ProductForm] WB category attributes load failed:', err);
          setWbCategoryAttributes([]);
          const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Ошибка загрузки атрибутов WB.';
          setWbCategoryAttributesError(msg);
        }
      })
      .finally(() => { if (!cancelled) setWbCategoryAttributesLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, formData.categoryId, effectiveWbSubjectId, wbSubjectId, wbAttributesOrganizationId]);

  const wbAttrKey = useCallback((a) => {
    const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
    return id != null ? String(id) : String(a?.name || '');
  }, []);

  const wbAttrName = useCallback(
    (a) => a?.name ?? a?.charcName ?? a?.characteristic_name ?? '',
    []
  );

  // Автоподстановка значений документа в WB-атрибуты по названию поля
  useEffect(() => {
    if (!wbCategoryAttributes?.length) return;
    if (!certSourceHasAnyDocument(certSource)) return;
    setWbAttributeValues((prev) =>
      applyCertAutofillToAttributes(wbCategoryAttributes, certSource, prev, {
        getAttrKey: wbAttrKey,
        getAttrName: wbAttrName,
      })
    );
  }, [wbCategoryAttributes, certSource, wbAttrKey, wbAttrName]);

  // Автоподстановка НДС в WB-атрибуты (по названию поля)
  useEffect(() => {
    if (!wbCategoryAttributes?.length) return;
    if (!orgVatText) return;
    setWbAttributeValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const a of wbCategoryAttributes) {
        const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
        const key = id != null ? String(id) : String(a?.name || '');
        if (!isEmptyMarketplaceValue(next[key])) continue;
        const name = a?.name ?? a?.charcName ?? a?.characteristic_name ?? '';
        const n = normalizeAttrName(name);
        const isVatField = /\bндс\b/.test(n) || (/(ставк|налог)/.test(n) && /\bндс\b/.test(n)) || /\bvat\b/.test(n);
        if (!isVatField) continue;
        next[key] = orgVatText;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [wbCategoryAttributes, orgVatText]);

  // Яндекс.Маркет: характеристики листовой категории — только на вкладке YM
  useEffect(() => {
    if (activeTab !== 'ym') return undefined;
    const userCategoryId = formData.categoryId ? String(formData.categoryId).trim() : '';
    if (!userCategoryId || !ymMarketCategoryId) {
      setYmCategoryAttributes([]);
      setYmCategoryAttributesError('');
      return;
    }
    const organizationId = resolveKitPickerOrganizationId(
      formData.organizationId,
      productsListOrganizationId,
      currentProduct?.organization_id ?? currentProduct?.organizationId
    );
    let cancelled = false;
    setYmCategoryAttributesLoading(true);
    setYmCategoryAttributesError('');
    userCategoriesApi.getMarketplaceAttributes(userCategoryId, 'ym', {
      organizationId: organizationId || undefined,
    })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? res;
        setYmCategoryAttributes(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[ProductForm] YM category parameters load failed:', err);
          setYmCategoryAttributes([]);
          const msg = err?.response?.data?.error || err?.message || 'Ошибка загрузки характеристик Яндекс.Маркета.';
          setYmCategoryAttributesError(msg);
        }
      })
      .finally(() => { if (!cancelled) setYmCategoryAttributesLoading(false); });
    return () => { cancelled = true; };
  }, [
    activeTab,
    formData.categoryId,
    formData.organizationId,
    ymMarketCategoryId,
    productsListOrganizationId,
    currentProduct?.organization_id,
    currentProduct?.organizationId,
  ]);

  /** Схема YM без дублей dedicated-полей + пустые поля тоже; обязательные сверху. */
  const ymFormAttributes = useMemo(() => {
    const schema = filterYmCategoryAttributesForForm(ymCategoryAttributes);
    const byId = new Map(schema.map((a) => [String(a.id), a]));
    const fetchedNames = new Map();
    if (Array.isArray(ymFetchedProduct?.parameterValues)) {
      for (const pv of ymFetchedProduct.parameterValues) {
        const pid = pv?.parameterId ?? pv?.id;
        if (pid == null) continue;
        const pname = pv?.parameterName ?? pv?.name ?? pv?.label ?? null;
        if (pname) fetchedNames.set(String(pid), String(pname));
      }
    }
    for (const [key, raw] of Object.entries(ymAttributeValues || {})) {
      if (byId.has(key)) continue;
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const nameHint = fetchedNames.get(key);
      if (nameHint && isYmParamDuplicatingDedicatedField(nameHint)) continue;
      byId.set(key, {
        id: key,
        name: nameHint || `Параметр ${key}`,
        type: 'string',
        required: false,
        _orphan: true,
      });
    }
    return [...byId.values()].sort((a, b) => {
      const ar = a.required ? 1 : 0;
      const br = b.required ? 1 : 0;
      if (ar !== br) return br - ar;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    });
  }, [ymCategoryAttributes, ymAttributeValues, ymFetchedProduct]);

  // Автоподстановка значений документа в YM-атрибуты по названию параметра
  useEffect(() => {
    if (!ymCategoryAttributes?.length) return;
    if (!certSourceHasAnyDocument(certSource)) return;
    setYmAttributeValues((prev) =>
      applyCertAutofillToAttributes(ymCategoryAttributes, certSource, prev, {
        getAttrKey: (a) => String(a.id),
        getAttrName: (a) => a?.name ?? '',
      })
    );
  }, [ymCategoryAttributes, certSource]);

  // Автоподстановка сертификата в атрибуты категории (основная вкладка)
  useEffect(() => {
    if (!categoryAttributes?.length) return;
    if (!certSourceHasAnyDocument(certSource)) return;
    setFormData((prev) => {
      const nextAttrs = applyCertAutofillToAttributes(
        categoryAttributes,
        certSource,
        prev.attributeValues || {},
        {
          getAttrKey: (attr) => String(attr.id),
          getAttrName: (attr) => attr?.name ?? '',
        }
      );
      if (nextAttrs === prev.attributeValues) return prev;
      return { ...prev, attributeValues: nextAttrs };
    });
  }, [categoryAttributes, certSource]);

  // Автоподстановка НДС в YM-атрибуты (по названию параметра)
  useEffect(() => {
    if (!ymCategoryAttributes?.length) return;
    if (!orgVatText) return;
    setYmAttributeValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const a of ymCategoryAttributes) {
        const key = String(a.id);
        if (!isEmptyMarketplaceValue(next[key])) continue;
        const n = normalizeAttrName(a?.name);
        const isVatField = /\bндс\b/.test(n) || (/(ставк|налог)/.test(n) && /\bндс\b/.test(n)) || /\bvat\b/.test(n);
        if (!isVatField) continue;
        // для YM если ENUM — чаще нужно id; но без справочника подставим текст/процент
        next[key] = orgVatText;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [ymCategoryAttributes, orgVatText]);

  const mergeOzonFetchedIntoForm = useCallback((data) => {
    if (!data) return;
    const name = String(data.name ?? data.title ?? '').trim();
    const rawDesc = data.description ?? data.description_html ?? '';
    const description =
      rawDesc != null
        ? String(rawDesc)
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : '';
    let brand = String(data.brand ?? '').trim();
    const attrs = data.attributes ?? data.attribute_values;
    if (!brand && Array.isArray(attrs)) {
      const brandAttr = attrs.find(
        (a) =>
          Number(a.attribute_id ?? a.id) === 85 ||
          /бренд|brand/i.test(String(a.name ?? a.attribute_id ?? ''))
      );
      const v0 = brandAttr?.values?.[0];
      if (v0) {
        brand = String(v0.value ?? v0.dictionary_value_id ?? v0.id ?? '').trim();
      }
    }
    setFormData((prev) => {
      let next = { ...prev };
      if (name) next.mp_ozon_name = name;
      if (description) next.mp_ozon_description = description;
      if (brand) next.mp_ozon_brand = brand;
      // Ozon depth/width/height — мм; weight — г. Всегда в ozon_draft; в ERP — при связи.
      const dx = data.dimension_x ?? data.width;
      const dy = data.dimension_y ?? data.height;
      const dz = data.dimension_z ?? data.depth ?? data.length;
      const wG = data.weight ?? data.weight_brutto;
      const toNum = (v) => {
        const n = typeof v === 'number' ? v : (v != null && String(v).trim() !== '' ? Number(String(v).replace(',', '.')) : NaN);
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const length = toNum(dz);
      const width = toNum(dx);
      const height = toNum(dy);
      const weight = toNum(wG);
      if (length != null || width != null || height != null || weight != null) {
        const prevDims = getMpDraftDimensionsMm(prev, 'ozon') || {};
        const nextDims = {
          ...prevDims,
          ...(length != null ? { length } : {}),
          ...(width != null ? { width } : {}),
          ...(height != null ? { height } : {}),
          ...(weight != null ? { weight } : {}),
        };
        next = withMpDraftPatch(next, 'ozon', { dimensions: nextDims });
      }
      if (isMpFieldLinked(prev.mp_field_links, 'dimensions', 'ozon')) {
        if (weight != null) next.weight = String(weight);
        if (width != null) next.width = String(width);
        if (height != null) next.height = String(height);
        if (length != null) next.length = String(length);
      }
      return next;
    });
  }, []);

  const fetchOzonProductInfo = useCallback(async () => {
    const organizationId = resolveKitPickerOrganizationId(
      formData.organizationId,
      productsListOrganizationId,
      currentProduct?.organization_id ?? currentProduct?.organizationId
    );
    const productIdRaw =
      String(formData.ozon_product_id || '').trim() ||
      (currentProduct?.ozon_product_id != null ? String(currentProduct.ozon_product_id) : '');
    const productId = productIdRaw ? Number(productIdRaw.replace(/\D/g, '')) : null;
    const offerCandidates = [
      formData.sku_ozon,
      currentProduct?.sku_ozon,
      formData.sku
    ]
      .map((v) => (v != null && String(v).trim() !== '' ? String(v).trim() : ''))
      .filter(Boolean);
    const offerIds = [...new Set(offerCandidates)];
    if (!productId && offerIds.length === 0) {
      setOzonSyncError('Укажите артикул Ozon (offer_id), product_id карточки Ozon или артикул.');
      return;
    }
    if (!organizationId) {
      setOzonSyncError('Выберите организацию — данные запрашиваются из кабинета Ozon этой организации.');
      return;
    }
    setOzonSyncError('');
    setOzonSyncSuccess('');
    setOzonSyncLoading(true);
    try {
      const apiBase = { organizationId };
      let data = null;
      let lastErr = null;
      if (productId && productId > 0) {
        try {
          data = await integrationsApi.getOzonProductInfo({ ...apiBase, product_id: productId });
        } catch (e) {
          lastErr = e;
        }
      }
      for (const offerId of offerIds) {
        if (data) break;
        try {
          data = await integrationsApi.getOzonProductInfo({ ...apiBase, offer_id: offerId });
        } catch (e) {
          lastErr = e;
        }
      }
      if (!data) {
        if (lastErr) throw lastErr;
        const hint =
          offerIds.length > 1 && offerIds[0] !== offerIds[offerIds.length - 1]
            ? ` Проверьте offer_id Ozon (например «${offerIds.find((o) => o !== formData.sku) || offerIds[0]}»), он может отличаться от артикула.`
            : '';
        setOzonSyncError(`Товар не найден в кабинете Ozon выбранной организации.${hint}`);
        return;
      }
      setSyncedOzonProductId(data.id != null ? Number(data.id) : null);
      setOzonFetchedProduct(data);
      setOzonShowAllFields(true);
      mergeOzonFetchedIntoForm(data);
      const offerIdFromOzon = (data.offer_id ?? data.sku ?? '').trim();
      setFormData((prev) => {
        const next = { ...prev };
        if (offerIdFromOzon) next.sku_ozon = offerIdFromOzon;
        if (data.id != null) next.ozon_product_id = String(data.id);
        return next;
      });
      const attrs = data.attributes ?? data.attribute_values;
      if (attrs && Array.isArray(attrs)) {
        const nextAttrs = {};
        attrs.forEach((a) => {
          const id = a.attribute_id ?? a.id;
          let val = null;
          if (a.values != null && Array.isArray(a.values) && a.values[0] != null) {
            const v = a.values[0];
            // Для полей-словарей (Бренд и др.) приоритет dictionary_value_id — чтобы в селекте на вкладке Ozon отображалось значение
            val = v.dictionary_value_id ?? v.value ?? v.id ?? v;
          } else {
            val = a.value ?? a.values;
          }
          if (id != null) nextAttrs[String(id)] = val != null ? String(val) : '';
        });
        setOzonAttributeValues((prev) => ({ ...prev, ...nextAttrs }));
      }
      setOzonSyncSuccess(
        'Данные с Ozon загружены в поля вкладки (название, описание, бренд, атрибуты). Можно отредактировать и отправить обратно на Ozon.'
      );
    } catch (err) {
      const msg =
        err.response?.data?.message ??
        err.response?.data?.error ??
        err.message ??
        'Ошибка при загрузке данных с Ozon.';
      setOzonSyncError(msg);
    } finally {
      setOzonSyncLoading(false);
    }
  }, [
    currentProduct?.ozon_product_id,
    currentProduct?.sku_ozon,
    formData.sku,
    formData.sku_ozon,
    formData.ozon_product_id,
    formData.organizationId,
    productsListOrganizationId,
    mergeOzonFetchedIntoForm
  ]);

  const mergeWbFetchedIntoForm = useCallback((p) => {
    if (!p) return;
    const name = String(p.title ?? p.name ?? '').trim();
    const brand = String(p.brand ?? '').trim();
    const description = String(p.description ?? p.descriptionRu ?? '').trim();
    const vendorCode = String(p.vendorCode ?? '').trim();
    const dims = p.dimensions && typeof p.dimensions === 'object' ? p.dimensions : null;
    const width = dims?.width;
    const height = dims?.height;
    const length = dims?.length;
    const weightBrutto = dims?.weightBrutto;

    const toNumber = (v) => {
      const n = typeof v === 'number' ? v : (v != null && String(v).trim() !== '' ? Number(String(v).replace(',', '.')) : NaN);
      return Number.isFinite(n) ? n : null;
    };

    const convertDimsToMm = (val, all) => {
      const n = toNumber(val);
      if (n == null) return null;
      const max = Math.max(...all.map((x) => (toNumber(x) ?? 0)));
      return max > 0 && max <= 200 ? Math.round(n * 10) : Math.round(n);
    };

    const convertWeightToG = (val) => {
      const n = toNumber(val);
      if (n == null) return null;
      return n <= 50 ? Math.round(n * 1000) : Math.round(n);
    };

    const wMm = convertDimsToMm(width, [width, height, length]);
    const hMm = convertDimsToMm(height, [width, height, length]);
    const lMm = convertDimsToMm(length, [width, height, length]);
    const wG = convertWeightToG(weightBrutto);

    const barcodes = barcodesFromWbSizes(p.sizes);
    const lengthCm = toNumber(length);
    const widthCm = toNumber(width);
    const heightCm = toNumber(height);

    setFormData((prev) => {
      let next = { ...prev };
      if (name) next.mp_wb_name = name;
      if (description) next.mp_wb_description = description;
      if (brand) next.mp_wb_brand = brand;
      if (vendorCode) next.mp_wb_vendor_code = vendorCode;
      // Габариты упаковки Content API → всегда в wb_draft; в ERP — при связи
      if (lMm != null || wMm != null || hMm != null || wG != null) {
        const prevDims = getMpDraftDimensionsMm(prev, 'wb') || {};
        const nextDims = {
          ...prevDims,
          ...(lMm != null ? { length: lMm } : {}),
          ...(wMm != null ? { width: wMm } : {}),
          ...(hMm != null ? { height: hMm } : {}),
          ...(wG != null ? { weight: wG } : {}),
        };
        next = withMpDraftPatch(next, 'wb', { dimensions: nextDims });
      }
      if (isMpFieldLinked(prev.mp_field_links, 'dimensions', 'wb')) {
        if (wG != null) next.weight = String(wG);
        if (lMm != null) next.length = String(lMm);
        if (wMm != null) next.width = String(wMm);
        if (hMm != null) next.height = String(hMm);
      }
      const prevEmpty =
        !Array.isArray(prev.barcodes) ||
        prev.barcodes.every((b) => !coerceBarcodeString(b?.barcode ?? b));
      if (barcodes.length > 0 && prevEmpty) {
        next.barcodes = barcodes.map((b) => ({ barcode: b, marketplaces: [] }));
      }
      return next;
    });

    if (lengthCm != null && widthCm != null && heightCm != null) {
      setWbAttributeValues((prev) => ({
        ...prev,
        [WB_PACK_DIM_CHARC.length]: String(lengthCm),
        [WB_PACK_DIM_CHARC.width]: String(widthCm),
        [WB_PACK_DIM_CHARC.height]: String(heightCm),
      }));
    }
  }, []);

  const fetchWbProductInfo = useCallback(async () => {
    const organizationId = resolveKitPickerOrganizationId(
      formData.organizationId,
      productsListOrganizationId,
      currentProduct?.organization_id ?? currentProduct?.organizationId
    );
    const skuWbRaw =
      formData.sku_wb != null && String(formData.sku_wb).trim() !== '' ? String(formData.sku_wb).trim() : '';
    const nmId = skuWbRaw && /^\d+$/.test(skuWbRaw) ? skuWbRaw : null;
    const vendorCandidates = [
      formData.mp_wb_vendor_code,
      currentProduct?.mp_wb_vendor_code,
      formData.sku_ozon,
      currentProduct?.sku_ozon,
      skuWbRaw && !nmId ? skuWbRaw : null
    ]
      .map((v) => sanitizeWbVendorCode(v))
      .filter(Boolean);
    const vendorCodes = [...new Set(vendorCandidates)];
    const expectedVendor = sanitizeWbVendorCode(
      formData.mp_wb_vendor_code || currentProduct?.mp_wb_vendor_code || ''
    );
    const normVc = (v) => sanitizeWbVendorCode(v).toLowerCase();
    const matchesExpectedVendor = (card) => {
      if (!expectedVendor) return true;
      const loaded = normVc(card?.vendorCode ?? card?.vendor_code);
      return loaded === normVc(expectedVendor);
    };
    if (!nmId && vendorCodes.length === 0) {
      setWbSyncError('Укажите nmId (номенклатура WB) или vendorCode (артикул продавца).');
      return;
    }
    if (!organizationId) {
      setWbSyncError('Выберите организацию — данные запрашиваются из кабинета Wildberries этой организации.');
      return;
    }
    setWbSyncError('');
    setWbSyncSuccess('');
    setWbSyncLoading(true);
    try {
      const apiBase = { organizationId };
      let data = null;
      let lastErr = null;
      // Сначала nmId из формы (если указан) — не перезаписываем чужой id поиском только по vendorCode
      if (nmId) {
        try {
          const hit = await integrationsApi.getWildberriesProductInfo({
            ...apiBase,
            nm_id: nmId,
            vendor_code: expectedVendor || vendorCodes[0] || undefined
          });
          if (hit && matchesExpectedVendor(hit)) data = hit;
          else if (hit && expectedVendor) {
            const loadedVc = String(hit.vendorCode ?? hit.vendor_code ?? '').trim();
            const loadedNm = hit.nmId ?? hit.nmID ?? hit.nm_id ?? nmId;
            setWbSyncError(
              `nmId ${loadedNm} в кабинете WB — другой товар (vendorCode «${loadedVc || '—'}»). ` +
                `Очистите nmId или укажите верный vendorCode «${expectedVendor}».`
            );
            return;
          } else if (hit) {
            data = hit;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      for (const vendorCode of vendorCodes) {
        if (data) break;
        try {
          const hit = await integrationsApi.getWildberriesProductInfo({
            ...apiBase,
            vendor_code: vendorCode
          });
          if (hit && matchesExpectedVendor(hit)) data = hit;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!data) {
        if (lastErr) throw lastErr;
        setWbSyncError(
          expectedVendor
            ? `Товар с vendorCode «${expectedVendor}» не найден в кабинете Wildberries выбранной организации.`
            : 'Товар не найден в кабинете Wildberries выбранной организации.'
        );
        return;
      }
      setWbFetchedProduct(data);
      setWbShowAllFields(true);
      mergeWbFetchedIntoForm(data);
      if (Array.isArray(data.characteristics) && data.characteristics.length > 0) {
        setWbAttributeValues((prev) => mergeWbCharacteristicsIntoValues(data.characteristics, prev));
      }
      // На вкладке WB заполняем nmId, если оно пришло нормализованным
      const nmFromWb = data.nmId ?? data.nmID ?? data.nm_id;
      if (nmFromWb != null && String(nmFromWb).trim() !== '') {
        setFormData((prev) => ({ ...prev, sku_wb: String(nmFromWb).trim() }));
      }
      setWbSyncSuccess('Данные с Wildberries загружены в поля WB. Сохраните товар.');
    } catch (err) {
      const msg =
        err.response?.data?.message ??
        err.response?.data?.error ??
        err.message ??
        'Ошибка при загрузке данных с Wildberries.';
      setWbSyncError(msg);
    } finally {
      setWbSyncLoading(false);
    }
  }, [
    formData.sku_wb,
    formData.mp_wb_vendor_code,
    formData.sku_ozon,
    formData.organizationId,
    productsListOrganizationId,
    currentProduct?.mp_wb_vendor_code,
    currentProduct?.sku_ozon,
    mergeWbFetchedIntoForm
  ]);

  useEffect(() => {
    if (!Array.isArray(wbFetchedProduct?.characteristics) || wbFetchedProduct.characteristics.length === 0) return;
    setWbAttributeValues((prev) => mergeWbCharacteristicsIntoValues(wbFetchedProduct.characteristics, prev));
  }, [wbFetchedProduct]);

  const fetchYmProductInfo = useCallback(async () => {
    const organizationId = resolveKitPickerOrganizationId(
      formData.organizationId,
      productsListOrganizationId,
      currentProduct?.organization_id ?? currentProduct?.organizationId
    );
    const offerId =
      (formData.sku_ym != null && String(formData.sku_ym).trim() !== ''
        ? String(formData.sku_ym).trim()
        : null) ||
      (formData.sku != null && String(formData.sku).trim() !== '' ? String(formData.sku).trim() : null);
    if (!offerId) {
      setYmSyncError('Укажите offerId (артикул Яндекс.Маркет) или артикул.');
      return;
    }
    if (!organizationId) {
      setYmSyncError('Выберите организацию — данные запрашиваются из кабинета Яндекс.Маркета этой организации.');
      return;
    }
    setYmSyncError('');
    setYmSyncSuccess('');
    setYmSyncLoading(true);
    try {
      const data = await integrationsApi.getYandexProductInfo({ offer_id: offerId, organizationId });
      if (!data) {
        setYmSyncError('Товар не найден в кабинете Яндекс.Маркета выбранной организации.');
        return;
      }
      setYmFetchedProduct(data);
      setYmShowAllFields(true);
      const resolvedOfferId = String(data.offerId ?? offerId).trim();
      const name = data.name != null ? String(data.name).trim() : '';
      const description = data.description != null ? String(data.description).trim() : '';
      // YM API: weightDimensions в см / кг → ERP мм / г
      const dimsErp = ymWeightDimensionsToErp(data.weightDimensions);
      const countries = Array.isArray(data.manufacturerCountries) ? data.manufacturerCountries : [];
      const country = countries.map((c) => String(c || '').trim()).find(Boolean) || '';
      setFormData((prev) => {
        const next = { ...prev };
        if (resolvedOfferId) next.sku_ym = resolvedOfferId;
        if (data.marketSku != null && String(data.marketSku).trim() !== '') {
          next.ym_market_sku = String(data.marketSku).trim();
        }
        if (name) {
          next.mp_ym_name = name;
          // Если поле связано с YM — пишем и в «Основное», иначе на вкладке видно только name
          if (isMpFieldLinked(prev.mp_field_links, 'name', 'ym')) next.name = name;
        }
        if (description) {
          next.mp_ym_description = description;
          if (isMpFieldLinked(prev.mp_field_links, 'description', 'ym')) next.description = description;
        }
        if (data.vendor != null && String(data.vendor).trim() !== '') {
          const vendor = String(data.vendor).trim();
          if (!String(prev.brand || '').trim()) next.brand = vendor;
        }
        if (country) {
          const prevDraft =
            next.ym_draft && typeof next.ym_draft === 'object' && !Array.isArray(next.ym_draft)
              ? next.ym_draft
              : prev.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
                ? prev.ym_draft
                : {};
          next.ym_draft = { ...prevDraft, manufacturerCountries: [country] };
          if (isMpFieldLinked(prev.mp_field_links, 'country', 'ym')) {
            next.country_of_origin = country;
          } else if (!String(prev.country_of_origin || '').trim()) {
            next.country_of_origin = country;
          }
        }
        // Габариты: в ym_draft всегда; в ERP — только если связь dimensions↔ym
        if (data.weightDimensions && typeof data.weightDimensions === 'object') {
          const prevDraft =
            prev.ym_draft && typeof prev.ym_draft === 'object' && !Array.isArray(prev.ym_draft)
              ? prev.ym_draft
              : {};
          next.ym_draft = {
            ...prevDraft,
            weightDimensions: {
              length: data.weightDimensions.length,
              width: data.weightDimensions.width,
              height: data.weightDimensions.height,
              ...(data.weightDimensions.weight != null ? { weight: data.weightDimensions.weight } : {}),
            },
          };
        }
        if (dimsErp && isMpFieldLinked(prev.mp_field_links, 'dimensions', 'ym')) {
          if (dimsErp.length != null) next.length = String(dimsErp.length);
          if (dimsErp.width != null) next.width = String(dimsErp.width);
          if (dimsErp.height != null) next.height = String(dimsErp.height);
          if (dimsErp.weight != null) next.weight = String(dimsErp.weight);
        }
        return next;
      });
      if (Array.isArray(data.parameterValues) && data.parameterValues.length > 0) {
        // При явном «Обновить с YM» перезаписываем характеристики карточки
        // (кроме параметров, которые уже есть как dedicated-поля: страна, габариты, артикул производителя)
        const dupIds = new Set(
          (ymCategoryAttributes || [])
            .filter((a) => isYmParamDuplicatingDedicatedField(a?.name))
            .map((a) => String(a.id))
        );
        setYmAttributeValues((prev) => {
          const next = { ...prev };
          data.parameterValues.forEach((pv) => {
            const pid = pv?.parameterId ?? pv?.id;
            if (pid == null) return;
            const key = String(pid);
            const pname = pv?.parameterName ?? pv?.name ?? pv?.label ?? null;
            if (dupIds.has(key) || isYmParamDuplicatingDedicatedField(pname)) return;
            let val =
              pv?.valueId ??
              pv?.optionId ??
              pv?.dictionaryValueId ??
              pv?.value ??
              null;
            if (val != null && typeof val === 'object') {
              val = val.valueId ?? val.id ?? val.value ?? val.label ?? '';
            }
            if (val != null && String(val).trim() !== '') {
              next[key] = String(val).trim();
            }
          });
          return next;
        });
      }
      const attrCount = Array.isArray(data.parameterValues) ? data.parameterValues.length : 0;
      const parts = ['артикул', 'название', 'описание'];
      if (country) parts.push('страна');
      if (attrCount > 0) parts.push(`характеристики (${attrCount})`);
      if (dimsErp) parts.push('габариты и вес');
      else if (data.weightDimensions) parts.push('габариты (не распознаны)');
      setYmSyncSuccess(`Данные с Яндекс.Маркета загружены: ${parts.join(', ')}. Сохраните товар.`);
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message ?? 'Ошибка при загрузке данных с Яндекс.Маркета.';
      setYmSyncError(msg);
    } finally {
      setYmSyncLoading(false);
    }
  }, [formData.sku_ym, formData.sku, formData.organizationId, productsListOrganizationId, ymCategoryAttributes]);

  // Синхронизация формы с данными из блока «Данные с Ozon»: при появлении ozonFetchedProduct подставляем все атрибуты в поля формы
  useEffect(() => {
    const product = ozonFetchedProduct;
    if (!product?.id) return;
    const attrs = product.attributes ?? product.attribute_values;
    if (!Array.isArray(attrs) || attrs.length === 0) return;
    if (ozonSyncedFromFetchedRef.current === product.id) return;
    ozonSyncedFromFetchedRef.current = product.id;
    setOzonAttributeValues((prev) => {
      const next = { ...prev };
      attrs.forEach((a) => {
        const id = a.attribute_id ?? a.id;
        if (id == null) return;
        let val = null;
        if (a.values != null && Array.isArray(a.values) && a.values[0] != null) {
          const v = a.values[0];
          // Для текстовых полей (аннотация, название и т.д.) приоритет у текста value; для словарей — dictionary_value_id
          const asText = v.value != null && typeof v.value === 'string' ? v.value : (typeof v.value === 'string' ? v.value : null);
          val = asText ?? (v.dictionary_value_id != null ? v.dictionary_value_id : (v.value ?? v.id ?? v));
        } else {
          val = a.value ?? a.values;
        }
        if (val != null && typeof val === 'object' && !Array.isArray(val)) val = val.value ?? val.text ?? String(val);
        next[String(id)] = val != null ? String(val) : '';
      });
      return next;
    });
  }, [ozonFetchedProduct]);

  // Нормализация: в БД/Excel часто лежит подпись словаря, а селект Ozon хранит dictionary_value_id
  useEffect(() => {
    if (!ozonAttributes?.length || !Object.keys(ozonDictValues).length) return;
    let updated = null;
    ozonAttributes.forEach((attr) => {
      const hasDict = attr.dictionary_id != null && Number(attr.dictionary_id) !== 0;
      if (!hasDict) return;
      const options = ozonDictValues[attr.id];
      if (!Array.isArray(options) || options.length === 0) return;
      const currentVal = ozonAttributeValues[String(attr.id)];
      if (currentVal === undefined || currentVal === null || String(currentVal).trim() === '') return;
      const str = String(currentVal).trim();
      if (/^\d+$/.test(str)) return;
      const hit = findOzonDictEntryForStored(str, options);
      if (hit && String(hit.id) !== str) {
        if (updated === null) updated = { ...ozonAttributeValues };
        updated[String(attr.id)] = String(hit.id);
      }
    });
    if (updated != null) setOzonAttributeValues(updated);
  }, [ozonAttributes, ozonDictValues, ozonAttributeValues]);

  // Заполнить поля веса/габаритов, названия и аннотации на вкладке Ozon из данных карточки
  useEffect(() => {
    if (!ozonFetchedProduct || !ozonAttributes?.length) return;
    const productId = ozonFetchedProduct.id;
    if (ozonFilledFromProductIdRef.current === productId) return;
    ozonFilledFromProductIdRef.current = productId;
    const p = ozonFetchedProduct;
    const attrsFromApi = p.attributes ?? p.attribute_values ?? [];
    const annotationFromApi = (() => {
      const desc = p.description ?? p.description_html;
      if (desc && String(desc).trim()) return String(desc).trim();
      const a4191 = Array.isArray(attrsFromApi) && attrsFromApi.find((a) => Number(a.attribute_id ?? a.id) === 4191);
      if (a4191?.values?.[0] != null) return String(a4191.values[0].value ?? a4191.values[0].dictionary_value_id ?? '').trim();
      if (a4191?.value != null) return String(a4191.value).trim();
      const byName = Array.isArray(attrsFromApi) && attrsFromApi.find((a) => /аннотация|описание товара/i.test(String(a.name ?? '')));
      if (byName?.values?.[0] != null) return String(byName.values[0].value ?? byName.values[0].dictionary_value_id ?? '').trim();
      return '';
    })();
    const titleFromApi = (p.name ?? p.title ?? p.product_name ?? '').trim();
    const byName = {};
    ozonAttributes.forEach((attr) => {
      const name = (attr.name || '').toLowerCase();
      if (name.includes('вес товара') && !name.includes('упаковк')) byName[attr.id] = p.weight ?? p.weight_brutto;
      else if (name.includes('ширина')) byName[attr.id] = p.width ?? p.dimension_x;
      else if (name.includes('высота')) byName[attr.id] = p.height ?? p.dimension_y;
      else if (name.includes('длина')) byName[attr.id] = p.depth ?? p.dimension_z ?? p.length;
      else if (name === 'название' || (name.startsWith('название') && !name.includes('модели') && !name.includes('группы') && !name.includes('файла') && !name.includes('видео'))) byName[attr.id] = titleFromApi;
      else if (name.includes('аннотация') || (name.includes('описание') && name.includes('маркетинг'))) byName[attr.id] = annotationFromApi;
    });
    setOzonAttributeValues((prev) => {
      let next = prev;
      Object.entries(byName).forEach(([attrId, v]) => {
        if (v == null && v !== 0 && v !== '') return;
        const cur = prev[String(attrId)];
        if (cur !== undefined && cur !== null && String(cur).trim() !== '') return; // не перезаписываем уже заполненное
        if (next === prev) next = { ...prev };
        next[String(attrId)] = String(v);
      });
      return next;
    });
  }, [ozonFetchedProduct, ozonAttributes]);

  // Автоматический расчет объема при изменении габаритов
  useEffect(() => {
    const length = parseFloat(formData.length) || 0;
    const width = parseFloat(formData.width) || 0;
    const height = parseFloat(formData.height) || 0;
    
    if (length > 0 && width > 0 && height > 0) {
      // Объем в мм³, конвертируем в литры (1 литр = 1 000 000 мм³)
      const volumeLiters = (length * width * height) / 1000000;
      setCalculatedVolume(volumeLiters.toFixed(3));
    } else {
      setCalculatedVolume('');
    }
  }, [formData.length, formData.width, formData.height]);

  const applyBrandMarketplaceDefaults = useCallback((brandRow) => {
    if (!brandRow) return;
    const mappings = brandRow.marketplace_mappings ?? brandRow.marketplaceMappings ?? [];
    const byMp = {};
    for (const m of mappings) {
      byMp[String(m.marketplace || '').toLowerCase()] = m;
    }
    const manufacturerCountry = brandRow.manufacturer_country ?? brandRow.manufacturerCountry ?? '';

    setFormData((prev) => {
      const next = { ...prev };
      const oz = byMp.ozon;
      const wb = byMp.wb;
      // Не перезаписываем связанные поля — они зеркалят «Основное»
      if (oz?.mp_brand_name && !isMpFieldLinked(prev.mp_field_links, 'brand', 'ozon')) {
        next.mp_ozon_brand = String(oz.mp_brand_name);
      }
      if (wb?.mp_brand_name && !isMpFieldLinked(prev.mp_field_links, 'brand', 'wb')) {
        next.mp_wb_brand = String(wb.mp_brand_name);
      }
      if (manufacturerCountry && !String(prev.country_of_origin || '').trim()) {
        next.country_of_origin = String(manufacturerCountry);
      }
      return applyLinkedMpFieldsFromMain(next, next.mp_field_links, ['brand', 'country']);
    });

    const ozId = byMp.ozon?.mp_brand_id;
    if (ozId != null && String(ozId).trim() !== '') {
      setOzonAttributeValues((prev) => ({ ...prev, '85': String(ozId) }));
    }
  }, []);

  useEffect(() => {
    const country =
      selectedBrandForCert?.manufacturer_country ?? selectedBrandForCert?.manufacturerCountry ?? '';
    if (!country) return;

    const fillCountryAttrs = (attrs, setter, linked) => {
      if (!linked || !attrs?.length) return;
      setter((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const attr of attrs) {
          const key = String(attr.id);
          if (!isEmptyMarketplaceValue(next[key])) continue;
          const n = normalizeAttrName(attr?.name);
          if (!/(страна|country|производств)/i.test(n)) continue;
          next[key] = String(country);
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    fillCountryAttrs(ozonAttributes, setOzonAttributeValues, isMpFieldLinked(formData.mp_field_links, 'country', 'ozon'));
    fillCountryAttrs(wbCategoryAttributes, setWbAttributeValues, isMpFieldLinked(formData.mp_field_links, 'country', 'wb'));
    fillCountryAttrs(ymCategoryAttributes, setYmAttributeValues, isMpFieldLinked(formData.mp_field_links, 'country', 'ym'));
  }, [
    selectedBrandForCert,
    ozonAttributes,
    wbCategoryAttributes,
    ymCategoryAttributes,
    formData.mp_field_links,
  ]);

  useEffect(() => {
    const oz = mpMappingByMarketplace.ozon;
    if (!oz) return;
    if (oz.mp_brand_id != null && String(oz.mp_brand_id).trim() !== '') {
      const id = String(oz.mp_brand_id).trim();
      setOzonAttributeValues((prev) => {
        if (prev['85'] === id) return prev;
        return { ...prev, '85': id };
      });
    } else if (oz.mp_brand_name && ozonDictValues[85]?.length) {
      const name = String(oz.mp_brand_name).trim().toLowerCase();
      const hit = ozonDictValues[85].find(
        (v) => String(v.value ?? v.name ?? '').trim().toLowerCase() === name
      );
      if (hit?.id != null) {
        const id = String(hit.id);
        setOzonAttributeValues((prev) => ({ ...prev, '85': id }));
      }
    }
  }, [mpMappingByMarketplace, ozonDictValues]);

  const handleChange = (field, value) => {
    if (field === 'organizationId') {
      const org = organizations.find(o => String(o.id) === String(value));
      if (org?.article_prefix && !currentProduct) {
        setFormData(prev => {
          const next = { ...prev, organizationId: value };
          if (!prev.sku || String(prev.sku).trim() === '') next.sku = org.article_prefix;
          return next;
        });
      } else {
        setFormData(prev => ({ ...prev, [field]: value }));
      }
    } else if (field === 'minPrice') {
      minMarkupLastEditedRef.current = 'rub';
      setFormData((prev) => ({
        ...prev,
        minPrice: value,
        minMarkupPercent: minMarkupRubToPercent(value, prev.cost),
      }));
    } else if (field === 'minMarkupPercent') {
      minMarkupLastEditedRef.current = 'percent';
      setFormData((prev) => {
        const cost = parsePositiveCost(prev.cost);
        if (cost == null) {
          return { ...prev, minMarkupPercent: value };
        }
        const rub = value === '' || value == null ? '' : minMarkupPercentToRub(value, prev.cost);
        return {
          ...prev,
          minMarkupPercent: value,
          ...(rub !== '' || value === '' ? { minPrice: rub } : {}),
        };
      });
    } else if (field === 'cost') {
      setFormData((prev) => {
        const next = { ...prev, cost: value };
        const cost = parsePositiveCost(value);
        if (cost == null) {
          next.minMarkupPercent = '';
          return next;
        }
        if (minMarkupLastEditedRef.current === 'percent' && prev.minMarkupPercent !== '' && prev.minMarkupPercent != null) {
          const rub = minMarkupPercentToRub(prev.minMarkupPercent, value);
          if (rub !== '') next.minPrice = rub;
          next.minMarkupPercent = prev.minMarkupPercent;
        } else {
          next.minMarkupPercent = minMarkupRubToPercent(prev.minPrice, value);
        }
        return next;
      });
    } else {
      setFormData((prev) => {
        const next = { ...prev, [field]: value };
        const syncFields = [];
        if (field === 'name') syncFields.push('name');
        else if (field === 'sku') syncFields.push('sku');
        else if (field === 'description') syncFields.push('description');
        else if (field === 'brand') syncFields.push('brand');
        else if (field === 'country_of_origin') syncFields.push('country');
        else if (field === 'length' || field === 'width' || field === 'height' || field === 'weight') {
          syncFields.push('dimensions');
        }
        if (syncFields.length) {
          return applyLinkedMpFieldsFromMain(next, next.mp_field_links, syncFields);
        }
        return next;
      });
      // Габариты товара на Основном → характеристики предмета WB (см)
      const itemCharc =
        field === 'product_length'
          ? WB_ITEM_DIM_CHARC.length
          : field === 'product_width'
            ? WB_ITEM_DIM_CHARC.width
            : field === 'product_height'
              ? WB_ITEM_DIM_CHARC.height
              : null;
      if (itemCharc) {
        const cm = value === '' || value == null ? '' : (mmToCm(value) != null ? String(mmToCm(value)) : '');
        setWbAttributeValues((prev) => ({ ...prev, [itemCharc]: cm }));
      }
      // Вес товара → атрибуты Ozon «Вес товара» (без дубля в UI)
      if (field === 'product_weight') {
        setOzonAttributeValues((prev) => {
          let next = prev;
          for (const attr of ozonAttributes || []) {
            if (!isCoveredByDedicatedProductDimFields(attr?.name)) continue;
            const n = String(attr.name || '')
              .trim()
              .toLowerCase()
              .replace(/\s+/g, ' ');
            if (!/^вес\s+товар/.test(n)) continue;
            if (next === prev) next = { ...prev };
            next[String(attr.id)] = value === '' || value == null ? '' : String(value);
          }
          return next;
        });
      }
    }
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  /**
   * Текст карточки МП всегда редактируем (mp_*).
   * При связи с «Основным» — двусторонняя синхронизация только с Main (не с другими МП).
   */
  const handleMpCardFieldChange = useCallback((mpField, mainField, linkKey, mp, value) => {
    setFormData((prev) => {
      const next = { ...prev, [mpField]: value };
      if (!isMpFieldLinked(prev.mp_field_links, linkKey, mp)) return next;
      next[mainField] = value;
      return applyLinkedMpFieldsFromMain(next, next.mp_field_links, [linkKey]);
    });
  }, []);

  const handleYmPackagingDimChange = (field, value) => {
    setFormData((prev) => applyYmPackagingDimChange(prev, field, value));
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  /** Артикул на вкладке Ozon/WB: связь вкл. → Main.sku; выкл. → sku_ozon / mp_wb_vendor_code. */
  const handleMpSkuMetaChange = useCallback((mp, value) => {
    const code = String(mp || '').toLowerCase();
    setFormData((prev) => {
      if (isMpFieldLinked(prev.mp_field_links, 'sku', code)) {
        const next = { ...prev, sku: value };
        return applyLinkedMpFieldsFromMain(next, next.mp_field_links, ['sku']);
      }
      if (code === 'ozon') return { ...prev, sku_ozon: value };
      if (code === 'wb') return { ...prev, mp_wb_vendor_code: value };
      return prev;
    });
  }, []);

  const handleMpCountryMetaChange = useCallback((mp, value) => {
    const code = String(mp || '').toLowerCase();
    setFormData((prev) => {
      if (isMpFieldLinked(prev.mp_field_links, 'country', code)) {
        const next = { ...prev, country_of_origin: value };
        return applyLinkedMpFieldsFromMain(next, next.mp_field_links, ['country']);
      }
      return withMpDraftPatch(prev, code, { country: value });
    });
  }, []);

  /** Габариты Ozon/WB: в UI единицы МП; в форме/draft — мм/г. */
  const handleMpDimMetaChange = useCallback((mp, key, raw) => {
    const code = String(mp || '').toLowerCase();
    setFormData((prev) => {
      let mmVal = '';
      if (raw !== '' && raw != null) {
        if (code === 'wb' && key === 'weight') {
          const n = kgToGrams(raw);
          mmVal = n != null ? String(n) : '';
        } else if (code === 'wb' && key !== 'weight') {
          const n = cmToMm(raw);
          mmVal = n != null ? String(n) : '';
        } else {
          const n = Number(raw);
          mmVal = Number.isFinite(n) && n > 0 ? String(Math.round(n)) : '';
        }
      }
      let next;
      if (isMpFieldLinked(prev.mp_field_links, 'dimensions', code)) {
        next = { ...prev, [key]: mmVal };
        next = applyLinkedMpFieldsFromMain(next, next.mp_field_links, ['dimensions']);
      } else {
        const prevDims = getMpDraftDimensionsMm(prev, code) || {};
        const nextDims = { ...prevDims };
        if (mmVal === '') delete nextDims[key];
        else nextDims[key] = Number(mmVal);
        next = withMpDraftPatch(prev, code, { dimensions: nextDims });
      }
      return next;
    });
    // WB: зеркалим см в атрибуты упаковки
    if (code === 'wb' && key !== 'weight') {
      const charcId = WB_PACK_DIM_CHARC[key];
      if (charcId) {
        setWbAttributeValues((prev) => ({
          ...prev,
          [charcId]: raw === '' || raw == null ? '' : String(raw),
        }));
      }
    }
  }, []);

  const handleWbItemAttrChange = useCallback((charcId, raw) => {
    setWbAttributeValues((prev) => ({
      ...prev,
      [charcId]: raw === '' || raw == null ? '' : String(raw),
    }));
    const dimKey =
      String(charcId) === WB_ITEM_DIM_CHARC.length
        ? 'product_length'
        : String(charcId) === WB_ITEM_DIM_CHARC.width
          ? 'product_width'
          : String(charcId) === WB_ITEM_DIM_CHARC.height
            ? 'product_height'
            : null;
    if (!dimKey) return;
    const mm = raw === '' || raw == null ? '' : (cmToMm(raw) != null ? String(cmToMm(raw)) : '');
    setFormData((prev) => ({ ...prev, [dimKey]: mm }));
  }, []);

  const handleMpFieldLinkToggle = useCallback((fieldKey, mp) => {
    setFormData((prev) => {
      const links = toggleMpFieldLink(prev.mp_field_links, fieldKey, mp);
      let next = { ...prev, mp_field_links: links };
      if (isMpFieldLinked(links, fieldKey, mp)) {
        return applyLinkedMpFieldsFromMain(next, links, [fieldKey]);
      }
      // Выключили связь с «Основным»: зафиксировать текущее значение в своём хранилище МП
      if (fieldKey === 'dimensions' && mp === 'ym') {
        const existing = getYmDraftWeightDimensions(next);
        const hasDims =
          existing &&
          Number(existing.length) > 0 &&
          Number(existing.width) > 0 &&
          Number(existing.height) > 0;
        if (!hasDims) {
          const fromErp = erpDimsToYmWeightDimensions(next);
          if (fromErp) {
            const prevDraft =
              next.ym_draft && typeof next.ym_draft === 'object' && !Array.isArray(next.ym_draft)
                ? next.ym_draft
                : {};
            next = { ...next, ym_draft: { ...prevDraft, weightDimensions: fromErp } };
          }
        }
      }
      if (fieldKey === 'country' && mp === 'ym') {
        const draftC = getYmDraftCountry(next);
        if (!draftC && String(next.country_of_origin || '').trim()) {
          next = withYmDraftCountry(next, next.country_of_origin);
        }
      }
      if (fieldKey === 'dimensions' && (mp === 'ozon' || mp === 'wb')) {
        const existing = getMpDraftDimensionsMm(next, mp);
        const hasDims =
          existing &&
          Number(existing.length) > 0 &&
          Number(existing.width) > 0 &&
          Number(existing.height) > 0;
        if (!hasDims) {
          const dims = {
            length: next.length !== '' && next.length != null ? Number(next.length) : null,
            width: next.width !== '' && next.width != null ? Number(next.width) : null,
            height: next.height !== '' && next.height != null ? Number(next.height) : null,
            weight: next.weight !== '' && next.weight != null ? Number(next.weight) : null,
          };
          if (Number(dims.length) > 0 || Number(dims.width) > 0 || Number(dims.height) > 0) {
            next = withMpDraftPatch(next, mp, { dimensions: dims });
          }
        }
      }
      if (fieldKey === 'country' && (mp === 'ozon' || mp === 'wb')) {
        const draftC = getMpDraftCountry(next, mp);
        if (!draftC && String(next.country_of_origin || '').trim()) {
          next = withMpDraftPatch(next, mp, { country: String(next.country_of_origin).trim() });
        }
      }
      if (fieldKey === 'sku' && mp === 'ozon') {
        if (!String(next.sku_ozon || '').trim() && String(next.sku || '').trim()) {
          next = { ...next, sku_ozon: next.sku };
        }
      }
      if (fieldKey === 'sku' && mp === 'wb') {
        if (!String(next.mp_wb_vendor_code || '').trim() && String(next.sku || '').trim()) {
          next = { ...next, mp_wb_vendor_code: next.sku };
        }
      }
      return next;
    });
  }, []);

  const handleBrandSelect = useCallback(
    (brandName) => {
      const name = String(brandName || '').trim();
      setFormData((prev) => {
        const next = { ...prev, brand: name };
        return applyLinkedMpFieldsFromMain(next, next.mp_field_links, ['brand']);
      });
      if (!name) return;
      const local =
        brands.find((x) => String(x?.name || '').trim() === name) ||
        brands.find((x) => String(x?.name || '').trim().toLowerCase() === name.toLowerCase());
      if (local) {
        applyBrandMarketplaceDefaults(local);
        if (!local.marketplace_mappings && local.id) {
          brandsApi.getById(local.id).then((res) => {
            if (res?.data) applyBrandMarketplaceDefaults(res.data);
          }).catch(() => {});
        }
      }
    },
    [brands, applyBrandMarketplaceDefaults]
  );

  const mergeMpField = (prev, updated, key) =>
    Object.prototype.hasOwnProperty.call(updated, key) ? (updated[key] ?? '') : prev[key];

  const handleMarketplaceLinked = (updatedProduct) => {
    if (!updatedProduct) return;
    setCurrentProduct(updatedProduct);
    setFormData((prev) => ({
      ...prev,
      sku_ozon: mergeMpField(prev, updatedProduct, 'sku_ozon'),
      ozon_product_id:
        updatedProduct.ozon_product_id != null && updatedProduct.ozon_product_id !== ''
          ? String(updatedProduct.ozon_product_id)
          : mergeMpField(prev, updatedProduct, 'ozon_product_id'),
      sku_wb: mergeMpField(prev, updatedProduct, 'sku_wb'),
      mp_wb_vendor_code: mergeMpField(prev, updatedProduct, 'mp_wb_vendor_code'),
      sku_ym: mergeMpField(prev, updatedProduct, 'sku_ym'),
    }));
    onProductUpdate?.(updatedProduct);
  };

  const [pushCardLoading, setPushCardLoading] = useState(null);
  const [pushCardMessage, setPushCardMessage] = useState('');
  const [pushCardError, setPushCardError] = useState('');

  const formatPushCardResults = (data) => {
    const payload = data?.data ?? data;
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (results.length === 0) {
      return payload?.message || (payload?.ok ? 'Отправлено' : '');
    }
    return results
      .map((r) => {
        const label = r.marketplace === 'ozon' ? 'OZ' : r.marketplace === 'wb' ? 'WB' : r.marketplace === 'ym' ? 'YM' : r.marketplace;
        return `${label}: ${r.ok ? r.message || 'OK' : r.error || 'ошибка'}`;
      })
      .join(' · ');
  };

  const handlePushCard = async (marketplace) => {
    if (!currentProduct?.id) {
      setPushCardError('Сначала сохраните товар в ERP (кнопка «Сохранить» внизу формы).');
      return;
    }
    const productPatch = buildProductSubmitPayload();
    if (!productPatch) {
      setPushCardError('Исправьте ошибки в форме перед отправкой на маркетплейс.');
      return;
    }
    setPushCardLoading(marketplace);
    setPushCardError('');
    setPushCardMessage('');
    try {
      const body = await productsApi.pushCard(currentProduct.id, marketplace, productPatch);
      const payload = body?.data ?? body;
      const updated = payload?.product ?? body?.product;
      if (updated?.id) {
        setCurrentProduct(updated);
        onProductUpdate?.(updated);
      } else {
        try {
          const fresh = await productsApi.getById(currentProduct.id);
          const full = fresh?.data ?? fresh;
          if (full?.id) {
            setCurrentProduct(full);
            onProductUpdate?.(full);
          }
        } catch {
          /* push мог пройти без перечитывания */
        }
      }
      const text = formatPushCardResults(payload);
      const allFailed =
        Array.isArray(payload?.results) && payload.results.length > 0 && payload.results.every((r) => !r.ok);
      if (allFailed || payload?.ok === false) {
        setPushCardError(text || 'Не удалось отправить данные на маркетплейс');
      } else {
        setPushCardMessage(
          (text ? `${text}. ` : '') + 'Изменения сохранены в ERP и отправлены в кабинет маркетплейса.'
        );
        refreshMpBaselineFromState(
          formData,
          ozonAttributeValues,
          wbAttributeValues,
          ymAttributeValues
        );
      }
    } catch (e) {
      setPushCardError(e?.response?.data?.message || e?.message || 'Ошибка отправки на маркетплейс');
    } finally {
      setPushCardLoading(null);
    }
  };

  const handleBarcodeChange = (index, value) => {
    const next = coerceBarcodeString(value);
    setFormData((prev) => {
      const newBarcodes = prev.barcodes.map((row, i) =>
        i === index ? { ...row, barcode: next } : row
      );
      return { ...prev, barcodes: newBarcodes };
    });
  };

  const toggleBarcodeMarketplace = (index, mp) => {
    setFormData((prev) => {
      const newBarcodes = prev.barcodes.map((row, i) => {
        if (i !== index) return row;
        const mps = Array.isArray(row.marketplaces) ? [...row.marketplaces] : [];
        const has = mps.includes(mp);
        return {
          ...row,
          marketplaces: has ? mps.filter((x) => x !== mp) : [...mps, mp],
        };
      });
      return { ...prev, barcodes: newBarcodes };
    });
  };

  const handleUploadImages = useCallback(async (files) => {
    if (!currentProduct?.id) return;
    const arr = Array.from(files || []);
    if (!arr.length) return;
    setImageError('');
    setImageUploadLoading(true);
    try {
      const r = await productsApi.uploadImages(currentProduct.id, arr);
      let list = extractImagesFromApiPayload(r);
      if (list.length === 0 && arr.length > 0) {
        const fresh = await productsApi.getImages(currentProduct.id);
        list = extractImagesFromApiPayload(fresh);
      }
      setProductImages(normalizeProductImagesOrder(list));
    } catch (e) {
      setImageError(e?.response?.data?.error || e?.message || 'Ошибка загрузки изображений');
    } finally {
      setImageUploadLoading(false);
      if (imageFileInputRef.current) imageFileInputRef.current.value = '';
    }
  }, [currentProduct?.id]);

  const updateImageMarketplaces = useCallback(async (imageId, patch) => {
    if (!currentProduct?.id) return;
    const next = (productImages || []).map((img) => {
      const id = String(img?.id ?? img?.filename ?? '');
      if (id !== String(imageId)) return img;
      return { ...img, marketplaces: { ...(img.marketplaces || {}), ...(patch || {}) } };
    });
    const withPrimary = next.map((img, i) => ({ ...img, primary: i === 0 }));
    setProductImages(withPrimary);
    try {
      await productsApi.updateImages(currentProduct.id, withPrimary);
    } catch (_) {}
  }, [currentProduct?.id, productImages]);

  const deleteImage = useCallback(async (imageId) => {
    if (!currentProduct?.id) return;
    try {
      const r = await productsApi.deleteImage(currentProduct.id, imageId);
      const list = extractImagesFromApiPayload(r);
      setProductImages(normalizeProductImagesOrder(list));
    } catch (e) {
      setImageError(e?.response?.data?.error || e?.message || 'Ошибка удаления изображения');
    }
  }, [currentProduct?.id]);

  const persistImageOrder = useCallback(
    async (nextOrdered) => {
      if (!currentProduct?.id) return;
      const withPrimary = nextOrdered.map((img, i) => ({ ...img, primary: i === 0 }));
      setProductImages(withPrimary);
      try {
        await productsApi.updateImages(currentProduct.id, withPrimary);
      } catch (_) {}
    },
    [currentProduct?.id]
  );

  const handleImageDrop = useCallback(
    (e, targetIndex) => {
      e.preventDefault();
      const fromId = e.dataTransfer.getData('application/x-product-image-id');
      if (!fromId) return;
      const ids = productImages.map((img) => String(img?.id ?? img?.filename ?? ''));
      const fromIndex = ids.indexOf(fromId);
      if (fromIndex < 0 || fromIndex === targetIndex) return;
      const reordered = reorderImagesByIndex(productImages, fromIndex, targetIndex);
      persistImageOrder(reordered);
    },
    [productImages, persistImageOrder]
  );

  const handleImageDropAreaLeave = useCallback((e) => {
    const rel = e.relatedTarget;
    if (rel && e.currentTarget.contains(rel)) return;
    setImageDropActive(false);
  }, []);

  /** Файлы с диска → загрузка; иначе перестановка карточек. Всегда stopPropagation, чтобы родительская зона не ловила drop дважды. */
  const handleProductImageCardDrop = useCallback(
    (e, targetIndex) => {
      e.preventDefault();
      e.stopPropagation();
      setImageDropActive(false);
      const files = filterDroppedImageFiles(e.dataTransfer?.files);
      if (files.length) {
        handleUploadImages(files);
        return;
      }
      handleImageDrop(e, targetIndex);
    },
    [handleUploadImages, handleImageDrop]
  );

  const handleImageZoneDrop = useCallback(
    (e) => {
      e.preventDefault();
      setImageDropActive(false);
      const files = filterDroppedImageFiles(e.dataTransfer?.files);
      if (files.length) handleUploadImages(files);
    },
    [handleUploadImages]
  );

  const addBarcodeField = () => {
    setFormData(prev => ({ ...prev, barcodes: [...prev.barcodes, { ...EMPTY_BARCODE_ROW }] }));
  };

  const removeBarcodeField = (index) => {
    if (formData.barcodes.length > 1) {
      const newBarcodes = formData.barcodes.filter((_, i) => i !== index);
      setFormData(prev => ({ ...prev, barcodes: newBarcodes }));
    }
  };

  const updateKitComponent = (index, field, value) => {
    setFormData((prev) => {
      const next = [...prev.kit_components];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, kit_components: next };
    });
  };

  const addKitComponent = () => {
    setFormData((prev) => ({
      ...prev,
      kit_components: [...prev.kit_components, { productId: '', quantity: 1 }],
    }));
    if (kitModalOpen) {
      setKitRowsUi((prev) => [...prev, { query: '', results: [], loading: false, open: false }]);
    }
  };

  const removeKitComponent = (index) => {
    Object.values(kitSuggestTimersRef.current).forEach((t) => clearTimeout(t));
    kitSuggestTimersRef.current = {};
    kitSuggestGenByRowRef.current = {};

    const emptyRow = { productId: '', quantity: 1 };
    const emptyUi = { query: '', results: [], loading: false, open: false };

    setFormData((prev) => {
      const filtered = prev.kit_components.filter((_, i) => i !== index);
      if (filtered.length === 0) {
        return { ...prev, kit_components: [emptyRow] };
      }
      return { ...prev, kit_components: filtered };
    });
    setKitRowsUi((prev) => {
      const filtered = prev.filter((_, i) => i !== index);
      if (filtered.length === 0) {
        return [emptyUi];
      }
      return filtered;
    });
  };

  const scheduleKitRowSuggest = (index, rawQuery) => {
    const key = String(index);
    const pending = kitSuggestTimersRef.current[key];
    if (pending) clearTimeout(pending);

    const q = String(rawQuery || '').trim();
    if (!q) {
      setKitRowsUi((prev) => {
        const next = [...prev];
        if (!next[index]) return prev;
        next[index] = { ...next[index], results: [], loading: false };
        return next;
      });
      delete kitSuggestTimersRef.current[key];
      return;
    }

    kitSuggestTimersRef.current[key] = setTimeout(() => {
      void runKitRowSuggest(index, q);
    }, KIT_SUGGEST_DEBOUNCE_MS);
  };

  async function runKitRowSuggest(index, q) {
    const key = String(index);
    const gen = (kitSuggestGenByRowRef.current[key] || 0) + 1;
    kitSuggestGenByRowRef.current[key] = gen;

    setKitRowsUi((prev) => {
      const next = [...prev];
      if (!next[index]) return prev;
      next[index] = { ...next[index], loading: true, open: true };
      return next;
    });

    const { formOrganizationId, productsListOrganizationId: listOrgId, excludeProductId } =
      kitSearchDepsRef.current;
    const organizationId = resolveKitPickerOrganizationId(formOrganizationId, listOrgId);
    const excl = excludeProductId != null && excludeProductId !== '' ? String(excludeProductId) : '';

    try {
      setKitPickerError('');
      let raw = await productsApi.getAll({
        cacheBust: true,
        organizationId,
        limit: KIT_SUGGEST_LIMIT,
        offset: 0,
        search: q,
      });
      let list = normalizeProductsFromListPayload(raw);
      if (list.length === 0 && organizationId) {
        raw = await productsApi.getAll({
          cacheBust: true,
          limit: KIT_SUGGEST_LIMIT,
          offset: 0,
          search: q,
        });
        list = normalizeProductsFromListPayload(raw);
      }
      list = list.filter((p) => p && String(p.id) !== excl);

      if (kitSuggestGenByRowRef.current[key] !== gen) return;

      setKitRowsUi((prev) => {
        const next = [...prev];
        if (!next[index]) return prev;
        if (kitSuggestGenByRowRef.current[key] !== gen) return prev;
        next[index] = { ...next[index], results: list, loading: false, open: true };
        return next;
      });
    } catch (e) {
      if (kitSuggestGenByRowRef.current[key] !== gen) return;
      setKitRowsUi((prev) => {
        const next = [...prev];
        if (!next[index]) return prev;
        next[index] = { ...next[index], results: [], loading: false, open: true };
        return next;
      });
      setKitPickerError(
        e?.response?.data?.message ||
          e?.message ||
          'Не удалось загрузить подсказки.'
      );
    }
  }

  const handleKitRowQueryChange = (index, value) => {
    setKitRowsUi((prev) => {
      const next = [...prev];
      while (next.length <= index) {
        next.push({ query: '', results: [], loading: false, open: false });
      }
      next[index] = {
        ...(next[index] || { query: '', results: [], loading: false, open: false }),
        query: value,
        open: true,
      };
      return next;
    });

    const row = formData.kit_components[index];
    if (row?.productId) {
      const pool = [...products, ...kitPickerExtras];
      const p = pool.find((x) => String(x?.id) === String(row.productId));
      const fromPool = p ? formatKitProductLabel(p) : '';
      const fromHint =
        typeof row.kit_hint_label === 'string' ? String(row.kit_hint_label).trim() : '';
      const canonical = fromPool || fromHint;
      if (!canonical || String(value).trim() !== canonical.trim()) {
        setFormData((prev) => {
          const kc = [...prev.kit_components];
          const cur = kc[index] ? { ...kc[index], productId: '' } : null;
          if (!cur) return prev;
          delete cur.kit_hint_label;
          kc[index] = cur;
          return { ...prev, kit_components: kc };
        });
      }
    }

    scheduleKitRowSuggest(index, value);
  };

  const pickKitSuggestProduct = (index, picked) => {
    if (!picked?.id) return;
    const ex = kitSearchDepsRef.current.excludeProductId;
    if (ex != null && String(picked.id) === String(ex)) return;

    const key = String(index);
    if (kitSuggestTimersRef.current[key]) {
      clearTimeout(kitSuggestTimersRef.current[key]);
      delete kitSuggestTimersRef.current[key];
    }

    setFormData((prev) => {
      const kc = [...prev.kit_components];
      const cur = kc[index] ? { ...kc[index], productId: Number(picked.id) } : null;
      if (!cur) return prev;
      delete cur.kit_hint_label;
      kc[index] = cur;
      return { ...prev, kit_components: kc };
    });
    setKitRowsUi((prev) => {
      const next = [...prev];
      while (next.length <= index) {
        next.push({ query: '', results: [], loading: false, open: false });
      }
      next[index] = {
        query: formatKitProductLabel(picked),
        results: [],
        loading: false,
        open: false,
      };
      return next;
    });
    kitSuggestGenByRowRef.current[key] =
      (kitSuggestGenByRowRef.current[key] || 0) + 1;
  };

  /** Задержка, чтобы успел отработать mousedown по пункту подсказки до blur инпута */
  const closeKitSuggestDelayed = (index) => {
    setTimeout(() => {
      setKitRowsUi((prev) => {
        const next = [...prev];
        if (!next[index]) return prev;
        next[index] = { ...next[index], open: false };
        return next;
      });
    }, 220);
  };

  const handleAttributeChange = (attributeId, value) => {
    const key = String(attributeId);
    setFormData(prev => ({
      ...prev,
      attributeValues: { ...prev.attributeValues, [key]: value }
    }));
  };

  useEffect(() => {
    if (!kitModalOpen) {
      Object.values(kitSuggestTimersRef.current).forEach((t) => clearTimeout(t));
      kitSuggestTimersRef.current = {};
      kitSuggestGenByRowRef.current = {};
      kitModalWasOpenRef.current = false;
      setKitRowsUi([]);
      setKitPickerExtras([]);
      setKitPickerError('');
      return;
    }

    if (!kitModalWasOpenRef.current) {
      kitModalWasOpenRef.current = true;
      setKitPickerExtras([]);
      setKitPickerError('');
      const hasRows =
        Array.isArray(formData.kit_components) && formData.kit_components.length > 0;
      const seeded = hasRows
        ? [...formData.kit_components]
        : [{ productId: '', quantity: 1 }];
      if (!hasRows) {
        setFormData((prev) =>
          prev.kit_components?.length > 0
            ? prev
            : { ...prev, kit_components: [{ productId: '', quantity: 1 }] }
        );
      }
      setKitRowsUi(
        seeded.map((row) => {
          let q = '';
          if (row.productId) {
            const p = (products || []).find((x) => String(x?.id) === String(row.productId));
            if (p) q = formatKitProductLabel(p);
            else {
              const fromApi = typeof row.kit_hint_label === 'string' ? row.kit_hint_label.trim() : '';
              if (fromApi) q = fromApi;
            }
          }
          return { query: q, results: [], loading: false, open: false };
        })
      );
    }
  }, [kitModalOpen]);

  useEffect(() => {
    if (!kitModalOpen || !kitModalWasOpenRef.current) return undefined;
    setKitRowsUi((prev) => {
      const n = formData.kit_components.length;
      if (prev.length === n) return prev;
      const next = [...prev];
      while (next.length < n) next.push({ query: '', results: [], loading: false, open: false });
      return next.slice(0, n);
    });
    return undefined;
  }, [kitModalOpen, formData.kit_components.length]);

  useEffect(() => {
    if (!kitModalOpen || !kitModalWasOpenRef.current) return undefined;

    setKitRowsUi((prev) => {
      if (prev.length !== formData.kit_components.length) return prev;
      return prev.map((ui, i) => {
        const row = formData.kit_components[i];
        if (!row?.productId) return ui;
        if (ui.open && (ui.results?.length > 0 || ui.loading)) return ui;
        const pool = [...(products || []), ...kitPickerExtras];
        const p = pool.find((x) => String(x?.id) === String(row.productId));
        const fromPool = p ? formatKitProductLabel(p) : '';
        const fromHint =
          typeof row.kit_hint_label === 'string' ? String(row.kit_hint_label).trim() : '';
        const label = fromPool || fromHint;
        if (!label) return ui;
        if (label === ui.query) return ui;
        return { ...ui, query: label, results: [], open: false };
      });
    });
    return undefined;
  }, [kitModalOpen, kitPickerExtras, products, formData.kit_components]);

  useEffect(() => {
    if (!kitModalOpen) return undefined;
    const exclude = String(currentProduct?.id ?? '');
    const parentIds = new Set((products || []).map((p) => String(p?.id)));
    const extraIds = new Set((kitPickerExtras || []).map((p) => String(p?.id)));

    const ids = [...new Set(
      (formData.kit_components || [])
        .map((r) => r.productId)
        .filter((pid) => pid !== '' && pid != null && String(pid) !== exclude)
        .map((pid) => String(pid))
    )].filter((id) => !parentIds.has(id) && !extraIds.has(id));

    if (ids.length === 0) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const results = await Promise.all(
          ids.map(async (id) => {
            try {
              const raw = await productsApi.getById(id);
              const p = raw?.data ?? raw;
              return p && p.id != null ? p : null;
            } catch {
              return null;
            }
          })
        );
        const rows = results.filter(Boolean);
        if (cancelled || rows.length === 0) return;
        setKitPickerExtras((prev) => {
          const map = new Map(prev.map((p) => [String(p.id), p]));
          rows.forEach((p) => map.set(String(p.id), p));
          return Array.from(map.values());
        });
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [kitModalOpen, products, kitPickerExtras, formData.kit_components, currentProduct?.id]);

  const validate = () => {
    const newErrors = {};
    
    if (!formData.name || !formData.name.trim()) {
      newErrors.name = 'Введите название товара';
    }
    if (!formData.sku || !formData.sku.trim()) {
      newErrors.sku = 'Введите артикул';
    }
    if (!formData.categoryId) {
      newErrors.categoryId = 'Выберите категорию';
    }
    // Себестоимость не обязательна - она будет обновляться автоматически при синхронизации с поставщиками
    if (formData.cost && parseFloat(formData.cost) < 0) {
      newErrors.cost = 'Себестоимость не может быть отрицательной';
    }
    if (formData.additionalExpenses && parseFloat(formData.additionalExpenses) < 0) {
      newErrors.additionalExpenses = 'Дополнительные расходы не могут быть отрицательными';
    }
    const ozOffer = String(formData.sku_ozon || '').trim();
    if (ozOffer.length > MP_LINK_MAX.OZON_OFFER_ID) {
      newErrors.sku_ozon = `Ozon offer_id: не более ${MP_LINK_MAX.OZON_OFFER_ID} символов (Seller API)`;
    }
    const ozPidStr = String(formData.ozon_product_id || '').trim();
    if (ozPidStr !== '') {
      if (!/^\d{1,19}$/.test(ozPidStr)) {
        newErrors.ozon_product_id = 'Ozon product_id: только цифры, до 19 знаков (BIGINT)';
      }
    }
    const wbNm = String(formData.sku_wb || '').trim();
    if (wbNm.length > MP_LINK_MAX.WB_NMID) {
      newErrors.sku_wb = `Wildberries nmId: не более ${MP_LINK_MAX.WB_NMID} символов`;
    }
    const wbVendor = String(formData.mp_wb_vendor_code || '').trim();
    if (wbVendor.length > MP_LINK_MAX.WB_VENDOR_CODE) {
      newErrors.mp_wb_vendor_code = `WB vendorCode: не более ${MP_LINK_MAX.WB_VENDOR_CODE} символов`;
    }
    const ymOffer = String(formData.sku_ym || '').trim();
    if (ymOffer.length > MP_LINK_MAX.YM_OFFER_ID) {
      newErrors.sku_ym = `Яндекс Маркет offerId: не более ${MP_LINK_MAX.YM_OFFER_ID} символов (Partner API)`;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const buildProductSubmitPayload = () => {
    if (!validate()) {
      return null;
    }

    // Фильтруем пустые баркоды
    const filteredBarcodes = normalizeBarcodeRows(formData.barcodes);

    const toSku = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
    const trimOrNull = (s) => (s != null && String(s).trim() !== '' ? String(s).trim() : null);
    const attributeValuesPayload = (() => {
      const src = formData.attributeValues || {};
      const out = {};
      for (const [k, v] of Object.entries(src)) {
        if (v === undefined || v === null || v === '') continue;
        const key = String(k).trim();
        if (!key || !/^\d+$/.test(key)) continue;
        out[key] = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })();
    const ozonAttributesPayload = (() => {
      const out = {};
      for (const [k, v] of Object.entries(ozonAttributeValues)) {
        if (v === undefined || v === null || String(v).trim() === '') continue;
        const key = String(k).trim();
        if (!key) continue;
        const str = String(v).trim();
        const attr = ozonAttributes.find((a) => String(a.id) === key);
        const hasDict = attr && attr.dictionary_id != null && Number(attr.dictionary_id) !== 0;
        const opts = hasDict ? ozonDictValues[attr.id] : null;
        if (hasDict && Array.isArray(opts) && opts.length > 0) {
          const hit = findOzonDictEntryForStored(str, opts);
          out[key] = hit ? String(hit.id) : str;
        } else {
          out[key] = str;
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })();
    const wbAttributesPayload = (() => {
      const out = {};
      for (const [k, v] of Object.entries(wbAttributeValues)) {
        if (v === undefined || v === null) continue;
        const key = String(k).trim();
        if (!key) continue;
        const normalized = normalizeWbAttributeScalar(v);
        if (isEmptyMarketplaceValue(normalized)) continue;
        if (typeof normalized === 'string') {
          out[key] = normalized.trim();
        } else {
          out[key] = normalized;
        }
      }
      return Object.keys(out).length > 0 ? out : undefined;
    })();
    const payload = {
      name: formData.name.trim(),
      sku: formData.sku.trim(),
      product_type: formData.product_type || 'product',
      categoryId: formData.categoryId || null,
      organizationId: formData.organizationId && formData.organizationId.trim() !== '' ? formData.organizationId : null,
      ...(supplierBindingEnabled
        ? {
            supplierId:
              formData.supplierId && String(formData.supplierId).trim() !== ''
                ? formData.supplierId
                : null,
          }
        : {}),
      brand: formData.brand.trim() || null,
      country_of_origin: formData.country_of_origin.trim() || null,
      cost: formData.cost ? parseFloat(formData.cost) : null,
      additionalExpenses:
        formData.additionalExpenses !== '' && formData.additionalExpenses != null && !isNaN(parseFloat(formData.additionalExpenses))
          ? parseFloat(formData.additionalExpenses)
          : null,
      minPrice: (formData.minPrice !== '' && formData.minPrice != null && !isNaN(parseFloat(formData.minPrice)))
        ? parseFloat(formData.minPrice)
        : 50,
      minProfitOzon:
        formData.minProfitOzon !== '' && formData.minProfitOzon != null && !isNaN(parseFloat(formData.minProfitOzon))
          ? parseFloat(formData.minProfitOzon)
          : null,
      minProfitWb:
        formData.minProfitWb !== '' && formData.minProfitWb != null && !isNaN(parseFloat(formData.minProfitWb))
          ? parseFloat(formData.minProfitWb)
          : null,
      minProfitYm:
        formData.minProfitYm !== '' && formData.minProfitYm != null && !isNaN(parseFloat(formData.minProfitYm))
          ? parseFloat(formData.minProfitYm)
          : null,
      unit: 'шт',
      description: formData.description.trim() || null,
      sku_ozon: toSku(formData.sku_ozon),
      sku_wb: toSku(formData.sku_wb),
      sku_ym: toSku(formData.sku_ym),
      mp_ozon_name: trimOrNull(formData.mp_ozon_name),
      mp_ozon_description: trimOrNull(formData.mp_ozon_description),
      mp_ozon_brand: trimOrNull(formData.mp_ozon_brand),
      mp_wb_vendor_code: trimOrNull(sanitizeWbVendorCode(formData.mp_wb_vendor_code)),
      mp_wb_name: trimOrNull(formData.mp_wb_name),
      mp_wb_description: trimOrNull(formData.mp_wb_description),
      mp_wb_brand: trimOrNull(formData.mp_wb_brand),
      mp_ym_name: trimOrNull(formData.mp_ym_name),
      mp_ym_description: trimOrNull(formData.mp_ym_description),
      mp_field_links: normalizeMpFieldLinks(formData.mp_field_links),
      ozon_draft:
        formData.ozon_draft && typeof formData.ozon_draft === 'object' && !Array.isArray(formData.ozon_draft)
          ? formData.ozon_draft
          : {},
      wb_draft:
        formData.wb_draft && typeof formData.wb_draft === 'object' && !Array.isArray(formData.wb_draft)
          ? formData.wb_draft
          : {},
      ym_draft:
        formData.ym_draft && typeof formData.ym_draft === 'object' && !Array.isArray(formData.ym_draft)
          ? formData.ym_draft
          : {},
      buyout_rate: formData.buyout_rate ? parseFloat(formData.buyout_rate) : 95,
      barcodes: filteredBarcodes,
      weight: formData.weight ? parseFloat(formData.weight) : null,
      length: formData.length ? parseFloat(formData.length) : null,
      width: formData.width ? parseFloat(formData.width) : null,
      height: formData.height ? parseFloat(formData.height) : null,
      product_weight: formData.product_weight ? parseFloat(formData.product_weight) : null,
      product_length: formData.product_length ? parseFloat(formData.product_length) : null,
      product_width: formData.product_width ? parseFloat(formData.product_width) : null,
      product_height: formData.product_height ? parseFloat(formData.product_height) : null,
      volume: calculatedVolume ? parseFloat(calculatedVolume) : (formData.volume ? parseFloat(formData.volume) : null),
      kit_components: formData.product_type === 'kit' && Array.isArray(formData.kit_components)
        ? formData.kit_components.filter(c => c.productId).map(c => ({ productId: Number(c.productId), quantity: Math.max(1, parseInt(c.quantity, 10) || 1) }))
        : [],
      attribute_values: attributeValuesPayload,
      ozon_attributes: ozonAttributesPayload,
      wb_attributes: wbAttributesPayload,
      ym_attributes: (() => {
        const dupIds = new Set(
          (ymCategoryAttributes || [])
            .filter((a) => isYmParamDuplicatingDedicatedField(a?.name))
            .map((a) => String(a.id))
        );
        const cleaned = Object.fromEntries(
          Object.entries(ymAttributeValues || {}).filter(([k, v]) => {
            if (dupIds.has(String(k))) return false;
            return v != null && String(v).trim() !== '';
          })
        );
        return Object.keys(cleaned).length > 0 ? cleaned : undefined;
      })(),
      marketplace_ozon_product_id: (() => {
        const manual = String(formData.ozon_product_id || '').trim();
        if (manual !== '') {
          const n = Number(manual);
          return Number.isFinite(n) ? n : null;
        }
        if (syncedOzonProductId != null && Number.isFinite(Number(syncedOzonProductId))) {
          return Number(syncedOzonProductId);
        }
        const cur = currentProduct?.ozon_product_id;
        if (cur != null && cur !== '' && Number.isFinite(Number(cur))) return Number(cur);
        return null;
      })(),
      marketplace_ym_product_id: (() => {
        const manual = String(formData.ym_market_sku || '').trim();
        if (manual !== '' && /^\d+$/.test(manual)) return Number(manual);
        const cur = currentProduct?.ym_product_id ?? currentProduct?.ym_market_sku;
        if (cur != null && cur !== '' && /^\d+$/.test(String(cur))) return Number(cur);
        return null;
      })(),
    };

    return payload;
  };

  const refreshMpBaselineFromState = useCallback((fd, oz, wb, ym) => {
    mpBaselineRef.current = buildMpBaseline({
      fields: fd || formData,
      ozonAttrs: oz ?? ozonAttributeValues,
      wbAttrs: wb ?? wbAttributeValues,
      ymAttrs: ym ?? ymAttributeValues,
    });
  }, [formData, ozonAttributeValues, wbAttributeValues, ymAttributeValues]);

  const dirtyMarketplaces = useMemo(
    () =>
      getDirtyMarketplaces(
        mpBaselineRef.current,
        formData,
        ozonAttributeValues,
        wbAttributeValues,
        ymAttributeValues
      ),
    [formData, ozonAttributeValues, wbAttributeValues, ymAttributeValues]
  );

  const resolveOzonAttrDisplayForDiff = useCallback(
    (attr, raw) => {
      if (raw === undefined || raw === null || String(raw).trim() === '') return '';
      const hasDict = attr?.dictionary_id != null && Number(attr.dictionary_id) !== 0;
      if (hasDict) {
        const opts = ozonDictValues[attr.id];
        const hit = Array.isArray(opts) ? findOzonDictEntryForStored(raw, opts) : null;
        if (hit) return ozonDictEntryText(hit) || String(raw);
      }
      return String(raw);
    },
    [ozonDictValues]
  );

  const resolveYmAttrDisplayForDiff = useCallback((attr, raw) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return '';
    const str = String(raw).trim();
    const opts = Array.isArray(attr?.dictionary_options) ? attr.dictionary_options : [];
    if (opts.length > 0) {
      const byId = opts.find((o) => String(o.id) === str);
      if (byId) return String(byId.label ?? byId.value ?? byId.name ?? str);
      const byLabel = opts.find(
        (o) => String(o.label ?? o.value ?? '').trim().toLowerCase() === str.toLowerCase()
      );
      if (byLabel) return String(byLabel.label ?? byLabel.value ?? str);
    }
    return str;
  }, []);

  const mpAttrDisplayByName = useMemo(
    () =>
      buildMpAttrDisplayByName({
        ozonAttributes,
        ozonAttributeValues,
        resolveOzonDisplay: resolveOzonAttrDisplayForDiff,
        wbAttributes: wbCategoryAttributes,
        wbAttributeValues,
        wbAttrKey,
        wbAttrName,
        ymAttributes: ymFormAttributes,
        ymAttributeValues,
        resolveYmDisplay: resolveYmAttrDisplayForDiff,
      }),
    [
      ozonAttributes,
      ozonAttributeValues,
      resolveOzonAttrDisplayForDiff,
      wbCategoryAttributes,
      wbAttributeValues,
      wbAttrKey,
      wbAttrName,
      ymFormAttributes,
      ymAttributeValues,
      resolveYmAttrDisplayForDiff,
    ]
  );

  const mainCardFieldMpDiffs = useMemo(() => getMainCardFieldMpDiffs(formData), [formData]);

  const mpFieldClass = (base, fieldKey) =>
    `${base}${isMpFieldDirty(mpBaselineRef.current, fieldKey, formData[fieldKey]) ? ' mp-field-dirty' : ''}`;

  const mpAttrClass = (base, marketplace, attrId, value) =>
    `${base}${isMpAttrDirty(mpBaselineRef.current, marketplace, attrId, value) ? ' mp-field-dirty' : ''}`;

  const pushDirtyMarketplaces = async (productId, mps) => {
    const id = productId || currentProduct?.id;
    if (!id || !mps?.length) return { ok: true, skipped: true };
    const results = [];
    for (const mp of mps) {
      try {
        const body = await productsApi.pushCard(id, mp, null);
        const payload = body?.data ?? body;
        results.push({ marketplace: mp, ok: payload?.ok !== false, payload });
      } catch (e) {
        results.push({
          marketplace: mp,
          ok: false,
          error: e?.response?.data?.message || e?.message || String(e),
        });
      }
    }
    const failed = results.filter((r) => !r.ok);
    return { ok: failed.length === 0, results, failed };
  };

  const saveAndMaybePush = async ({ closeAfter = true, forceAskPush = false } = {}) => {
    const payload = buildProductSubmitPayload();
    if (!payload) return false;
    const dirtyMps = getDirtyMarketplaces(
      mpBaselineRef.current,
      formData,
      ozonAttributeValues,
      wbAttributeValues,
      ymAttributeValues
    );
    const saved = await onSubmit(payload, { close: false });
    const productId = saved?.id || currentProduct?.id;
    if (saved?.id) {
      setCurrentProduct(saved);
      onProductUpdate?.(saved);
    }
    if (dirtyMps.length > 0 && productId) {
      const names = formatDirtyMpList(dirtyMps);
      const shouldPush =
        forceAskPush ||
        window.confirm(
          `Изменены поля карточки: ${names}.\n\nОтправить эти изменения на маркетплейсы?`
        );
      if (shouldPush) {
        const pushResult = await pushDirtyMarketplaces(productId, dirtyMps);
        if (!pushResult.ok) {
          const detail = (pushResult.failed || [])
            .map((r) => `${MP_LABELS[r.marketplace] || r.marketplace}: ${r.error || 'ошибка'}`)
            .join('\n');
          alert(`Сохранено в ERP, но отправка на МП частично не удалась:\n${detail}`);
        } else {
          setPushCardMessage(`Изменения отправлены на ${names}.`);
        }
      }
    }
    refreshMpBaselineFromState(formData, ozonAttributeValues, wbAttributeValues, ymAttributeValues);
    if (closeAfter) {
      _onCancel?.();
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await saveAndMaybePush({ closeAfter: true, forceAskPush: false });
    } catch (err) {
      // onSubmit уже показывает alert при ошибке сохранения
      console.error('[ProductForm] save failed:', err);
    }
  };

  React.useImperativeHandle(ref, () => ({
    async requestClose() {
      const dirtyMps = getDirtyMarketplaces(
        mpBaselineRef.current,
        formData,
        ozonAttributeValues,
        wbAttributeValues,
        ymAttributeValues
      );
      if (dirtyMps.length === 0) {
        _onCancel?.();
        return true;
      }
      const names = formatDirtyMpList(dirtyMps);
      const savePush = window.confirm(
        `Есть несохранённые изменения полей МП (${names}).\n\nСохранить и отправить на маркетплейсы?`
      );
      if (savePush) {
        try {
          await saveAndMaybePush({ closeAfter: true, forceAskPush: true });
          return true;
        } catch {
          return false;
        }
      }
      const discard = window.confirm('Закрыть без сохранения изменений полей маркетплейсов?');
      if (discard) {
        _onCancel?.();
        return true;
      }
      return false;
    },
  }));

  const tabButtons = [
    { id: 'main', label: 'Основное' },
    { id: 'ozon', label: dirtyMarketplaces.includes('ozon') ? 'Ozon •' : 'Ozon' },
    { id: 'wb', label: dirtyMarketplaces.includes('wb') ? 'Wildberries •' : 'Wildberries' },
    { id: 'ym', label: dirtyMarketplaces.includes('ym') ? 'Яндекс.Маркет •' : 'Яндекс.Маркет' },
    { id: 'competitors', label: 'Конкуренты' },
  ];

  return (
    <>
    <form id={productFormDomId} className="product-form" onSubmit={handleSubmit}>
      <ul className="nav nav-tabs mb-3">
        {tabButtons.map((tab) => (
          <li key={tab.id} className="nav-item" role="presentation">
            <button
              type="button"
              className={`nav-link ${activeTab === tab.id ? 'active' : ''}${
                dirtyMarketplaces.includes(tab.id) ? ' nav-link--mp-dirty' : ''
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          </li>
        ))}
      </ul>

      {activeTab === 'main' && (
        <>
      <div className="row g-3">
        <div className="col-md-8">
          <MpFieldLabel
            htmlFor="name"
            fieldKey="name"
            links={formData.mp_field_links}
            onToggle={handleMpFieldLinkToggle}
            diffs={mainCardFieldMpDiffs.name}
            required
          >
            Название
          </MpFieldLabel>
        <input
          id="name"
          type="text"
            className="form-control form-control-sm"
          placeholder="Напр. Ручка гелевая"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />
        {errors.name && <div className="error">{errors.name}</div>}
      </div>

        <div className="col-md-4">
          <MpFieldLabel
            htmlFor="sku"
            fieldKey="sku"
            links={formData.mp_field_links}
            onToggle={handleMpFieldLinkToggle}
            diffs={mainCardFieldMpDiffs.sku}
            required
          >
            Артикул (SKU)
          </MpFieldLabel>
          {(() => {
            const selectedOrg = formData.organizationId ? organizations.find(o => String(o.id) === String(formData.organizationId)) : null;
            const skuPrefix = selectedOrg?.article_prefix || '';
            return (
              <>
                <input
                  id="sku"
                  type="text"
                  className="form-control form-control-sm"
                  placeholder={skuPrefix ? `${skuPrefix}001` : 'SKU-001'}
                  value={formData.sku}
                  onChange={(e) => handleChange('sku', e.target.value)}
                  required
                />
                {skuPrefix && (
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                    Префикс: <strong>{skuPrefix}</strong>
                  </div>
                )}
              </>
            );
          })()}
          {errors.sku && <div className="error">{errors.sku}</div>}
        </div>
      </div>

      <div className="mt-3">
        <MpFieldLabel
          htmlFor="description"
          fieldKey="description"
          links={formData.mp_field_links}
          onToggle={handleMpFieldLinkToggle}
          diffs={mainCardFieldMpDiffs.description}
        >
          Описание
        </MpFieldLabel>
        <textarea
          id="description"
          className="form-control form-control-sm"
          rows="6"
          placeholder="Краткое описание"
          value={formData.description}
          onChange={(e) => handleChange('description', e.target.value)}
        />
        <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '6px' }}>
          Символов: {String(formData.description || '').length}
        </div>
      </div>

      {/* Изображения — габариты упаковки перенесены в «Атрибуты категории» */}
      <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>
          🖼️ Изображения товара
        </h3>
        <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '12px' }}>
          Карточки перетаскивайте для порядка (первое — главное). Файлы с компьютера — в пунктирную область или на карточку; одна или несколько.
        </div>
        {!currentProduct?.id ? (
          <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Сначала сохраните товар, затем можно загружать изображения.</div>
        ) : (
          <>
            <input
              ref={imageFileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => handleUploadImages(e.target.files)}
              disabled={imageUploadLoading}
              style={{ display: 'none' }}
              aria-hidden="true"
              tabIndex={-1}
            />
            {imageError && <div className="error" style={{ marginBottom: '10px' }}>{imageError}</div>}
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                if (!dataTransferHasFiles(e.dataTransfer)) return;
                setImageDropActive(true);
              }}
              onDragLeave={handleImageDropAreaLeave}
              onDragOver={(e) => {
                e.preventDefault();
                if (dataTransferHasFiles(e.dataTransfer)) e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={handleImageZoneDrop}
              style={{
                border: `2px dashed ${imageDropActive ? 'rgba(129, 140, 248, 0.75)' : 'rgba(255,255,255,0.14)'}`,
                borderRadius: '12px',
                padding: '12px',
                background: imageDropActive ? 'rgba(99, 102, 241, 0.08)' : 'rgba(255,255,255,0.02)',
                transition: 'border-color 0.15s ease, background 0.15s ease',
              }}
            >
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: productImages.length ? '12px' : '0' }}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={imageUploadLoading}
                  onClick={() => imageFileInputRef.current?.click()}
                  style={{ fontSize: '12px' }}
                >
                  Добавить
                </Button>
                <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  или перетащите сюда фото (можно несколько)
                </span>
                {imageUploadLoading && <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Загрузка…</span>}
              </div>
              {productImages.length === 0 ? (
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--muted)',
                    textAlign: 'center',
                    padding: '28px 12px',
                  }}
                >
                  Пока нет изображений — выберите файлы или перетащите их в эту область.
                </div>
              ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-start' }}>
                {productImages.map((img, index) => {
                  const id = String(img?.id ?? img?.filename ?? '');
                  const url = img?.url || '';
                  const mp = img?.marketplaces || {};
                  const isMain = index === 0;
                  return (
                    <div
                      key={id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-product-image-id', id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.currentTarget.style.opacity = '0.65';
                      }}
                      onDragEnd={(e) => {
                        e.currentTarget.style.opacity = '1';
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = dataTransferHasFiles(e.dataTransfer) ? 'copy' : 'move';
                      }}
                      onDrop={(e) => handleProductImageCardDrop(e, index)}
                      style={{
                        width: '160px',
                        padding: '10px',
                        borderRadius: '10px',
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(255,255,255,0.02)',
                        cursor: 'grab',
                      }}
                    >
                      <div
                        style={{
                          position: 'relative',
                          borderRadius: '8px',
                          overflow: 'hidden',
                          width: '100%',
                          aspectRatio: '3 / 4',
                        }}
                      >
                        <button
                          type="button"
                          aria-label="Удалить изображение"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteImage(id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            zIndex: 3,
                            width: 28,
                            height: 28,
                            border: 'none',
                            borderRadius: '50%',
                            background: 'rgba(0,0,0,0.55)',
                            color: '#fff',
                            fontSize: '18px',
                            lineHeight: 1,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                          }}
                        >
                          ×
                        </button>
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            draggable={false}
                            onDragStart={(e) => e.preventDefault()}
                            style={{ display: 'block', width: '100%', height: '100%' }}
                          >
                            <img
                              src={url}
                              alt=""
                              draggable={false}
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                                display: 'block',
                                border: '1px solid rgba(255,255,255,0.06)',
                              }}
                            />
                          </a>
                        ) : (
                          <div style={{ width: '100%', height: '100%', minHeight: 0, background: 'rgba(255,255,255,0.03)' }} />
                        )}
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            zIndex: 2,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                            padding: '8px 6px 6px',
                            background: 'linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.4) 55%, transparent 100%)',
                            pointerEvents: 'none',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              minWidth: 24,
                              pointerEvents: 'none',
                            }}
                          >
                            {isMain ? (
                              <span
                                title="Главное фото"
                                aria-label="Главное фото"
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.45)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                                  <path
                                    fill="#fbbf24"
                                    d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                                  />
                                </svg>
                              </span>
                            ) : (
                              <span style={{ width: 28, height: 28 }} aria-hidden="true" />
                            )}
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              gap: 3,
                              pointerEvents: 'auto',
                              flexShrink: 0,
                            }}
                          >
                            <ProductImageMpToggle
                              active={mp.ozon !== false}
                              title="Использовать на Ozon"
                              color="#005bff"
                              onToggle={() => updateImageMarketplaces(id, { ozon: !(mp.ozon !== false) })}
                            >
                              Oz
                            </ProductImageMpToggle>
                            <ProductImageMpToggle
                              active={mp.wb !== false}
                              title="Использовать на Wildberries"
                              color="#cb11ab"
                              onToggle={() => updateImageMarketplaces(id, { wb: !(mp.wb !== false) })}
                            >
                              WB
                            </ProductImageMpToggle>
                            <ProductImageMpToggle
                              active={mp.ym !== false}
                              title="Использовать на Яндекс.Маркет"
                              color="#fc0"
                              textColor="#111"
                              onToggle={() => updateImageMarketplaces(id, { ym: !(mp.ym !== false) })}
                            >
                              Я
                            </ProductImageMpToggle>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="row g-3 mt-1 align-items-end">
        <div className="col-12 col-md-3">
          <label className="form-label" htmlFor="productType">
          Тип товара
        </label>
        {!kitsEnabled && formData.product_type === 'kit' ? (
          <div className="form-control form-control-sm bg-light" id="productType">
            Комплект (отключено в настройках аккаунта)
          </div>
        ) : (
        <select
          id="productType"
            className="form-select form-select-sm"
          value={formData.product_type}
          onChange={(e) => handleChange('product_type', e.target.value)}
        >
          <option value="product">Товар</option>
          {kitsEnabled ? <option value="kit">Комплект</option> : null}
        </select>
        )}
      </div>
        <div className="col-12 col-md-auto">
      {kitsEnabled && formData.product_type === 'kit' && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setFormData((prev) => {
                  if (prev.product_type !== 'kit') return prev;
                  if (prev.kit_components?.length > 0) return prev;
                  return { ...prev, kit_components: [{ productId: '', quantity: 1 }] };
                });
                setKitModalOpen(true);
              }}
              style={{ whiteSpace: 'nowrap' }}
            >
              {formData.kit_components?.length ? `Комплектующие (${formData.kit_components.length})` : 'Указать комплектующие'}
            </Button>
          )}
        </div>
      </div>

      <Modal
        isOpen={kitModalOpen}
        onClose={() => setKitModalOpen(false)}
        title="Комплектующие"
        size="large"
        usePortal
      >
        <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
          В каждой строке введите название, артикул или штрихкод и выберите товар из подсказок. Рядом укажите количество.
        </p>
        {kitPickerError ? (
          <div className="text-danger small mb-2">{kitPickerError}</div>
        ) : null}
        <div className="d-flex flex-column gap-2 kit-components-modal-rows">
          {formData.kit_components.map((row, index) => {
            const ui = kitRowsUi[index] || { query: '', results: [], loading: false, open: false };
            const qTrim = String(ui.query || '').trim();
            const showDropdown = ui.open && (ui.loading || qTrim.length > 0);
            return (
              <div key={index} className="position-relative kit-picker-row">
                <div className="d-flex flex-wrap align-items-center gap-2">
                  <div className="flex-grow-1" style={{ minWidth: '200px', maxWidth: '100%' }}>
                    <input
                      type="text"
                      className="form-control form-control-sm kit-picker-input"
                      placeholder="Название, артикул или штрихкод…"
                      value={ui.query}
                      onChange={(e) => handleKitRowQueryChange(index, e.target.value)}
                      onFocus={() =>
                        setKitRowsUi((prev) => {
                          const next = [...prev];
                          while (next.length <= index) {
                            next.push({ query: '', results: [], loading: false, open: false });
                          }
                          next[index] = { ...next[index], open: true };
                          return next;
                        })
                      }
                      onBlur={() => closeKitSuggestDelayed(index)}
                      autoComplete="off"
                      {...(index === 0 ? { autoFocus: true } : {})}
                    />
                    {showDropdown ? (
                      <ul
                        className="list-group kit-suggest-list shadow-sm border rounded mt-1"
                        role="listbox"
                        style={{
                          position: 'absolute',
                          zIndex: 1080,
                          left: 0,
                          right: 0,
                          maxHeight: 220,
                          overflowY: 'auto',
                        }}
                      >
                        {ui.loading ? (
                          <li className="list-group-item list-group-item-action py-2 small text-muted">Загрузка…</li>
                        ) : (ui.results || []).length === 0 ? (
                          <li className="list-group-item list-group-item-action py-2 small text-muted">
                            Ничего не найдено
                          </li>
                        ) : null}
                        {!ui.loading
                          ? (ui.results || []).map((p) => (
                              <li
                                key={p.id}
                                className="list-group-item list-group-item-action py-2 small"
                                role="option"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  pickKitSuggestProduct(index, p);
                                }}
                              >
                                {formatKitProductLabel(p)}
                              </li>
                            ))
                          : null}
                      </ul>
                    ) : null}
                  </div>
                  <input
                    type="number"
                    className="form-control form-control-sm"
                    min={1}
                    step={1}
                    value={row.quantity}
                    onChange={(e) => updateKitComponent(index, 'quantity', e.target.value)}
                    placeholder="Кол-во"
                    style={{ width: '88px' }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => removeKitComponent(index)}
                    style={{ padding: '8px 12px', color: '#fca5a5', borderColor: '#fca5a5' }}
                  >
                    ✕
                  </Button>
                </div>
              </div>
            );
          })}
          {formData.kit_components.length >= 1 ? (
            <Button type="button" variant="secondary" onClick={addKitComponent} style={{ alignSelf: 'flex-start' }}>
              + Добавить комплектующее
            </Button>
          ) : null}
        </div>
      </Modal>

      <div className="row g-3 mt-1">
        <div className="col-md-6">
          <label className="form-label" htmlFor="productCategory">
            Категория <span style={{color: '#ef4444'}}>*</span>
          </label>
          <select
            id="productCategory"
            className="form-select form-select-sm"
            value={formData.categoryId}
            onChange={(e) => handleChange('categoryId', e.target.value)}
            required
          >
            <option value="">-- Выберите категорию --</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
          {errors.categoryId && <div className="error">{errors.categoryId}</div>}
        </div>

        <div className="col-md-6">
          <label className="form-label" htmlFor="productOrganization">Организация</label>
          <select
            id="productOrganization"
            className="form-select form-select-sm"
            value={formData.organizationId}
            onChange={(e) => handleChange('organizationId', e.target.value)}
          >
            <option value="">-- Без организации --</option>
            {organizations.map(org => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>

        {supplierBindingEnabled ? (
          <div className="col-md-6">
            <label className="form-label" htmlFor="productSupplier">Поставщик</label>
            <select
              id="productSupplier"
              className="form-select form-select-sm"
              value={formData.supplierId}
              onChange={(e) => handleChange('supplierId', e.target.value)}
            >
              <option value="">— Не привязан —</option>
              {[...(suppliers || [])]
                .filter((s) => s && (s.isActive !== false && s.active !== false))
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
                .map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name || `Поставщик #${s.id}`}
                  </option>
                ))}
            </select>
          </div>
        ) : null}

        <div className="col-md-6">
          <MpFieldLabel
            htmlFor="brand"
            fieldKey="brand"
            links={formData.mp_field_links}
            onToggle={handleMpFieldLinkToggle}
            diffs={mainCardFieldMpDiffs.brand}
          >
            Бренд
          </MpFieldLabel>
            <select
              id="brand"
            className="form-select form-select-sm"
              value={formData.brand}
              onChange={(e) => handleBrandSelect(e.target.value)}
            >
              <option value="">-- Выберите бренд --</option>
              {brands.map(brand => (
                <option key={brand.id || brand.name} value={brand.name}>
                  {brand.name}
                </option>
              ))}
            </select>
          </div>
        <div className="col-md-6">
          <MpFieldLabel
            htmlFor="country_of_origin"
            fieldKey="country"
            links={formData.mp_field_links}
            onToggle={handleMpFieldLinkToggle}
            diffs={mainCardFieldMpDiffs.country}
          >
            Страна производства
          </MpFieldLabel>
          <input
            id="country_of_origin"
            type="text"
            className="form-control form-control-sm"
            value={formData.country_of_origin}
            onChange={(e) => handleChange('country_of_origin', e.target.value)}
            placeholder="Начните вводить страну"
            list="country-of-origin-list"
          />
          <datalist id="country-of-origin-list">
            {COUNTRY_OPTIONS.map((country) => (
              <option key={country} value={country} />
            ))}
          </datalist>
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Можно выбрать из словаря или ввести вручную.
          </div>
        </div>
      </div>

      <div style={{ marginTop: '12px', padding: '12px', background: 'rgba(59, 130, 246, 0.06)', borderRadius: '8px', border: '1px solid var(--border, #e5e7eb)' }}>
        <h4
          style={{
            fontSize: '13px',
            fontWeight: 600,
            marginBottom: '10px',
            color: 'var(--text)',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '4px 8px',
          }}
        >
          <span>Габариты</span>
          <MpFieldLinkToggles
            fieldKey="dimensions"
            links={formData.mp_field_links}
            onToggle={handleMpFieldLinkToggle}
          />
          <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>
            Тумблеры OZ/WB/ЯМ — связь упаковки с МП (не между МП)
          </span>
        </h4>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Габариты товара</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
          Размеры самого товара без упаковки (мм / г). На WB зеркалятся в характеристики предмета.
        </div>
        <div className="row g-3 mb-3">
          <div className="col-6 col-md-3">
            <label className="form-label" htmlFor="product_length">Длина товара (мм)</label>
            <input
              id="product_length"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              value={formData.product_length}
              onChange={(e) => handleChange('product_length', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-3">
            <label className="form-label" htmlFor="product_width">Ширина товара (мм)</label>
            <input
              id="product_width"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              value={formData.product_width}
              onChange={(e) => handleChange('product_width', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-3">
            <label className="form-label" htmlFor="product_height">Высота товара (мм)</label>
            <input
              id="product_height"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              value={formData.product_height}
              onChange={(e) => handleChange('product_height', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-3">
            <label className="form-label" htmlFor="product_weight">Вес товара (г)</label>
            <input
              id="product_weight"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              value={formData.product_weight}
              onChange={(e) => handleChange('product_weight', e.target.value)}
            />
          </div>
          <DimVolumeReadonly
            id="main-product-volume"
            unit="mm"
            length={formData.product_length}
            width={formData.product_width}
            height={formData.product_height}
          />
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Габариты упаковки</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
          ERP: мм и г. Идут в логистику МП при включённой связи.
        </div>
        <div className="row g-3 mb-3">
          <div className="col-6 col-md-2">
            <label className="form-label" htmlFor="length">
              Длина упаковки (мм)
            </label>
            <input
              id="length"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="150"
              value={formData.length}
              onChange={(e) => handleChange('length', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label" htmlFor="width">
              Ширина упаковки (мм)
            </label>
            <input
              id="width"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="100"
              value={formData.width}
              onChange={(e) => handleChange('width', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label" htmlFor="height">
              Высота упаковки (мм)
            </label>
            <input
              id="height"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="50"
              value={formData.height}
              onChange={(e) => handleChange('height', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-3">
            <label className="form-label" htmlFor="weight">
              Вес с упаковкой (г)
            </label>
            <input
              id="weight"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="250"
              value={formData.weight}
              onChange={(e) => handleChange('weight', e.target.value)}
            />
          </div>
          <div className="col-6 col-md-3">
            <div className="form-label">Объём (л)</div>
            <div
              role="status"
              aria-live="polite"
              style={{
                minHeight: '31px',
                display: 'flex',
                alignItems: 'center',
                padding: '0.25rem 0',
                fontSize: '0.9375rem',
                fontWeight: 600,
                color: calculatedVolume ? 'var(--text)' : 'var(--muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {calculatedVolume ? `${calculatedVolume} л` : '—'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
              Из габаритов упаковки
            </div>
          </div>
        </div>
      </div>

      {categoryAttributes.length > 0 && (
        <div style={{ marginTop: '12px', padding: '12px', background: 'rgba(59, 130, 246, 0.06)', borderRadius: '8px', border: '1px solid var(--border, #e5e7eb)' }}>
          <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text)' }}>
            Атрибуты категории
            <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>
              OZ/WB/ЯМ с обводкой = другое значение на МП
            </span>
          </h4>
          <div className="row g-3">
            {categoryAttributes.map((attr) => {
              const key = String(attr.id);
              const value = formData.attributeValues[key];
              const rawValue = value !== undefined && value !== null ? value : '';
              const attrDiffs = getMainAttrMpDiffs(attr.name, rawValue, mpAttrDisplayByName);
              const nameWithDiff = (
                <>
                  {attr.name}
                  <MpValueDiffBadges diffs={attrDiffs} />
                </>
              );
              if (attr.type === 'checkbox') {
                const checked = rawValue === 'true' || rawValue === true;
                return (
                  <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                    <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', flexWrap: 'wrap' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => handleAttributeChange(attr.id, e.target.checked ? 'true' : 'false')}
                      />
                      <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                        {nameWithDiff}
                        {TYPE_LABELS[attr.type] && <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span>}
                      </span>
                    </label>
                  </div>
                );
              }
              if (attr.type === 'number') {
                return (
                  <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                    <label className="label" htmlFor={`attr-${attr.id}`} style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                      {nameWithDiff} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span>
                    </label>
                    <input
                      id={`attr-${attr.id}`}
                      type="number"
                      className="form-control form-control-sm"
                      value={rawValue}
                      onChange={(e) => handleAttributeChange(attr.id, e.target.value)}
                    />
                  </div>
                );
              }
              if (attr.type === 'date') {
                return (
                  <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                    <label className="label" htmlFor={`attr-${attr.id}`} style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                      {nameWithDiff} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span>
                    </label>
                    <input
                      id={`attr-${attr.id}`}
                      type="date"
                      className="form-control form-control-sm"
                      value={rawValue}
                      onChange={(e) => handleAttributeChange(attr.id, e.target.value)}
                    />
                  </div>
                );
              }
              if (attr.type === 'dictionary') {
                const dictRaw = Array.isArray(attr.dictionary_values) ? attr.dictionary_values : [];
                const dictStr = dictRaw.map((x) => String(x));
                const storedStr = rawValue === undefined || rawValue === null ? '' : String(rawValue);
                const trimmed = storedStr.trim();
                const inDictionary = trimmed === ''
                  ? false
                  : dictStr.some((o) => o === storedStr || String(o).trim() === trimmed);
                const merged = trimmed && !inDictionary ? [...dictStr, storedStr] : [...dictStr];
                const options = [...new Set(merged.map(String))].sort((a, b) => a.localeCompare(b, 'ru'));
                return (
                  <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                    <label className="label" htmlFor={`attr-${attr.id}`} style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                      {nameWithDiff} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span>
                    </label>
                    <select
                      id={`attr-${attr.id}`}
                      className="form-select form-select-sm"
                      value={storedStr}
                      onChange={(e) => handleAttributeChange(attr.id, e.target.value)}
                    >
                      <option value="">— Не выбрано —</option>
                      {options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                    {trimmed && !inDictionary && (
                      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                        Значение задано вручную (нет в словаре); при сохранении оно запишется как есть.
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                  <label className="label" htmlFor={`attr-${attr.id}`} style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                    {nameWithDiff} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type] || 'Текст'})</span>
                  </label>
                  <input
                    id={`attr-${attr.id}`}
                    type="text"
                    className="form-control form-control-sm"
                    value={rawValue}
                    onChange={(e) => handleAttributeChange(attr.id, e.target.value)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SKU перенесён рядом с названием в верхнюю строку */}

      {/* Процент выкупа */}
      <div style={{marginTop: '12px'}}>
        <h4 style={{fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px'}}>
          📊 Процент выкупа
        </h4>
        <div style={{marginTop: '8px'}}>
          <label className="form-label" htmlFor="buyout_rate" style={{fontSize: '12px'}}>
            <span style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}>
              <span style={{background: '#10b981', color: '#fff', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', fontWeight: 600}}>%</span>
              Общий процент выкупа (средний)
            </span>
          </label>
          <input
            id="buyout_rate"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 160 }}
            min="0"
            max="100"
            step="0.1"
            value={formData.buyout_rate}
            onChange={(e) => handleChange('buyout_rate', e.target.value)}
            placeholder="95"
          />
          <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '4px'}}>
            Используется для расчетов. Можно изменить вручную.
          </div>
        </div>
      </div>

      {/* Баркоды */}
      <div style={{marginTop: '12px'}}>
        <h4 style={{fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text)'}}>
          🏷️ Баркоды
          <Button
            type="button"
            variant="secondary"
            onClick={addBarcodeField}
            style={{padding: '4px 12px', fontSize: '11px', marginLeft: '8px'}}
          >
            + Добавить баркод
          </Button>
        </h4>
        <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '8px' }}>
          Отметьте маркетплейс на ШК — он будет использоваться при печати этикеток в поставках FBO.
          Без отметки — внутренний штрихкод.
          {Array.isArray(currentProduct?.barcodes) &&
          currentProduct.barcodes.some((b) => isCorruptBarcodeString(b?.barcode ?? b)) ? (
            <span style={{ display: 'block', marginTop: 6, color: '#f59e0b' }}>
              В базе есть битая запись штрихкода (object). Введите правильный код и сохраните карточку — битая строка будет удалена.
            </span>
          ) : null}
        </div>
        <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
          {formData.barcodes.map((row, index) => (
            <div key={index} style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Введите баркод (EAN, UPC и т.д.)"
                value={coerceBarcodeString(row.barcode)}
                onChange={(e) => handleBarcodeChange(index, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                style={{flex: 1}}
              />
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                {BARCODE_MP_TOGGLES.map((mp) => {
                  const active = (row.marketplaces || []).includes(mp.code);
                  return (
                    <MarketplaceToggle
                      key={mp.code}
                      active={active}
                      title={mp.title}
                      color={mp.color}
                      onToggle={() => toggleBarcodeMarketplace(index, mp.code)}
                    >
                      {mp.label}
                    </MarketplaceToggle>
                  );
                })}
              </div>
              {formData.barcodes.length > 1 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => removeBarcodeField(index)}
                  style={{padding: '8px 12px', fontSize: '12px', color: '#fca5a5', borderColor: '#fca5a5'}}
                >
                  ✕
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="row g-3 mt-2">
        <div className="col-md-3">
          <label className="form-label" htmlFor="cost">
          Себестоимость
        </label>
        <input
          id="cost"
          type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
          step="0.01"
          min="0"
          placeholder="0.00"
          value={formData.cost}
          onChange={(e) => handleChange('cost', e.target.value)}
        />
        <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '4px'}}>
            Обновляется при синхронизации с поставщиками
        </div>
        {errors.cost && <div className="error">{errors.cost}</div>}
      </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="additionalExpenses">
            Дополнительные расходы
          </label>
          <input
            id="additionalExpenses"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="0.00"
            value={formData.additionalExpenses}
            onChange={(e) => handleChange('additionalExpenses', e.target.value)}
          />
          <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '4px'}}>
            Упаковка, логистика и т.п. (не себестоимость)
          </div>
          {errors.additionalExpenses && <div className="error">{errors.additionalExpenses}</div>}
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minPrice">Мин. наценка (частные), ₽</label>
        <input
          id="minPrice"
          type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
          step="0.01"
          min="0"
          placeholder="50"
          value={formData.minPrice}
          onChange={(e) => handleChange('minPrice', e.target.value)}
        />
        <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '4px'}}>
            Целевая прибыль для частных (ручных) заказов
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minMarkupPercent">Мин. наценка (частные), %</label>
          <input
            id="minMarkupPercent"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder={parsePositiveCost(formData.cost) == null ? '—' : '0'}
            value={formData.minMarkupPercent}
            disabled={parsePositiveCost(formData.cost) == null}
            onChange={(e) => handleChange('minMarkupPercent', e.target.value)}
          />
          <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '4px'}}>
            {parsePositiveCost(formData.cost) == null
              ? 'Укажите себестоимость, чтобы задать %'
              : '% от себестоимости (для частных заказов)'}
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minProfitOzon">Мин. наценка Ozon, ₽</label>
          <input
            id="minProfitOzon"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="как общая"
            value={formData.minProfitOzon}
            onChange={(e) => handleChange('minProfitOzon', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Для расчёта мин. цены Ozon (пусто — общая)
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minProfitWb">Мин. наценка WB, ₽</label>
          <input
            id="minProfitWb"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="как общая"
            value={formData.minProfitWb}
            onChange={(e) => handleChange('minProfitWb', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Для расчёта мин. цены Wildberries (пусто — общая)
          </div>
        </div>

        <div className="col-md-3">
          <label className="form-label" htmlFor="minProfitYm">Мин. наценка Я.Маркет, ₽</label>
          <input
            id="minProfitYm"
            type="number"
            className="form-control form-control-sm"
            style={{ maxWidth: 200 }}
            step="0.01"
            min="0"
            placeholder="как общая"
            value={formData.minProfitYm}
            onChange={(e) => handleChange('minProfitYm', e.target.value)}
          />
          <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
            Для расчёта мин. цены Яндекс.Маркет (пусто — общая)
          </div>
        </div>
      </div>

      {Object.keys(errors).length > 0 && (
        <div className="error" style={{marginTop: '12px'}}>
          {Object.values(errors)[0]}
        </div>
      )}
        </>
      )}

      {activeTab === 'ozon' && (
        <div className="product-form-marketplace-panel">
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="mp-badge ozon">OZ</span>
            Данные для Ozon
          </h4>
          <ProductMarketplaceLinkSection
            marketplace="ozon"
            formData={formData}
            errors={errors}
            handleChange={handleChange}
            productId={currentProduct?.id}
            organizationId={formData.organizationId}
            erpSku={formData.sku}
            onLinked={handleMarketplaceLinked}
          />
          <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
            <Button
              type="button"
              variant="secondary"
              onClick={fetchOzonProductInfo}
              disabled={
                ozonSyncLoading ||
                (
                  !String(formData.ozon_product_id || currentProduct?.ozon_product_id || '').trim() &&
                  !String(formData.sku_ozon || formData.sku || '').trim()
                )
              }
            >
              {ozonSyncLoading ? 'Загрузка…' : 'Обновить данные с Ozon'}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => handlePushCard('ozon')}
              disabled={!!pushCardLoading || !currentProduct?.id || !formData.sku_ozon?.trim()}
              title={!currentProduct?.id ? 'Сначала сохраните товар' : 'Отправить поля вкладки Ozon в кабинет'}
            >
              {pushCardLoading === 'ozon' ? 'Отправка…' : 'Сохранить и отправить на Ozon'}
            </Button>
            <span className="text-muted small">
              «Обновить с Ozon» — загрузка в ERP. «Сохранить и отправить» — сначала запись в ERP, затем выгрузка в кабинет Ozon.
            </span>
          </div>
          <div className="card mt-3 border-secondary">
            <div className="card-header">Текст карточки Ozon</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                Поля для выгрузки на Ozon — всегда можно править. Связь с «Основным» синхронизирует значения;
                «Сохранить и отправить» уносит текущие поля вкладки в кабинет.
              </p>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label" htmlFor="ozon-tab-name">
                    Название (Ozon)
                    {isMpFieldLinked(formData.mp_field_links, 'name', 'ozon') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <input
                    id="ozon-tab-name"
                    type="text"
                    className={mpFieldClass('form-control form-control-sm', 'mp_ozon_name')}
                    value={formData.mp_ozon_name}
                    onChange={(e) =>
                      handleMpCardFieldChange('mp_ozon_name', 'name', 'name', 'ozon', e.target.value)
                    }
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label" htmlFor="ozon-tab-brand">
                    Бренд (Ozon)
                    {isMpFieldLinked(formData.mp_field_links, 'brand', 'ozon') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <input
                    id="ozon-tab-brand"
                    type="text"
                    className={mpFieldClass('form-control form-control-sm', 'mp_ozon_brand')}
                    value={formData.mp_ozon_brand}
                    onChange={(e) =>
                      handleMpCardFieldChange('mp_ozon_brand', 'brand', 'brand', 'ozon', e.target.value)
                    }
                  />
                </div>
                <div className="col-12">
                  <label className="form-label" htmlFor="ozon-tab-description">
                    Описание (Ozon)
                    {isMpFieldLinked(formData.mp_field_links, 'description', 'ozon') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <textarea
                    id="ozon-tab-description"
                    className={mpFieldClass('form-control form-control-sm', 'mp_ozon_description')}
                    rows={5}
                    value={formData.mp_ozon_description}
                    onChange={(e) =>
                      handleMpCardFieldChange(
                        'mp_ozon_description',
                        'description',
                        'description',
                        'ozon',
                        e.target.value
                      )
                    }
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="card mt-3 border-secondary">
            <div className="card-header">Габариты товара и упаковки (Ozon)</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 12 }}>
                Габариты товара — из атрибутов категории; упаковка — мм / г для логистики. Связь упаковки с «Основным» — тумблеры на Основном.
              </p>
              <MpSkuCountryDimsEditor
                mp="ozon"
                formData={formData}
                onSkuChange={(v) => handleMpSkuMetaChange('ozon', v)}
                onCountryChange={(v) => handleMpCountryMetaChange('ozon', v)}
                onDimChange={(key, v) => handleMpDimMetaChange('ozon', key, v)}
                onProductDimChange={(key, v) => handleChange(key, v)}
                productAttrFields={[]}
              />
            </div>
          </div>
          {(pushCardError || pushCardMessage) && activeTab === 'ozon' ? (
            <div
              className={`alert py-2 mb-2 ${pushCardError ? 'alert-danger' : 'alert-success'}`}
              style={{ fontSize: '12px' }}
            >
              {pushCardError || pushCardMessage}
            </div>
          ) : null}
          {ozonSyncError && (
            <div className="alert alert-danger py-2 mb-2" style={{ fontSize: '12px' }}>
              {ozonSyncError}
            </div>
          )}
          {ozonSyncSuccess && (
            <div className="alert alert-success py-2 mb-2" style={{ fontSize: '12px' }}>
              {ozonSyncSuccess}
            </div>
          )}
          {ozonFetchedProduct && (() => {
            const attrs = ozonFetchedProduct.attributes ?? ozonFetchedProduct.attribute_values;
            const brandAttr = Array.isArray(attrs)
              ? attrs.find((a) => Number(a.attribute_id ?? a.id) === 85 || /бренд|brand/i.test(String(a.name ?? a.attribute_id ?? '')))
              : null;
            const brandVal = brandAttr?.values?.[0]
              ? (brandAttr.values[0].value ?? brandAttr.values[0].dictionary_value_id ?? brandAttr.values[0].id)
              : (brandAttr?.value ?? null);
            const brandDisplay = brandVal != null ? String(brandVal) : '';
            return (
            <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(0, 91, 255, 0.06)', borderRadius: '8px', border: '1px solid rgba(0, 91, 255, 0.2)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text)' }}>
                Данные с Ozon (все поля по товару)
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                {(ozonFetchedProduct.name ?? ozonFetchedProduct.title) && (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Название:</span>
                    <span>{ozonFetchedProduct.name ?? ozonFetchedProduct.title}</span>
                  </div>
                )}
                {brandDisplay && (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Бренд:</span>
                    <span>{brandDisplay}</span>
                  </div>
                )}
                {(ozonFetchedProduct.description ?? ozonFetchedProduct.description_html) && (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Описание:</span>
                    <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', maxHeight: '120px', overflow: 'auto' }}>
                      {((ozonFetchedProduct.description ?? ozonFetchedProduct.description_html) || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 500)}
                      {((ozonFetchedProduct.description ?? ozonFetchedProduct.description_html) || '').length > 500 ? '…' : ''}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 16px' }}>
                  {ozonFetchedProduct.id != null && (
                    <span><span style={{ color: 'var(--muted)' }}>ID Ozon:</span> {ozonFetchedProduct.id}</span>
                  )}
                  {(ozonFetchedProduct.offer_id ?? ozonFetchedProduct.sku) && (
                    <span><span style={{ color: 'var(--muted)' }}>Артикул:</span> {ozonFetchedProduct.offer_id ?? ozonFetchedProduct.sku}</span>
                  )}
                  {coerceBarcodeString(ozonFetchedProduct.barcode) && (
                    <span><span style={{ color: 'var(--muted)' }}>Штрихкод:</span> {coerceBarcodeString(ozonFetchedProduct.barcode)}</span>
                  )}
                  {ozonFetchedProduct.category_id != null && (
                    <span><span style={{ color: 'var(--muted)' }}>ID категории:</span> {ozonFetchedProduct.category_id}</span>
                  )}
                  {ozonFetchedProduct.price != null && (
                    <span><span style={{ color: 'var(--muted)' }}>Цена:</span> {Number(ozonFetchedProduct.price).toLocaleString('ru-RU')} ₽</span>
                  )}
                  {ozonFetchedProduct.old_price != null && ozonFetchedProduct.old_price > 0 && (
                    <span><span style={{ color: 'var(--muted)' }}>Старая цена:</span> {Number(ozonFetchedProduct.old_price).toLocaleString('ru-RU')} ₽</span>
                  )}
                  {ozonFetchedProduct.marketing_price != null && ozonFetchedProduct.marketing_price > 0 && (
                    <span><span style={{ color: 'var(--muted)' }}>Акционная цена:</span> {Number(ozonFetchedProduct.marketing_price).toLocaleString('ru-RU')} ₽</span>
                  )}
                  {ozonFetchedProduct.vat != null && (
                    <span><span style={{ color: 'var(--muted)' }}>НДС:</span> {ozonFetchedProduct.vat}</span>
                  )}
                  {ozonFetchedProduct.visible != null && (
                    <span><span style={{ color: 'var(--muted)' }}>Видимость:</span> {ozonFetchedProduct.visible ? 'Да' : 'Нет'}</span>
                  )}
                  {(ozonFetchedProduct.status ?? ozonFetchedProduct.state) != null && (
                    <span><span style={{ color: 'var(--muted)' }}>Статус:</span> {String(ozonFetchedProduct.status ?? ozonFetchedProduct.state)}</span>
                  )}
                  {ozonFetchedProduct.created_at && (
                    <span><span style={{ color: 'var(--muted)' }}>Создан:</span> {String(ozonFetchedProduct.created_at).slice(0, 10)}</span>
                  )}
                </div>
                {Array.isArray(ozonFetchedProduct.images) && ozonFetchedProduct.images.length > 0 && (
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Изображений:</span> {ozonFetchedProduct.images.length}
                    {(ozonFetchedProduct.primary_image ?? ozonFetchedProduct.image) && (
                      <span style={{ marginLeft: '8px', color: 'var(--muted)' }}> (главное: {String(ozonFetchedProduct.primary_image ?? ozonFetchedProduct.image).slice(0, 40)}…)</span>
                    )}
                  </div>
                )}
                {(ozonFetchedProduct.stocks && typeof ozonFetchedProduct.stocks === 'object') && (
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {ozonFetchedProduct.stocks.present != null && (
                      <span><span style={{ color: 'var(--muted)' }}>В наличии:</span> {ozonFetchedProduct.stocks.present}</span>
                    )}
                    {ozonFetchedProduct.stocks.reserved != null && (
                      <span><span style={{ color: 'var(--muted)' }}>Зарезервировано:</span> {ozonFetchedProduct.stocks.reserved}</span>
                    )}
                    {ozonFetchedProduct.stocks.coming != null && (
                      <span><span style={{ color: 'var(--muted)' }}>В пути:</span> {ozonFetchedProduct.stocks.coming}</span>
                    )}
                  </div>
                )}
                {(ozonFetchedProduct.weight != null || ozonFetchedProduct.dimension_x != null || ozonFetchedProduct.dimension_y != null || ozonFetchedProduct.dimension_z != null) && (
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {ozonFetchedProduct.weight != null && (
                      <span><span style={{ color: 'var(--muted)' }}>Вес (г):</span> {ozonFetchedProduct.weight}</span>
                    )}
                    {(ozonFetchedProduct.dimension_x ?? ozonFetchedProduct.width) != null && (
                      <span><span style={{ color: 'var(--muted)' }}>Ширина (мм):</span> {ozonFetchedProduct.dimension_x ?? ozonFetchedProduct.width}</span>
                    )}
                    {(ozonFetchedProduct.dimension_y ?? ozonFetchedProduct.height) != null && (
                      <span><span style={{ color: 'var(--muted)' }}>Высота (мм):</span> {ozonFetchedProduct.dimension_y ?? ozonFetchedProduct.height}</span>
                    )}
                    {(ozonFetchedProduct.dimension_z ?? ozonFetchedProduct.length) != null && (
                      <span><span style={{ color: 'var(--muted)' }}>Длина (мм):</span> {ozonFetchedProduct.dimension_z ?? ozonFetchedProduct.length}</span>
                    )}
                  </div>
                )}
                {Array.isArray(ozonFetchedProduct.attributes) && ozonFetchedProduct.attributes.length > 0 && (
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Атрибуты ({ozonFetchedProduct.attributes.length}):</span>
                    <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                      {ozonFetchedProduct.attributes.slice(0, 15).map((a, i) => {
                        const val = a.values?.[0]?.value ?? a.values?.[0]?.dictionary_value_id ?? a.value ?? (a.values && a.values[0]) ?? '—';
                        return (
                          <li key={i} style={{ marginBottom: '2px' }}>
                            {a.attribute_id ?? a.id ?? a.name ?? 'ID ' + i}: {String(val)}
                          </li>
                        );
                      })}
                      {ozonFetchedProduct.attributes.length > 15 && (
                        <li style={{ color: 'var(--muted)' }}>… и ещё {ozonFetchedProduct.attributes.length - 15}</li>
                      )}
                    </ul>
                  </div>
                )}
                <MpApiResponseDump
                  data={ozonFetchedProduct}
                  open={ozonShowAllFields}
                  onToggle={() => setOzonShowAllFields((v) => !v)}
                  label="сырой ответ API Ozon"
                />
              </div>
            </div>
            );
          })()}
          {formData.categoryId && (
            <div style={{ marginTop: '12px', padding: '12px', background: 'rgba(255, 107, 0, 0.06)', borderRadius: '8px', border: '1px solid rgba(255, 107, 0, 0.25)' }}>
              <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text)' }}>
                Атрибуты Ozon (характеристики для выгрузки)
              </h4>
              {categoryDetailsLoading ? (
                <p style={{ fontSize: '12px', color: 'var(--muted)' }}>Загрузка данных категории…</p>
              ) : !hasOzonMarketplaceMapping ? (
                <div className="alert alert-warning py-2 mb-0" style={{ fontSize: '12px' }}>
                  Для выбранной категории не задано сопоставление Ozon. Заполните в <strong>Категории → редактировать категорию → Ozon</strong> (обновить список и выбрать категорию и тип товара).
                </div>
              ) : ozonAttributesLoading ? (
                <p style={{ fontSize: '12px', color: 'var(--muted)' }}>Загрузка характеристик...</p>
              ) : ozonAttributesError ? (
                <div className="alert alert-danger py-2 mb-0" style={{ fontSize: '12px' }}>
                  {ozonAttributesError}
                </div>
              ) : ozonAttributes.length === 0 ? (
                <p style={{ fontSize: '12px', color: 'var(--muted)' }}>Нет атрибутов для этой категории Ozon (или сопоставление не заполнено).</p>
              ) : (
                <div className="row g-3">
                  {ozonAttributes
                    .filter((attr) => {
                      const kind = classifyMarketplaceDimAttrName(attr?.name);
                      return kind !== 'product' && kind !== 'pack';
                    })
                    .map((attr) => {
                    const key = String(attr.id);
                    const value = ozonAttributeValues[key];
                    const rawValue = value !== undefined && value !== null ? value : '';
                    const hasDict = attr.dictionary_id != null && Number(attr.dictionary_id) !== 0;
                    const options = ozonDictValues[attr.id];
                    const matchedOpt = Array.isArray(options) ? findOzonDictEntryForStored(rawValue, options) : null;
                    const selectValue = matchedOpt
                      ? String(matchedOpt.id)
                      : /^\d+$/.test(String(rawValue || '').trim())
                        ? String(rawValue).trim()
                        : '';
                    const fallbackLabel = String(rawValue || '').trim();
                    const needsTextFallback =
                      fallbackLabel !== '' &&
                      !matchedOpt &&
                      (selectValue === '' || String(selectValue) !== fallbackLabel);
                    if (hasDict) {
                      return (
                        <div key={attr.id} className="col-12 col-md-6 col-lg-4">
                          <label className="form-label" htmlFor={`ozon-attr-${attr.id}`}>
                            {attr.name}
                            {attr.is_required && <span style={{ color: '#ef4444' }}> *</span>}
                            {attr.description && (
                              <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block', marginTop: '2px' }}>{attr.description}</span>
                            )}
          </label>
                          <select
                            id={`ozon-attr-${attr.id}`}
                            className={mpAttrClass('form-select form-select-sm', 'ozon', attr.id, rawValue)}
                            value={needsTextFallback ? fallbackLabel : selectValue}
                            onChange={(e) => handleOzonAttributeChange(attr.id, e.target.value)}
                            onFocus={() => { if (!options) loadOzonDictValues(attr.id); }}
                          >
                            <option value="">— Выберите —</option>
                            {Array.isArray(options) && options.map((opt) => (
                              <option key={opt.id} value={String(opt.id)}>{ozonDictEntryText(opt) || opt.value}</option>
                            ))}
                            {needsTextFallback && (
                              <option value={fallbackLabel}>{fallbackLabel}</option>
                            )}
                            {options === undefined && fallbackLabel === '' && (
                              <option value="" disabled>Загрузка...</option>
                            )}
                          </select>
                        </div>
                      );
                    }
                    if (attr.type === 'boolean' || (attr.type === 'string' && attr.is_aspect)) {
                      const checked = rawValue === 'true' || rawValue === true;
                      return (
                        <div key={attr.id} className="col-12 col-md-6 col-lg-4">
                          <div className="form-check">
          <input
                              className="form-check-input"
                              id={`ozon-attr-${attr.id}`}
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => handleOzonAttributeChange(attr.id, e.target.checked ? 'true' : 'false')}
                            />
                            <label className="form-check-label" htmlFor={`ozon-attr-${attr.id}`}>
                              {attr.name}
                              {attr.is_required && <span style={{ color: '#ef4444' }}> *</span>}
                            </label>
        </div>
                          {attr.description && (
                            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>{attr.description}</div>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div key={attr.id} className="col-12 col-md-6 col-lg-4">
                        <label className="form-label" htmlFor={`ozon-attr-${attr.id}`}>
                          {attr.name}
                          {attr.is_required && <span style={{ color: '#ef4444' }}> *</span>}
                          {attr.description && (
                            <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block', marginTop: '2px' }}>{attr.description}</span>
                          )}
                        </label>
                        {(() => {
                          const nameNorm = String(attr.name || '').toLowerCase();
                          const isAnnotation = /аннотац/.test(nameNorm) || /описание/.test(nameNorm);
                          if (!isAnnotation) {
                            return (
          <input
                                id={`ozon-attr-${attr.id}`}
                                type={attr.type === 'number' ? 'number' : 'text'}
                                className={mpAttrClass('form-control form-control-sm', 'ozon', attr.id, rawValue)}
                                value={rawValue}
                                onChange={(e) => handleOzonAttributeChange(attr.id, e.target.value)}
                              />
                            );
                          }
                          const textValue = rawValue != null ? String(rawValue) : '';
                          return (
                            <>
                              <textarea
                                id={`ozon-attr-${attr.id}`}
                                className={mpAttrClass('form-control form-control-sm', 'ozon', attr.id, textValue)}
                                rows="5"
                                value={textValue}
                                onChange={(e) => handleOzonAttributeChange(attr.id, e.target.value)}
                              />
                              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '6px' }}>
                                Символов: {textValue.length}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {activeTab === 'wb' && (
        <div className="product-form-marketplace-panel">
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="mp-badge wb">WB</span>
            Данные для Wildberries
          </h4>
          <ProductMarketplaceLinkSection
            marketplace="wb"
            formData={formData}
            errors={errors}
            handleChange={handleChange}
            productId={currentProduct?.id}
            organizationId={formData.organizationId}
            erpSku={formData.sku}
            onLinked={handleMarketplaceLinked}
          />
          <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
            <Button
              type="button"
              variant="secondary"
              onClick={fetchWbProductInfo}
              disabled={
                wbSyncLoading ||
                (
                  !String(formData.sku_wb || '').trim() &&
                  !String(
                    formData.mp_wb_vendor_code ||
                      currentProduct?.mp_wb_vendor_code ||
                      formData.sku_ozon ||
                      currentProduct?.sku_ozon ||
                      ''
                  ).trim()
                )
              }
            >
              {wbSyncLoading ? 'Загрузка…' : 'Обновить данные с WB'}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => handlePushCard('wb')}
              disabled={!!pushCardLoading || !currentProduct?.id || !formData.sku_wb?.trim()}
            >
              {pushCardLoading === 'wb' ? 'Отправка…' : 'Сохранить и отправить на WB'}
            </Button>
            <span className="text-muted small">
              «Обновить с WB» — загрузка в ERP. «Сохранить и отправить» — запись в ERP и выгрузка в кабинет WB.
            </span>
          </div>
          {(pushCardError || pushCardMessage) && activeTab === 'wb' ? (
            <div
              className={`alert py-2 mb-2 ${pushCardError ? 'alert-danger' : 'alert-success'}`}
              style={{ fontSize: '12px' }}
            >
              {pushCardError || pushCardMessage}
            </div>
          ) : null}
          {wbSyncError && (
            <div className="alert alert-danger py-2 mb-2" style={{ fontSize: '12px' }}>
              {wbSyncError}
            </div>
          )}
          {wbSyncSuccess && (
            <div className="alert alert-success py-2 mb-2" style={{ fontSize: '12px' }}>
              {wbSyncSuccess}
            </div>
          )}
          <div className="card mt-3 border-secondary">
            <div className="card-header">Текст карточки Wildberries</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                Поля только для WB — всегда можно править. nmId и vendorCode — в блоке «Связь с маркетплейсом» выше.
                Связь с «Основным» синхронизирует значения; отправка — кнопка выше.
              </p>
              {wbFetchedProduct && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 14px', fontSize: '12px', marginBottom: '12px' }}>
                  {(wbFetchedProduct.nmId ?? wbFetchedProduct.nmID) != null && (
                    <span><span style={{ color: 'var(--muted)' }}>nmId:</span> {wbFetchedProduct.nmId ?? wbFetchedProduct.nmID}</span>
                  )}
                  {wbFetchedProduct.vendorCode && (
                    <span><span style={{ color: 'var(--muted)' }}>vendorCode:</span> {String(wbFetchedProduct.vendorCode)}</span>
                  )}
                  {wbFetchedProduct.subjectName && (
                    <span><span style={{ color: 'var(--muted)' }}>Категория WB:</span> {String(wbFetchedProduct.subjectName)}</span>
                  )}
                </div>
              )}
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label" htmlFor="wb-tab-name-wb">
                    Название (WB)
                    {isMpFieldLinked(formData.mp_field_links, 'name', 'wb') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <input
                    id="wb-tab-name-wb"
                    type="text"
                    className={mpFieldClass('form-control form-control-sm', 'mp_wb_name')}
                    value={formData.mp_wb_name}
                    onChange={(e) =>
                      handleMpCardFieldChange('mp_wb_name', 'name', 'name', 'wb', e.target.value)
                    }
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label" htmlFor="wb-tab-brand-wb">
                    Бренд (WB)
                    {isMpFieldLinked(formData.mp_field_links, 'brand', 'wb') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <input
                    id="wb-tab-brand-wb"
                    type="text"
                    className={mpFieldClass('form-control form-control-sm', 'mp_wb_brand')}
                    value={formData.mp_wb_brand}
                    onChange={(e) =>
                      handleMpCardFieldChange('mp_wb_brand', 'brand', 'brand', 'wb', e.target.value)
                    }
                    placeholder="Текст для карточки WB"
                  />
                </div>
                <div className="col-12">
                  <label className="form-label" htmlFor="wb-tab-description">
                    Описание (WB)
                    {isMpFieldLinked(formData.mp_field_links, 'description', 'wb') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <textarea
                    id="wb-tab-description"
                    className={mpFieldClass('form-control form-control-sm', 'mp_wb_description')}
                    rows={5}
                    value={formData.mp_wb_description}
                    onChange={(e) =>
                      handleMpCardFieldChange(
                        'mp_wb_description',
                        'description',
                        'description',
                        'wb',
                        e.target.value
                      )
                    }
                    placeholder="Описание для Wildberries"
                  />
                </div>
              </div>
              {wbFetchedProduct && (
                <MpApiResponseDump
                  data={wbFetchedProduct}
                  open={wbShowAllFields}
                  onToggle={() => setWbShowAllFields((v) => !v)}
                  label="сырой ответ API WB"
                />
              )}
            </div>
          </div>

          <div className="card mt-3 border-secondary">
            <div className="card-header">Габариты товара и упаковки (Wildberries)</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 12 }}>
                Товар — характеристики предмета (см); упаковка — см / кг. Связь упаковки с «Основным» — тумблеры на Основном.
              </p>
              <MpSkuCountryDimsEditor
                mp="wb"
                formData={formData}
                onSkuChange={(v) => handleMpSkuMetaChange('wb', v)}
                onCountryChange={(v) => handleMpCountryMetaChange('wb', v)}
                onDimChange={(key, v) => handleMpDimMetaChange('wb', key, v)}
                itemAttrValues={wbAttributeValues}
                onItemAttrChange={handleWbItemAttrChange}
                itemAttrLabels={(() => {
                  const labels = {};
                  for (const a of wbCategoryAttributes || []) {
                    const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id;
                    if (id == null) continue;
                    const key = String(id);
                    if (isWbDedicatedDimCharcId(key) && (
                      key === WB_ITEM_DIM_CHARC.length ||
                      key === WB_ITEM_DIM_CHARC.width ||
                      key === WB_ITEM_DIM_CHARC.height
                    )) {
                      labels[key] = a?.name ?? a?.charcName ?? a?.characteristic_name ?? key;
                    }
                  }
                  return labels;
                })()}
              />
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Атрибуты WB</div>
            <div className="card-body">
              {formData.categoryId && categoryDetailsLoading ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Загрузка данных категории…</div>
              ) : !formData.categoryId ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>
                  Выберите категорию на вкладке «Основное» или нажмите «Обновить данные с WB».
                </div>
              ) : wbCategoryAttributesError && !(Array.isArray(wbFetchedProduct?.characteristics) && wbFetchedProduct.characteristics.length > 0) ? (
                <div className="alert alert-danger py-2 mb-0" style={{ fontSize: '12px' }}>
                  {wbCategoryAttributesError}
                </div>
              ) : (
                <>
                  {wbCategoryAttributesError && (
                    <div className="alert alert-warning py-2 mb-2" style={{ fontSize: '12px' }}>
                      Схема категории WB недоступна ({wbCategoryAttributesError}). Показаны характеристики из загруженной карточки.
                    </div>
                  )}
                  {wbCategoryAttributesLoading && wbCategoryAttributes.length === 0 && !(Array.isArray(wbFetchedProduct?.characteristics) && wbFetchedProduct.characteristics.length > 0) ? (
                    <div className="text-muted" style={{ fontSize: '12px' }}>Загрузка атрибутов категории WB…</div>
                  ) : wbCategoryAttributes.length > 0 ? (
                    <div className="row g-3">
                      {wbCategoryAttributes
                        .filter((a) => {
                          const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
                          return !isWbDedicatedDimCharcId(id);
                        })
                        .map((a) => {
                        const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
                        const key = id != null ? String(id) : String(a?.name || '');
                        const name = a?.name ?? a?.charcName ?? a?.characteristic_name ?? (key ? `ID ${key}` : 'Характеристика');
                        const required = Boolean(a?.required ?? a?.isRequired ?? a?.is_required);
                        const value = wbAttributeValues[key] ?? '';
                        return (
                          <div key={key} className="col-12 col-md-6 col-lg-4">
                            <label className="form-label" htmlFor={`wb-cat-attr-${key}`}>
                              {name}
                              {required ? <span style={{ color: '#ef4444' }}> *</span> : null}
                            </label>
                            <input
                              id={`wb-cat-attr-${key}`}
                              type="text"
                              className={mpAttrClass('form-control form-control-sm', 'wb', key, value)}
                              value={value}
                              onChange={(e) => setWbAttributeValues((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : Array.isArray(wbFetchedProduct?.characteristics) && wbFetchedProduct.characteristics.length > 0 ? (
                    <div className="row g-3">
                      {wbFetchedProduct.characteristics.map((c) => {
                        const id = c?.id ?? c?.characteristic_id ?? c?.charcID;
                        const name = c?.name ?? c?.characteristic_name ?? (id != null ? `ID ${id}` : 'Характеристика');
                        const key = id != null ? String(id) : String(name);
                        const raw = wbAttributeValues[key];
                        const display = isEmptyMarketplaceValue(raw)
                          ? ''
                          : (typeof raw === 'string' ? raw : String(normalizeWbAttributeScalar(raw)));
                        return (
                          <div key={key} className="col-12 col-md-6 col-lg-4">
                            <label className="form-label" htmlFor={`wb-attr-${key}`}>
                              {name}
                            </label>
                            <input
                              id={`wb-attr-${key}`}
                              type="text"
                              className={mpAttrClass('form-control form-control-sm', 'wb', key, display)}
                              value={display}
                              onChange={(e) => setWbAttributeValues((prev) => ({ ...prev, [key]: e.target.value }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : !effectiveWbSubjectId || effectiveWbSubjectId <= 0 ? (
                    <div className="alert alert-warning py-2 mb-0" style={{ fontSize: '12px' }}>
                      Нет subjectId WB. Заполните сопоставление в категории ERP или нажмите «Обновить данные с WB».
                    </div>
                  ) : (
                    <div className="text-muted" style={{ fontSize: '12px' }}>
                      Нет характеристик. Загрузите карточку с WB или проверьте сопоставление категории.
                    </div>
                  )}
                </>
              )}
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }}>
                Сохраняются как <code>wb_attributes</code>. Название, описание и бренд — в блоке «Текст карточки» выше.
              </div>
            </div>
          </div>

        </div>
      )}

      {activeTab === 'ym' && (
        <div className="product-form-marketplace-panel">
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="mp-badge ym">YM</span>
            Данные для Яндекс.Маркет
          </h4>
          <ProductMarketplaceLinkSection
            marketplace="ym"
            formData={formData}
            errors={errors}
            handleChange={handleChange}
            productId={currentProduct?.id}
            organizationId={formData.organizationId}
            erpSku={formData.sku}
            onLinked={handleMarketplaceLinked}
          />
          <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
            <Button
              type="button"
              variant="secondary"
              onClick={fetchYmProductInfo}
              disabled={
                ymSyncLoading ||
                (
                  !String(formData.sku_ym || formData.sku || '').trim()
                )
              }
            >
              {ymSyncLoading ? 'Загрузка…' : 'Обновить данные с Яндекс.Маркет'}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => handlePushCard('ym')}
              disabled={!!pushCardLoading || !currentProduct?.id || !formData.sku_ym?.trim()}
            >
              {pushCardLoading === 'ym' ? 'Отправка…' : 'Сохранить и отправить на Я.Маркет'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => handlePushCard('all')}
              disabled={!!pushCardLoading || !currentProduct?.id}
            >
              {pushCardLoading === 'all' ? 'Отправка…' : 'Сохранить и отправить на все МП'}
            </Button>
            <span className="text-muted small">
              Подтянуть с Маркета или отправить изменения из ERP в кабинет (нужна связь и категория YM).
            </span>
            </div>
          {ymSyncError && (
            <div className="alert alert-danger py-2 mb-2" style={{ fontSize: '12px' }}>
              {ymSyncError}
            </div>
          )}
          {ymSyncSuccess && (
            <div className="alert alert-success py-2 mb-2" style={{ fontSize: '12px' }}>
              {ymSyncSuccess}
            </div>
          )}

          <div className="card mb-3 border-secondary">
            <div className="card-header">Габариты товара и упаковки (Яндекс.Маркет)</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 12 }}>
                Товар — параметры категории; упаковка — см / кг (weightDimensions).
                {isMpFieldLinked(formData.mp_field_links, 'dimensions', 'ym')
                  ? ' Связь упаковки с «Основным» включена.'
                  : ' Связь упаковки выключена: только ym_draft.'}
              </p>
              <div className="row g-3 mb-3">
                <div className="col-12 col-md-6">
                  <label className="form-label" htmlFor="ym-tab-country">
                    Страна производства
                    {isMpFieldLinked(formData.mp_field_links, 'country', 'ym') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : (
                      <span className="mp-field-linked-hint"> · только Яндекс</span>
                    )}
                  </label>
                  <input
                    id="ym-tab-country"
                    type="text"
                    className="form-control form-control-sm"
                    value={
                      isMpFieldLinked(formData.mp_field_links, 'country', 'ym')
                        ? formData.country_of_origin
                        : getYmDraftCountry(formData)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (isMpFieldLinked(formData.mp_field_links, 'country', 'ym')) {
                        handleChange('country_of_origin', v);
                      } else {
                        setFormData((prev) => withYmDraftCountry(prev, v));
                      }
                    }}
                    placeholder="Например, Китай"
                    list="ym-country-of-origin-list"
                  />
                  <datalist id="ym-country-of-origin-list">
                    {COUNTRY_OPTIONS.map((country) => (
                      <option key={country} value={country} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Габариты товара</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Как на вкладке «Основное» (мм / г). Параметры категории Маркета — ниже, если есть.
              </div>
              <div className="row g-2 mb-3">
                {[
                  { key: 'product_length', label: 'Длина товара (мм)' },
                  { key: 'product_width', label: 'Ширина товара (мм)' },
                  { key: 'product_height', label: 'Высота товара (мм)' },
                  { key: 'product_weight', label: 'Вес товара (г)' },
                ].map((f) => (
                  <div className="col-6 col-md-3" key={f.key}>
                    <label className="form-label" htmlFor={`ym-${f.key}`}>
                      {f.label}
                    </label>
                    <input
                      id={`ym-${f.key}`}
                      type="number"
                      className="form-control form-control-sm"
                      min="0"
                      step="1"
                      value={formData[f.key] ?? ''}
                      onChange={(e) => handleChange(f.key, e.target.value)}
                    />
                  </div>
                ))}
                <DimVolumeReadonly
                  id="ym-product-volume"
                  unit="mm"
                  length={formData.product_length}
                  width={formData.product_width}
                  height={formData.product_height}
                />
              </div>
              {(() => {
                const productParams = (ymCategoryAttributes || []).filter(
                  (a) =>
                    classifyMarketplaceDimAttrName(a?.name) === 'product' &&
                    !isCoveredByDedicatedProductDimFields(a?.name)
                );
                if (productParams.length === 0) return null;
                return (
                  <div className="row g-2 mb-3">
                    {productParams.map((a) => {
                      const key = String(a.id);
                      return (
                        <div className="col-6 col-md-3" key={key}>
                          <label className="form-label" htmlFor={`ym-product-attr-${key}`}>
                            {a.name || `ID ${key}`}
                          </label>
                          <input
                            id={`ym-product-attr-${key}`}
                            type="text"
                            className="form-control form-control-sm"
                            value={ymAttributeValues[key] ?? ''}
                            onChange={(e) =>
                              setYmAttributeValues((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                Габариты упаковки
                {isMpFieldLinked(formData.mp_field_links, 'dimensions', 'ym') ? (
                  <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                ) : (
                  <span className="mp-field-linked-hint"> · только Яндекс</span>
                )}
              </div>
              <YmPackagingDimensionFields
                formData={formData}
                onChange={handleYmPackagingDimChange}
                idPrefix="ym-pack"
              />
            </div>
          </div>

          {ymFetchedProduct && (
            <div className="card mb-3 border-warning">
              <div className="card-header">Данные с Яндекс.Маркета</div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                {ymFetchedProduct.offerId ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>offerId:</span>{ymFetchedProduct.offerId}</div>
                ) : null}
                {ymFetchedProduct.shopSku ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>shopSku:</span>{ymFetchedProduct.shopSku}</div>
                ) : null}
                {ymFetchedProduct.marketSku ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>marketSku:</span>{ymFetchedProduct.marketSku}</div>
                ) : null}
                {ymFetchedProduct.marketCategoryId != null ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>marketCategoryId:</span>{String(ymFetchedProduct.marketCategoryId)}</div>
                ) : null}
                {ymFetchedProduct.vendor ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>vendor:</span>{ymFetchedProduct.vendor}</div>
                ) : null}
                {ymFetchedProduct.name ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>Название:</span>{ymFetchedProduct.name}</div>
                ) : null}
                {ymFetchedProduct.description ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>Описание:</span>{ymFetchedProduct.description}</div>
                ) : null}
                {Array.isArray(ymFetchedProduct.manufacturerCountries) && ymFetchedProduct.manufacturerCountries.length > 0 ? (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Страна (из YM):</span>
                    {ymFetchedProduct.manufacturerCountries.map((c) => String(c || '').trim()).filter(Boolean).join(', ')}
                  </div>
                ) : null}
                {Array.isArray(ymFetchedProduct.barcodes) && ymFetchedProduct.barcodes.length > 0 ? (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>barcodes:</span>
                    {ymFetchedProduct.barcodes.map((b) => String(b || '').trim()).filter(Boolean).join(', ')}
                  </div>
                ) : null}
                {Array.isArray(ymFetchedProduct.parameterValues) && ymFetchedProduct.parameterValues.length > 0 ? (
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: 4 }}>
                      Характеристики карточки ({ymFetchedProduct.parameterValues.length} шт., ниже — полный JSON)
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: 'auto' }}>
                      {ymFetchedProduct.parameterValues.map((pv, i) => {
                        const pid = pv?.parameterId ?? pv?.id ?? '—';
                        const pname = pv?.parameterName ?? pv?.name ?? null;
                        const val = pv?.value ?? pv?.valueId ?? pv?.optionId ?? '—';
                        return (
                          <li key={`${pid}-${i}`}>
                            <span style={{ color: 'var(--muted)' }}>
                              {pname ? `${pname} (#${pid})` : `#${pid}`}:
                            </span>{' '}
                            {String(val)}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                    Категорийные характеристики не пришли (parameterValues пуст). Смотрите raw.offerCard / raw.mapping в JSON ниже.
                  </div>
                )}
                <MpApiResponseDump
                  data={ymFetchedProduct}
                  open={ymShowAllFields}
                  onToggle={() => setYmShowAllFields((v) => !v)}
                  label="сырой ответ API YM (включая raw.mapping и raw.offerCard)"
                />
              </div>
            </div>
          )}
          {(pushCardError || pushCardMessage) && activeTab === 'ym' ? (
            <div
              className={`alert py-2 mb-2 ${pushCardError ? 'alert-danger' : 'alert-success'}`}
              style={{ fontSize: '12px' }}
            >
              {pushCardError || pushCardMessage}
            </div>
          ) : null}

          <div className="card mt-3 border-secondary">
            <div className="card-header">Название и описание для Яндекс.Маркета</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                Отдельно от «Основного» — всегда можно править. Связь синхронизирует с Основным;
                «Сохранить и отправить» выгружает поля вкладки YM в кабинет.
              </p>
              <div className="row g-3">
                <div className="col-12">
                  <label className="form-label" htmlFor="ym-tab-name">
                    Название (Яндекс)
                    {isMpFieldLinked(formData.mp_field_links, 'name', 'ym') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <input
                    id="ym-tab-name"
                    type="text"
                    className={mpFieldClass('form-control form-control-sm', 'mp_ym_name')}
                    value={formData.mp_ym_name}
                    onChange={(e) =>
                      handleMpCardFieldChange('mp_ym_name', 'name', 'name', 'ym', e.target.value)
                    }
                  />
                </div>
                <div className="col-12">
                  <label className="form-label" htmlFor="ym-tab-description">
                    Описание (Яндекс)
                    {isMpFieldLinked(formData.mp_field_links, 'description', 'ym') ? (
                      <span className="mp-field-linked-hint"> · синхрон с Основным</span>
                    ) : null}
                  </label>
                  <textarea
                    id="ym-tab-description"
                    className={mpFieldClass('form-control form-control-sm', 'mp_ym_description')}
                    rows={5}
                    value={formData.mp_ym_description}
                    onChange={(e) =>
                      handleMpCardFieldChange(
                        'mp_ym_description',
                        'description',
                        'description',
                        'ym',
                        e.target.value
                      )
                    }
                    placeholder="Описание для Яндекс.Маркета"
                  />
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '6px' }}>
                    Символов: {String(formData.mp_ym_description || '').length}
                  </div>
                </div>
                {isMpFieldLinked(formData.mp_field_links, 'sku', 'ym') && (
                  <div className="col-12">
                    <div className="mp-linked-dims-preview">
                      <span>
                        <span className="text-muted">Артикул:</span> {formData.sku || '—'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Характеристики Яндекс.Маркета (по категории)</div>
            <div className="card-body">
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: 10 }}>
                Параметры категории ({ymFormAttributes.length}
                {ymCategoryAttributes.length > ymFormAttributes.length
                  ? `, без дублей габаритов/страны/артикула: −${ymCategoryAttributes.length - ymFormAttributes.length}`
                  : ''}
                ), включая пустые. Обязательные сверху. Габариты и страна — в блоке выше.
              </div>
              {formData.categoryId && categoryDetailsLoading ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Загрузка данных категории…</div>
              ) : !formData.categoryId ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Выберите категорию товара на вкладке «Основное», чтобы подгрузить характеристики Маркета.</div>
              ) : !ymMarketCategoryId ? (
                <div className="alert alert-warning py-2 mb-0" style={{ fontSize: '12px' }}>
                  Для выбранной категории не задано сопоставление Яндекс.Маркета (<code>marketplace_mappings.ym</code>).
                  Укажите <strong>листовую</strong> категорию Маркета в разделе «Категории» → редактирование категории → блок YM.
                </div>
              ) : ymCategoryAttributesError ? (
                <div className="alert alert-danger py-2 mb-0" style={{ fontSize: '12px' }}>
                  {ymCategoryAttributesError}
                  <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--muted)' }}>
                    Нужны API Key с правом «Управление товарами и карточками» и листовая категория (без дочерних в дереве Маркета).
                    При необходимости укажите <code>business_id</code> или <code>campaign_id</code> в интеграции Яндекс — для параметров, зависящих от кабинета.
                  </div>
                </div>
              ) : ymCategoryAttributesLoading ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Загрузка характеристик категории…</div>
              ) : ymFormAttributes.length === 0 ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>
                  Маркет не вернул характеристик для этой категории (или категория не листовая). Проверьте сопоставление или выберите конечную категорию в дереве YM.
                </div>
              ) : (
                <div className="row g-3">
                  {ymFormAttributes.map((a) => {
                    const key = String(a.id);
                    const name = a.name || `Параметр ${key}`;
                    const required = Boolean(a.required);
                    const byIdRaw = ymAttributeValues[key];
                    const nameNorm = String(name).trim().toLowerCase();
                    const keyWithIdPattern = `(${key})`;
                    const fallbackKey = Object.keys(ymAttributeValues).find((k) => {
                      const kk = String(k).trim();
                      const kkNorm = kk.toLowerCase();
                      if (kkNorm === nameNorm) return true;
                      // Частый формат из Excel/текста: "Комплект (14805799)"
                      if (kk.includes(keyWithIdPattern)) return true;
                      // Запасной вариант: id может быть указан без скобок
                      if (kkNorm.endsWith(` ${key}`) || kkNorm === key) return true;
                      return false;
                    });
                    const raw = byIdRaw !== undefined ? byIdRaw : (fallbackKey ? ymAttributeValues[fallbackKey] : undefined);
                    const valueStr = (() => {
                      if (raw === undefined || raw === null) return '';
                      if (Array.isArray(raw)) {
                        const first = raw[0];
                        if (first == null) return '';
                        if (typeof first === 'object') {
                          return String(
                            first.dictionary_value_id ??
                            first.id ??
                            first.value ??
                            first.label ??
                            ''
                          ).trim();
                        }
                        return String(first).trim();
                      }
                      if (typeof raw === 'object') {
                        return String(
                          raw.dictionary_value_id ??
                          raw.id ??
                          raw.value ??
                          raw.label ??
                          ''
                        ).trim();
                      }
                      return String(raw).trim();
                    })();
                    const setVal = (v) => setYmAttributeValues((prev) => ({ ...prev, [key]: v }));

                    if (a.type === 'dictionary' && Array.isArray(a.dictionary_options) && a.dictionary_options.length > 0) {
                      const normalizeToken = (s) =>
                        String(s || '')
                          .trim()
                          .toLowerCase()
                          .replace(/[;:.,\s]+$/g, '');
                      const resolvedSelectValue = (() => {
                        const direct = a.dictionary_options.find((o) => String(o.id) === valueStr);
                        if (direct) return valueStr;
                        const byLabel = a.dictionary_options.find(
                          (o) => normalizeToken(o.label) === normalizeToken(valueStr)
                        );
                        if (byLabel) return String(byLabel.id);
                        const byLabelContains = a.dictionary_options.find((o) => {
                          const label = normalizeToken(o.label);
                          const v = normalizeToken(valueStr);
                          return v && (label.includes(v) || v.includes(label));
                        });
                        if (byLabelContains) return String(byLabelContains.id);
                        // Частый кейс: в Excel ввели "Да/Нет" текстом, а в YM нужен id значения ENUM
                        const yesNoNormalized = normalizeToken(valueStr);
                        if (yesNoNormalized === 'да' || yesNoNormalized === 'yes' || yesNoNormalized === 'true') {
                          const yesOption = a.dictionary_options.find((o) => {
                            const label = normalizeToken(o.label);
                            return label === 'да' || label === 'yes' || label === 'true';
                          });
                          if (yesOption) return String(yesOption.id);
                          const yesById = a.dictionary_options.find((o) => {
                            const id = normalizeToken(o.id);
                            return id === '1' || id === 'true' || id === 'yes';
                          });
                          if (yesById) return String(yesById.id);
                        }
                        if (yesNoNormalized === 'нет' || yesNoNormalized === 'no' || yesNoNormalized === 'false') {
                          const noOption = a.dictionary_options.find((o) => {
                            const label = normalizeToken(o.label);
                            return label === 'нет' || label === 'no' || label === 'false';
                          });
                          if (noOption) return String(noOption.id);
                          const noById = a.dictionary_options.find((o) => {
                            const id = normalizeToken(o.id);
                            return id === '0' || id === 'false' || id === 'no';
                          });
                          if (noById) return String(noById.id);
                        }
                        return '';
                      })();
                      const unresolvedValue = resolvedSelectValue === '' && valueStr ? `__raw:${valueStr}` : '';
                      return (
                        <div key={key} className="col-12 col-md-6 col-lg-4">
                          <label className="form-label" htmlFor={`ym-attr-${key}`}>
                            {name}
                            {required ? <span style={{ color: '#ef4444' }}> *</span> : null}
                            <span style={{ fontSize: '10px', color: 'var(--muted)', marginLeft: '4px' }}>(ENUM)</span>
                          </label>
                          <select
                            id={`ym-attr-${key}`}
                            className={mpAttrClass('form-select form-select-sm', 'ym', key, valueStr)}
                            value={resolvedSelectValue || unresolvedValue}
                            onChange={(e) => setVal(e.target.value)}
                          >
                            <option value="">— Не выбрано —</option>
                            {unresolvedValue && (
                              <option value={unresolvedValue}>
                                Текущее значение: {valueStr}
                              </option>
                            )}
                            {a.dictionary_options.map((o) => (
                              <option key={String(o.id)} value={String(o.id)}>{o.label}</option>
                            ))}
                          </select>
                          {a.description ? <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>{a.description}</div> : null}
                        </div>
                      );
                    }
                    if (a.type === 'boolean') {
                      const boolValue = (() => {
                        const t = String(valueStr || '')
                          .trim()
                          .toLowerCase()
                          .replace(/[;:.,\s]+$/g, '');
                        if (t === 'true' || t === '1' || t === 'yes' || t === 'да') return 'true';
                        if (t === 'false' || t === '0' || t === 'no' || t === 'нет') return 'false';
                        return '';
                      })();
                      return (
                        <div key={key} className="col-12 col-md-6 col-lg-4">
                          <label className="form-label" htmlFor={`ym-attr-${key}`}>
                            {name}
                            {required ? <span style={{ color: '#ef4444' }}> *</span> : null}
                          </label>
                          <select
                            id={`ym-attr-${key}`}
                            className={mpAttrClass('form-select form-select-sm', 'ym', key, boolValue)}
                            value={boolValue}
                            onChange={(e) => setVal(e.target.value)}
                          >
                            <option value="">— Не задано —</option>
                            <option value="true">Да</option>
                            <option value="false">Нет</option>
                          </select>
                        </div>
                      );
                    }
                    if (a.type === 'number') {
                      return (
                        <div key={key} className="col-12 col-md-6 col-lg-4">
                          <label className="form-label" htmlFor={`ym-attr-${key}`}>
                            {name}
                            {required ? <span style={{ color: '#ef4444' }}> *</span> : null}
                          </label>
                          <input
                            id={`ym-attr-${key}`}
                            type="number"
                            className={mpAttrClass('form-control form-control-sm', 'ym', key, valueStr)}
                            value={valueStr}
                            onChange={(e) => setVal(e.target.value)}
                            step="any"
                          />
                        </div>
                      );
                    }
                    return (
                      <div key={key} className="col-12 col-md-6 col-lg-4">
                        <label className="form-label" htmlFor={`ym-attr-${key}`}>
                          {name}
                          {required ? <span style={{ color: '#ef4444' }}> *</span> : null}
                          {a.ym_parameter_type ? (
                            <span style={{ fontSize: '10px', color: 'var(--muted)', marginLeft: '4px' }}>({a.ym_parameter_type})</span>
                          ) : null}
                        </label>
                        <input
                          id={`ym-attr-${key}`}
                          type="text"
                          className={mpAttrClass('form-control form-control-sm', 'ym', key, valueStr)}
                          value={valueStr}
                          onChange={(e) => setVal(e.target.value)}
                        />
                        {a.description ? <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>{a.description}</div> : null}
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }}>
                Значения сохраняются в товаре как <code>ym_attributes</code> (id параметра → значение; для ENUM — id варианта из справочника Маркета).
              </div>
            </div>
          </div>

        </div>
      )}

      {activeTab === 'competitors' && (
        <ProductCompetitorsTab
          productId={currentProduct?.id || product?.id || null}
          productCost={formData.cost !== '' && formData.cost != null ? formData.cost : currentProduct?.cost}
        />
      )}

    </form>
      <div className="product-form__footer">
        <div className="product-form__footer-inner">
          {currentProduct?.id && onDeleteProduct && participationFlags.canDelete ? (
            <Button
              type="button"
              variant="danger"
              onClick={() => onDeleteProduct(currentProduct.id)}
            >
              Удалить
            </Button>
          ) : null}
          {currentProduct?.id && onArchiveProduct && participationFlags.canArchive ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => onArchiveProduct(currentProduct.id)}
              title={
                participationFlags.reasons.length
                  ? `Есть: ${participationFlags.reasons.join(', ')}`
                  : undefined
              }
            >
              Отправить в архив
            </Button>
          ) : null}
          {currentProduct?.id ? (
            <Button
              type="button"
              variant="secondary"
              disabled={labelPrinting || !formData.categoryId}
              title={
                !formData.categoryId
                  ? 'Укажите категорию товара для печати этикетки'
                  : 'Печать стикера по шаблону категории'
              }
              onClick={() => {
                if (!canUsePrintHelper(printHelperUrl)) {
                  openProductLabelPrintTab(currentProduct.id);
                  return;
                }
                printProductLabel(currentProduct.id);
              }}
            >
              {labelPrinting ? 'Печать…' : 'Печать стикера'}
            </Button>
          ) : null}
          <Button type="submit" form={productFormDomId} variant="primary">
            Сохранить
          </Button>
          {labelPrintError ? (
            <span className="product-form__label-print-error" role="alert">
              {labelPrintError}
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
});

