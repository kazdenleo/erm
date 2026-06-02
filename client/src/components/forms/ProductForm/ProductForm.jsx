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
import { ProductMarketplaceLinkSection } from './ProductMarketplaceLinkSection.jsx';
import {
  canUsePrintHelper,
  openProductLabelPrintTab,
  useProductLabelPrint,
} from '../../../hooks/useProductLabelPrint.js';
import { resolveApiBaseUrl } from '../../../services/api.js';
import { createAsyncQueue } from '../../../utils/asyncQueue.js';
import {
  BARCODE_MP_TOGGLES,
  EMPTY_BARCODE_ROW,
  barcodesForForm,
  normalizeBarcodeRows,
} from '../../../utils/productBarcodes.js';
import { MarketplaceToggle } from '../../common/MarketplaceToggle/MarketplaceToggle.jsx';
import './ProductForm.css';

const TYPE_LABELS = { text: 'Текст', checkbox: 'Флажок', number: 'Число', date: 'Дата', dictionary: 'Словарь' };

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

const COUNTRY_OPTIONS = [
  'Россия',
  'Китай',
  'Беларусь',
  'Казахстан',
  'Узбекистан',
  'Турция',
  'Индия',
  'Вьетнам',
  'Таиланд',
  'Южная Корея',
  'Япония',
  'Германия',
  'Франция',
  'Италия',
  'Испания',
  'Польша',
  'Чехия',
  'Словакия',
  'Венгрия',
  'США',
  'Канада',
  'Мексика',
  'Бразилия',
  'Аргентина',
  'ОАЭ',
  'Египет',
  'ЮАР',
  'Иран',
  'Пакистан',
  'Индонезия',
  'Малайзия',
  'Сингапур',
  'Тайвань',
  'Нидерланды',
  'Бельгия',
  'Австрия',
  'Швейцария',
  'Швеция',
  'Норвегия',
  'Финляндия',
  'Дания',
  'Португалия',
  'Румыния',
  'Болгария',
  'Сербия',
  'Австралия',
  'Новая Зеландия'
];

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

const EMPTY_PRODUCT_FORM_DATA = {
    name: '',
    sku: '',
    product_type: 'product',
    categoryId: '',
    organizationId: '',
    brand: '',
  country_of_origin: '',
    cost: '',
  additionalExpenses: '',
    minPrice: '',
    description: '',
    sku_ozon: '',
    /** Редактируемое поле числового product_id Ozon (сохраняется как marketplace_ozon_product_id) */
    ozon_product_id: '',
    sku_wb: '',
    sku_ym: '',
    buyout_rate: 95,
    barcodes: [{ ...EMPTY_BARCODE_ROW }],
    weight: '',
    length: '',
    width: '',
    height: '',
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
  mp_ozon_brand: ''
};

export function ProductForm({
  product,
  categories = [],
  brands = [],
  organizations = [],
  products = [],
  /** Фильтр организации со страницы списка — если в карточке не выбрана, подставляем для поиска комплектующих */
  productsListOrganizationId = '',
  onSubmit,
  onCancel: _onCancel,
  onProductUpdate,
  onDeleteProduct,
  onArchiveProduct,
  canDeleteProduct = false,
  canArchiveProduct = false,
}) {
  const productFormDomId = useId();
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
  const [activeTab, setActiveTab] = useState('main');
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
  // Images (ERP storage + targeting marketplaces)
  const [productImages, setProductImages] = useState([]);
  const [imageUploadLoading, setImageUploadLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageDropActive, setImageDropActive] = useState(false);
  const imageFileInputRef = useRef(null);
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
      setYmAttributeValues({});
      setProductImages([]);
      setImageError('');
      ozonFilledFromProductIdRef.current = null;
      ozonSyncedFromFetchedRef.current = null;
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
      setCalculatedVolume('');
      setErrors({});
      setActiveTab('main');
      ozonFilledFromProductIdRef.current = null;
      ozonSyncedFromFetchedRef.current = null;
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
      
      setFormData({
        name: currentProduct.name || '',
        sku: currentProduct.sku || '',
        product_type: currentProduct.product_type === 'kit' ? 'kit' : 'product',
        categoryId: (currentProduct.categoryId ?? currentProduct.user_category_id ?? '').toString(),
        organizationId: currentProduct.organization_id != null ? String(currentProduct.organization_id) : (currentProduct.organizationId != null ? String(currentProduct.organizationId) : ''),
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
        description: currentProduct.description || '',
        sku_ozon: currentProduct.sku_ozon || '',
        ozon_product_id:
          currentProduct.ozon_product_id != null && currentProduct.ozon_product_id !== ''
            ? String(currentProduct.ozon_product_id)
            : '',
        sku_wb: currentProduct.sku_wb || '',
        sku_ym: currentProduct.sku_ym || '',
        buyout_rate: buyoutRate,
        barcodes: barcodesForForm(currentProduct.barcodes),
        weight: currentProduct.weight || '',
        length: currentProduct.length || '',
        width: currentProduct.width || '',
        height: currentProduct.height || '',
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
        mp_ozon_brand: currentProduct.mp_ozon_brand || ''
      });
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

    const pickStr = (a, b) => {
      const v = a != null ? a : b;
      if (v === undefined || v === null) return '';
      const s = String(v).trim();
      return s;
    };

    const pickDate = (a, b) => {
      const s = pickStr(a, b);
      if (!s) return '';
      // ISO datetime -> date-only
      return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
    };

    const certificate = {
      number: pickStr(cat.certificate_number, br.certificate_number || cat.certificateNumber),
      validFrom: pickDate(cat.certificate_valid_from, br.certificate_valid_from),
      validTo: pickDate(cat.certificate_valid_to, br.certificate_valid_to),
    };
    const declaration = {
      number: pickStr(cat.declaration_number, br.declaration_number),
      validFrom: pickDate(cat.declaration_valid_from, br.declaration_valid_from),
      validTo: pickDate(cat.declaration_valid_to, br.declaration_valid_to),
    };
    const registration = {
      number: pickStr(cat.registration_number, br.registration_number),
      validFrom: pickDate(cat.registration_valid_from, br.registration_valid_from),
      validTo: pickDate(cat.registration_valid_to, br.registration_valid_to),
    };

    // сохраняем совместимые поля для уже существующих useEffect'ов (Ozon/YM)
    return {
      certificate,
      declaration,
      registration,
      number: certificate.number ? String(certificate.number).slice(0, 1000) : '',
      validFrom: certificate.validFrom,
      validTo: certificate.validTo
    };
  }, [selectedCategoryForCert, selectedBrandForCert]);

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
    if (!certSource.number && !certSource.validFrom && !certSource.validTo) return;
    setOzonAttributeValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const attr of ozonAttributes) {
        const key = String(attr.id);
        if (!isEmptyMarketplaceValue(next[key])) continue;
        const n = normalizeAttrName(attr?.name);
        const isDoc = /номер/.test(n) && /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        const isFrom = /(дата начала|начал.*действ)/.test(n) && /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        const isTo = /(дата оконч|срок действ|действителен до|окончан.*действ)/.test(n) && /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        if (isDoc && certSource.number) {
          next[key] = certSource.number;
          changed = true;
        } else if (isFrom && certSource.validFrom) {
          next[key] = certSource.validFrom;
          changed = true;
        } else if (isTo && certSource.validTo) {
          next[key] = certSource.validTo;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [ozonAttributes, certSource]);

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

  // Автоподстановка значений документа в WB-атрибуты по названию поля
  useEffect(() => {
    if (!wbCategoryAttributes?.length) return;
    const hasAnyDoc =
      Boolean(certSource?.certificate?.number || certSource?.certificate?.validFrom || certSource?.certificate?.validTo ||
        certSource?.declaration?.number || certSource?.declaration?.validFrom || certSource?.declaration?.validTo ||
        certSource?.registration?.number || certSource?.registration?.validFrom || certSource?.registration?.validTo);
    if (!hasAnyDoc) return;
    setWbAttributeValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const a of wbCategoryAttributes) {
        const id = a?.charcID ?? a?.characteristic_id ?? a?.id ?? a?.attribute_id ?? a?.name;
        const key = id != null ? String(id) : String(a?.name || '');
        if (!isEmptyMarketplaceValue(next[key])) continue;
        const name = a?.name ?? a?.charcName ?? a?.characteristic_name ?? '';
        const n = normalizeAttrName(name);
        const hasDocKeyword = /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        const explicitDeclaration = /декларац/.test(n);
        const explicitRegistration = /свидетельств/.test(n) || /сгр/.test(n);
        const explicitCertificate = /сертифик/.test(n);
        const mentionedTypesCount =
          (explicitDeclaration ? 1 : 0) +
          (explicitRegistration ? 1 : 0) +
          (explicitCertificate ? 1 : 0);
        // Если в названии упомянуто сразу несколько типов ("сертификата/декларации") — считаем поле обобщённым и разрешаем fallback
        const explicitType = mentionedTypesCount === 1;

        const docType =
          explicitDeclaration
            ? 'declaration'
            : explicitRegistration
              ? 'registration'
              : 'certificate';
        const doc = certSource?.[docType] || certSource?.certificate || {};

        const isNumberAttr = /номер/.test(n) && hasDocKeyword;
        const isRegDateAttr = /дата регистрац/.test(n) && hasDocKeyword;
        const isFromAttr = (/(дата начала|начал.*действ)/.test(n) || isRegDateAttr) && hasDocKeyword;
        const isToAttr = /(дата оконч|срок действ|действителен до|окончан.*действ)/.test(n) && hasDocKeyword;

        if (isNumberAttr && doc?.number) {
          next[key] = doc.number;
          changed = true;
        } else if (isNumberAttr && !explicitType) {
          // Только для "обобщённых" полей (без явного типа документа) — подставляем любое доступное
          const fallbackNumber = certSource?.certificate?.number || certSource?.declaration?.number || certSource?.registration?.number;
          if (fallbackNumber) {
            next[key] = fallbackNumber;
            changed = true;
          }
        } else if (isFromAttr && doc?.validFrom) {
          next[key] = doc.validFrom;
          changed = true;
        } else if (isFromAttr && !explicitType) {
          const fallbackFrom = certSource?.certificate?.validFrom || certSource?.declaration?.validFrom || certSource?.registration?.validFrom;
          if (fallbackFrom) {
            next[key] = fallbackFrom;
            changed = true;
          }
        } else if (isToAttr && doc?.validTo) {
          next[key] = doc.validTo;
          changed = true;
        } else if (isToAttr && !explicitType) {
          const fallbackTo = certSource?.certificate?.validTo || certSource?.declaration?.validTo || certSource?.registration?.validTo;
          if (fallbackTo) {
            next[key] = fallbackTo;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [wbCategoryAttributes, certSource]);

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
    let cancelled = false;
    setYmCategoryAttributesLoading(true);
    setYmCategoryAttributesError('');
    userCategoriesApi.getMarketplaceAttributes(userCategoryId, 'ym')
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
  }, [activeTab, formData.categoryId, ymMarketCategoryId]);

  // Автоподстановка значений документа в YM-атрибуты по названию параметра
  useEffect(() => {
    if (!ymCategoryAttributes?.length) return;
    if (!certSource.number && !certSource.validFrom && !certSource.validTo) return;
    setYmAttributeValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const a of ymCategoryAttributes) {
        const key = String(a.id);
        if (!isEmptyMarketplaceValue(next[key])) continue;
        const n = normalizeAttrName(a?.name);
        const isDoc = /номер/.test(n) && /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        const isFrom = /(дата начала|начал.*действ)/.test(n) && /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        const isTo = /(дата оконч|срок действ|действителен до|окончан.*действ)/.test(n) && /(сертифик|декларац|свидетельств|сгр|документ)/.test(n);
        if (isDoc && certSource.number) {
          next[key] = certSource.number;
          changed = true;
        } else if (isFrom && certSource.validFrom) {
          next[key] = certSource.validFrom;
          changed = true;
        } else if (isTo && certSource.validTo) {
          next[key] = certSource.validTo;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [ymCategoryAttributes, certSource]);

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
      const next = { ...prev };
      if (name) next.mp_ozon_name = name;
      if (description) next.mp_ozon_description = description;
      if (brand) next.mp_ozon_brand = brand;
      if (data.weight != null && (!prev.weight || String(prev.weight).trim() === '')) {
        next.weight = String(data.weight);
      }
      const dx = data.dimension_x ?? data.width;
      const dy = data.dimension_y ?? data.height;
      const dz = data.dimension_z ?? data.length;
      if (dx != null && (!prev.width || String(prev.width).trim() === '')) next.width = String(dx);
      if (dy != null && (!prev.height || String(prev.height).trim() === '')) next.height = String(dy);
      if (dz != null && (!prev.length || String(prev.length).trim() === '')) next.length = String(dz);
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
      setOzonSyncError('Укажите артикул Ozon (offer_id), product_id карточки Ozon или артикул ERP.');
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
            ? ` Проверьте offer_id Ozon (например «${offerIds.find((o) => o !== formData.sku) || offerIds[0]}»), он может отличаться от артикула ERP.`
            : '';
        setOzonSyncError(`Товар не найден в кабинете Ozon выбранной организации.${hint}`);
        return;
      }
      setSyncedOzonProductId(data.id != null ? Number(data.id) : null);
      setOzonFetchedProduct(data);
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

    const skus = Array.isArray(p.sizes) ? (p.sizes.flatMap((s) => (Array.isArray(s?.skus) ? s.skus : []))) : [];
    const barcodes = [...new Set(skus.map((x) => String(x).trim()).filter(Boolean))];

    setFormData((prev) => {
      const next = { ...prev };
      if (name) next.mp_wb_name = name;
      if (description) next.mp_wb_description = description;
      if (brand) next.mp_wb_brand = brand;
      if (vendorCode) next.mp_wb_vendor_code = vendorCode;
      if (wG != null && (!prev.weight || String(prev.weight).trim() === '')) next.weight = String(wG);
      if (lMm != null && (!prev.length || String(prev.length).trim() === '')) next.length = String(lMm);
      if (wMm != null && (!prev.width || String(prev.width).trim() === '')) next.width = String(wMm);
      if (hMm != null && (!prev.height || String(prev.height).trim() === '')) next.height = String(hMm);
      if (barcodes.length > 0 && (!Array.isArray(prev.barcodes) || prev.barcodes.every((b) => !String((b?.barcode ?? b) || '').trim()))) {
        next.barcodes = barcodes.map((b) => ({ barcode: b, marketplaces: [] }));
      }
      return next;
    });
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
      skuWbRaw && !nmId ? skuWbRaw : null
    ]
      .map((v) => (v != null && String(v).trim() !== '' ? String(v).trim() : ''))
      .filter(Boolean);
    const vendorCodes = [...new Set(vendorCandidates)];
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
      if (nmId) {
        try {
          data = await integrationsApi.getWildberriesProductInfo({ ...apiBase, nm_id: nmId });
        } catch (e) {
          lastErr = e;
        }
      }
      for (const vendorCode of vendorCodes) {
        if (data) break;
        try {
          data = await integrationsApi.getWildberriesProductInfo({ ...apiBase, vendor_code: vendorCode });
        } catch (e) {
          lastErr = e;
        }
      }
      if (!data) {
        if (lastErr) throw lastErr;
        setWbSyncError('Товар не найден в кабинете Wildberries выбранной организации.');
        return;
      }
      setWbFetchedProduct(data);
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
    formData.organizationId,
    productsListOrganizationId,
    currentProduct?.mp_wb_vendor_code,
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
      setYmSyncError('Укажите offerId (артикул Яндекс.Маркет) или артикул ERP.');
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
      const resolvedOfferId = String(data.offerId ?? offerId).trim();
      const name = data.name != null ? String(data.name).trim() : '';
      const description = data.description != null ? String(data.description).trim() : '';
      setFormData((prev) => {
        const next = { ...prev };
        if (resolvedOfferId) next.sku_ym = resolvedOfferId;
        if (name) next.mp_ym_name = name;
        if (description) next.mp_ym_description = description;
        return next;
      });
      if (Array.isArray(data.parameterValues) && data.parameterValues.length > 0) {
        setYmAttributeValues((prev) => {
          const next = { ...prev };
          data.parameterValues.forEach((pv) => {
            const pid = pv?.parameterId ?? pv?.id;
            if (pid == null) return;
            const key = String(pid);
            if (next[key] != null && String(next[key]).trim() !== '') return;
            let val = pv?.value ?? pv?.optionId ?? pv?.dictionaryValueId ?? pv?.id;
            if (val != null && typeof val === 'object') {
              val = val.value ?? val.id ?? val.label ?? '';
            }
            if (val != null && String(val).trim() !== '') {
              next[key] = String(val).trim();
            }
          });
          return next;
        });
      }
      const wd = data.weightDimensions && typeof data.weightDimensions === 'object' ? data.weightDimensions : null;
      if (wd) {
        setFormData((prev) => {
          const next = { ...prev };
          const wG = wd.weight != null ? Number(wd.weight) : NaN;
          const lMm = wd.length != null ? Number(wd.length) : NaN;
          const wMm = wd.width != null ? Number(wd.width) : NaN;
          const hMm = wd.height != null ? Number(wd.height) : NaN;
          if (Number.isFinite(wG) && wG > 0 && (!prev.weight || String(prev.weight).trim() === '')) {
            next.weight = String(Math.round(wG));
          }
          if (Number.isFinite(lMm) && lMm > 0 && (!prev.length || String(prev.length).trim() === '')) {
            next.length = String(Math.round(lMm));
          }
          if (Number.isFinite(wMm) && wMm > 0 && (!prev.width || String(prev.width).trim() === '')) {
            next.width = String(Math.round(wMm));
          }
          if (Number.isFinite(hMm) && hMm > 0 && (!prev.height || String(prev.height).trim() === '')) {
            next.height = String(Math.round(hMm));
          }
          return next;
        });
      }
      setYmSyncSuccess('Данные с Яндекс.Маркета загружены: артикул, название, описание и характеристики. Сохраните товар.');
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message ?? 'Ошибка при загрузке данных с Яндекс.Маркета.';
      setYmSyncError(msg);
    } finally {
      setYmSyncLoading(false);
    }
  }, [formData.sku_ym, formData.sku, formData.organizationId, productsListOrganizationId]);

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
    } else {
      setFormData(prev => ({ ...prev, [field]: value }));
    }
    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const handleMarketplaceLinked = (updatedProduct) => {
    if (!updatedProduct) return;
    setCurrentProduct(updatedProduct);
    setFormData((prev) => ({
      ...prev,
      sku_ozon: updatedProduct.sku_ozon ?? prev.sku_ozon,
      ozon_product_id:
        updatedProduct.ozon_product_id != null && updatedProduct.ozon_product_id !== ''
          ? String(updatedProduct.ozon_product_id)
          : prev.ozon_product_id,
      sku_wb: updatedProduct.sku_wb ?? prev.sku_wb,
      mp_wb_vendor_code: updatedProduct.mp_wb_vendor_code ?? prev.mp_wb_vendor_code,
      sku_ym: updatedProduct.sku_ym ?? prev.sku_ym,
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
      }
    } catch (e) {
      setPushCardError(e?.response?.data?.message || e?.message || 'Ошибка отправки на маркетплейс');
    } finally {
      setPushCardLoading(null);
    }
  };

  const handleBarcodeChange = (index, value) => {
    setFormData((prev) => {
      const newBarcodes = prev.barcodes.map((row, i) =>
        i === index ? { ...row, barcode: value } : row
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
      unit: 'шт',
      description: formData.description.trim() || null,
      sku_ozon: toSku(formData.sku_ozon),
      sku_wb: toSku(formData.sku_wb),
      sku_ym: toSku(formData.sku_ym),
      mp_ozon_name: trimOrNull(formData.mp_ozon_name),
      mp_ozon_description: trimOrNull(formData.mp_ozon_description),
      mp_ozon_brand: trimOrNull(formData.mp_ozon_brand),
      mp_wb_vendor_code: trimOrNull(formData.mp_wb_vendor_code),
      mp_wb_name: trimOrNull(formData.mp_wb_name),
      mp_wb_description: trimOrNull(formData.mp_wb_description),
      mp_wb_brand: trimOrNull(formData.mp_wb_brand),
      mp_ym_name: trimOrNull(formData.mp_ym_name),
      mp_ym_description: trimOrNull(formData.mp_ym_description),
      buyout_rate: formData.buyout_rate ? parseFloat(formData.buyout_rate) : 95,
      barcodes: filteredBarcodes,
      weight: formData.weight ? parseFloat(formData.weight) : null,
      length: formData.length ? parseFloat(formData.length) : null,
      width: formData.width ? parseFloat(formData.width) : null,
      height: formData.height ? parseFloat(formData.height) : null,
      volume: calculatedVolume ? parseFloat(calculatedVolume) : (formData.volume ? parseFloat(formData.volume) : null),
      kit_components: formData.product_type === 'kit' && Array.isArray(formData.kit_components)
        ? formData.kit_components.filter(c => c.productId).map(c => ({ productId: Number(c.productId), quantity: Math.max(1, parseInt(c.quantity, 10) || 1) }))
        : [],
      attribute_values: attributeValuesPayload,
      ozon_attributes: ozonAttributesPayload,
      wb_attributes: wbAttributesPayload,
      ym_attributes: Object.keys(ymAttributeValues).length > 0 ? ymAttributeValues : undefined,
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
    };

    return payload;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const payload = buildProductSubmitPayload();
    if (!payload) return;
    onSubmit(payload);
  };

  const tabButtons = [
    { id: 'main', label: 'Основное' },
    { id: 'ozon', label: 'Ozon' },
    { id: 'wb', label: 'Wildberries' },
    { id: 'ym', label: 'Яндекс.Маркет' }
  ];

  return (
    <>
    <form id={productFormDomId} className="product-form" onSubmit={handleSubmit}>
      <ul className="nav nav-tabs mb-3">
        {tabButtons.map((tab) => (
          <li key={tab.id} className="nav-item" role="presentation">
            <button
              type="button"
              className={`nav-link ${activeTab === tab.id ? 'active' : ''}`}
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
          <label className="form-label" htmlFor="name">
          Название <span style={{color: '#ef4444'}}>*</span>
        </label>
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
          <label className="form-label" htmlFor="sku">
            Артикул (SKU) <span style={{color: '#ef4444'}}>*</span>
          </label>
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
        <label className="form-label" htmlFor="description">Описание</label>
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

      {/* Характеристики упаковки */}
      <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)' }}>
          📦 Характеристики упаковки
        </h3>
        <div className="row g-3">
          <div className="col-md-2">
            <label className="form-label" htmlFor="length">Длина (мм)</label>
            <input
              id="length"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="например, 150"
              value={formData.length}
              onChange={(e) => handleChange('length', e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label" htmlFor="width">Ширина (мм)</label>
            <input
              id="width"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="например, 100"
              value={formData.width}
              onChange={(e) => handleChange('width', e.target.value)}
            />
          </div>
          <div className="col-md-2">
            <label className="form-label" htmlFor="height">Высота (мм)</label>
            <input
              id="height"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="например, 50"
              value={formData.height}
              onChange={(e) => handleChange('height', e.target.value)}
            />
          </div>
          <div className="col-md-3">
            <label className="form-label" htmlFor="weight">Вес (г)</label>
            <input
              id="weight"
              type="number"
              className="form-control form-control-sm"
              step="1"
              min="0"
              placeholder="например, 250"
              value={formData.weight}
              onChange={(e) => handleChange('weight', e.target.value)}
            />
          </div>
          <div className="col-md-3">
            <div className="form-label">Объем (л)</div>
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
              Рассчитывается из габаритов
            </div>
          </div>
        </div>
      </div>

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
        <select
          id="productType"
            className="form-select form-select-sm"
          value={formData.product_type}
          onChange={(e) => handleChange('product_type', e.target.value)}
        >
          <option value="product">Товар</option>
          <option value="kit">Комплект</option>
        </select>
      </div>
        <div className="col-12 col-md-auto">
      {formData.product_type === 'kit' && (
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

        <div className="col-md-6">
          <label className="form-label" htmlFor="brand">Бренд</label>
            <select
              id="brand"
            className="form-select form-select-sm"
              value={formData.brand}
              onChange={(e) => handleChange('brand', e.target.value)}
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
          <label className="form-label" htmlFor="country_of_origin">Страна производства</label>
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

      {categoryAttributes.length > 0 && (
        <div style={{ marginTop: '12px', padding: '12px', background: 'rgba(59, 130, 246, 0.06)', borderRadius: '8px', border: '1px solid var(--border, #e5e7eb)' }}>
          <h4 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text)' }}>
            Атрибуты категории
          </h4>
          <div className="row g-3">
            {categoryAttributes.map((attr) => {
              const key = String(attr.id);
              const value = formData.attributeValues[key];
              const rawValue = value !== undefined && value !== null ? value : '';
              if (attr.type === 'checkbox') {
                const checked = rawValue === 'true' || rawValue === true;
                return (
                  <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                    <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => handleAttributeChange(attr.id, e.target.checked ? 'true' : 'false')}
                      />
                      <span>{attr.name}</span>
                      {TYPE_LABELS[attr.type] && <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span>}
                    </label>
                  </div>
                );
              }
              if (attr.type === 'number') {
                return (
                  <div key={attr.id} className="col-12 col-md-6 col-lg-4 field">
                    <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span></label>
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
                    <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span></label>
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
                // Значение из Excel/импорта может отсутствовать в словаре — без отдельной <option> select показывает «Не выбрано» и при сохранении значение теряется
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
                    <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span></label>
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
                  <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type] || 'Текст'})</span></label>
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
        </div>
        <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
          {formData.barcodes.map((row, index) => (
            <div key={index} style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Введите баркод (EAN, UPC и т.д.)"
                value={row.barcode ?? ''}
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
        <div className="col-md-4">
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

        <div className="col-md-4">
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

        <div className="col-md-4">
          <label className="form-label" htmlFor="minPrice">Мин. чистая прибыль</label>
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
            Целевая прибыль в рублях (по умолчанию 50 ₽)
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
                Поля для выгрузки на Ozon (отдельно от вкладки «Основное»). После «Обновить с Ozon» подставляются автоматически.
              </p>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label" htmlFor="ozon-tab-name">Название (Ozon)</label>
                  <input
                    id="ozon-tab-name"
                    type="text"
                    className="form-control form-control-sm"
                    value={formData.mp_ozon_name}
                    onChange={(e) => handleChange('mp_ozon_name', e.target.value)}
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label" htmlFor="ozon-tab-brand">Бренд (Ozon)</label>
                  <input
                    id="ozon-tab-brand"
                    type="text"
                    className="form-control form-control-sm"
                    value={formData.mp_ozon_brand}
                    onChange={(e) => handleChange('mp_ozon_brand', e.target.value)}
                  />
                </div>
                <div className="col-12">
                  <label className="form-label" htmlFor="ozon-tab-description">Описание (Ozon)</label>
                  <textarea
                    id="ozon-tab-description"
                    className="form-control form-control-sm"
                    rows={5}
                    value={formData.mp_ozon_description}
                    onChange={(e) => handleChange('mp_ozon_description', e.target.value)}
                  />
                </div>
              </div>
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
                  {ozonFetchedProduct.barcode && (
                    <span><span style={{ color: 'var(--muted)' }}>Штрихкод:</span> {ozonFetchedProduct.barcode}</span>
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
                <div style={{ marginTop: '12px', borderTop: '1px solid rgba(0,91,255,0.2)', paddingTop: '12px' }}>
                  <button
                    type="button"
                    onClick={() => setOzonShowAllFields((v) => !v)}
                    style={{ fontSize: '12px', color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    {ozonShowAllFields ? 'Свернуть все поля' : 'Все поля (сырой ответ API)'}
                  </button>
                  {ozonShowAllFields && ozonFetchedProduct && (
                    <div style={{ marginTop: '8px', maxHeight: '320px', overflow: 'auto', fontSize: '11px', fontFamily: 'monospace' }}>
                      {Object.entries(ozonFetchedProduct).map(([key, value]) => {
                        let display = value;
                        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                          try {
                            display = JSON.stringify(value, null, 2);
                          } catch (_) {
                            display = String(value);
                          }
                        } else if (Array.isArray(value)) {
                          try {
                            display = JSON.stringify(value, null, 2);
                          } catch (_) {
                            display = String(value);
                          }
                        } else {
                          display = value == null ? '—' : String(value);
                        }
                        return (
                          <div key={key} style={{ marginBottom: '6px', wordBreak: 'break-all' }}>
                            <span style={{ color: 'var(--muted)', marginRight: '6px' }}>{key}:</span>
                            <span style={{ whiteSpace: 'pre-wrap' }}>{display}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
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
                  {ozonAttributes.map((attr) => {
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
                            className="form-select form-select-sm"
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
                                className="form-control form-control-sm"
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
                                className="form-control form-control-sm"
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
                  !String(formData.mp_wb_vendor_code || currentProduct?.mp_wb_vendor_code || '').trim()
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
                Поля только для WB (не совпадают с вкладкой «Основное»). nmId и vendorCode — в блоке «Связь с маркетплейсом» выше.
                После «Обновить данные с WB» значения подставляются сюда автоматически.
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
                  <label className="form-label" htmlFor="wb-tab-name-wb">Название (WB)</label>
                  <input
                    id="wb-tab-name-wb"
                    type="text"
                    className="form-control form-control-sm"
                    value={formData.mp_wb_name}
                    onChange={(e) => handleChange('mp_wb_name', e.target.value)}
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label" htmlFor="wb-tab-brand-wb">Бренд (WB)</label>
                  <input
                    id="wb-tab-brand-wb"
                    type="text"
                    className="form-control form-control-sm"
                    value={formData.mp_wb_brand}
                    onChange={(e) => handleChange('mp_wb_brand', e.target.value)}
                    placeholder="Текст для карточки WB"
                  />
                </div>
                <div className="col-12">
                  <label className="form-label" htmlFor="wb-tab-description">Описание (WB)</label>
        <textarea
                    id="wb-tab-description"
                    className="form-control form-control-sm"
                    rows={5}
                    value={formData.mp_wb_description}
                    onChange={(e) => handleChange('mp_wb_description', e.target.value)}
                    placeholder="Описание для Wildberries"
                  />
                </div>
              </div>
              {wbFetchedProduct && (
                <div className="mt-2 pt-2 border-top">
                  <button type="button" className="btn btn-link p-0" onClick={() => setWbShowAllFields((v) => !v)}>
                    {wbShowAllFields ? 'Свернуть сырой ответ API' : 'Сырой ответ API WB'}
                  </button>
                  {wbShowAllFields && (
                    <div style={{ marginTop: '8px', maxHeight: '280px', overflow: 'auto', fontSize: '11px', fontFamily: 'monospace' }}>
                      {Object.entries(wbFetchedProduct).map(([key, value]) => {
                        let display = value;
                        try {
                          if (value !== null && typeof value === 'object') display = JSON.stringify(value, null, 2);
                          else display = value == null ? '—' : String(value);
                        } catch (_) {
                          display = value == null ? '—' : String(value);
                        }
                        return (
                          <div key={key} style={{ marginBottom: '6px', wordBreak: 'break-all' }}>
                            <span style={{ color: 'var(--muted)', marginRight: '6px' }}>{key}:</span>
                            <span style={{ whiteSpace: 'pre-wrap' }}>{display}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
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
                      {wbCategoryAttributes.map((a) => {
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
                              className="form-control form-control-sm"
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
                              className="form-control form-control-sm"
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
                {ymFetchedProduct.name ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>Название:</span>{ymFetchedProduct.name}</div>
                ) : null}
                {ymFetchedProduct.description ? (
                  <div><span style={{ color: 'var(--muted)', marginRight: '6px' }}>Описание:</span>{ymFetchedProduct.description}</div>
                ) : null}
                {Array.isArray(ymFetchedProduct.parameterValues) && ymFetchedProduct.parameterValues.length > 0 ? (
                  <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                    Характеристик загружено: {ymFetchedProduct.parameterValues.length}
                  </div>
                ) : null}
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
                Отдельно от вкладки «Основное». В Excel — колонки «Название (Яндекс)» и «Описание (Яндекс)» в блоке YM.
              </p>
              <div className="row g-3">
                <div className="col-12">
                  <label className="form-label" htmlFor="ym-tab-name">Название (Яндекс)</label>
                  <input
                    id="ym-tab-name"
                    type="text"
                    className="form-control form-control-sm"
                    value={formData.mp_ym_name}
                    onChange={(e) => handleChange('mp_ym_name', e.target.value)}
                  />
                </div>
                <div className="col-12">
                  <label className="form-label" htmlFor="ym-tab-description">Описание (Яндекс)</label>
                  <textarea
                    id="ym-tab-description"
                    className="form-control form-control-sm"
                    rows={5}
                    value={formData.mp_ym_description}
                    onChange={(e) => handleChange('mp_ym_description', e.target.value)}
                    placeholder="Описание для Яндекс.Маркета"
                  />
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '6px' }}>
                    Символов: {String(formData.mp_ym_description || '').length}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card mt-3">
            <div className="card-header">Характеристики Яндекс.Маркета (по категории)</div>
            <div className="card-body">
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
              ) : ymCategoryAttributes.length === 0 ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>
                  Маркет не вернул характеристик для этой категории (или категория не листовая). Проверьте сопоставление или выберите конечную категорию в дереве YM.
                </div>
              ) : (
                <div className="row g-3">
                  {ymCategoryAttributes.map((a) => {
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
                            className="form-select form-select-sm"
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
                            className="form-select form-select-sm"
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
                            className="form-control form-control-sm"
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
                          className="form-control form-control-sm"
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
}

