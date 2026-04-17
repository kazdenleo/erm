/**
 * ProductForm Component
 * Форма создания/редактирования товара
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from '../../common/Button/Button';
import { Modal } from '../../common/Modal/Modal';
import { productAttributesApi } from '../../../services/productAttributes.api';
import { integrationsApi } from '../../../services/integrations.api';
import { productsApi } from '../../../services/products.api';
import { userCategoriesApi } from '../../../services/userCategories.api';
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
    sku_wb: '',
    sku_ym: '',
    buyout_rate: 95,
    barcodes: [''],
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
  mp_ym_description: ''
};

export function ProductForm({ product, categories = [], brands = [], organizations = [], products = [], onSubmit, onCancel, onProductUpdate }) {
  // Локальное состояние для хранения актуальных данных товара
  const [currentProduct, setCurrentProduct] = useState(product);

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
  const [kitComponentSearch, setKitComponentSearch] = useState('');
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
  // Images (ERP storage + targeting marketplaces)
  const [productImages, setProductImages] = useState([]);
  const [imageUploadLoading, setImageUploadLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageDropActive, setImageDropActive] = useState(false);
  const imageFileInputRef = useRef(null);
  /** ID товара Ozon, для которого уже подгружали справочники (чтобы не дергать при каждом вводе) */
  const ozonPreloadedForProductIdRef = useRef(null);
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
      setYmAttributeValues({});
      setProductImages([]);
      setImageError('');
      ozonPreloadedForProductIdRef.current = null;
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
      setCalculatedVolume('');
      setErrors({});
      setActiveTab('main');
      ozonPreloadedForProductIdRef.current = null;
      ozonFilledFromProductIdRef.current = null;
      ozonSyncedFromFetchedRef.current = null;
    }
  }, [product]);

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
        sku_wb: currentProduct.sku_wb || '',
        sku_ym: currentProduct.sku_ym || '',
        buyout_rate: buyoutRate,
        barcodes: currentProduct.barcodes && currentProduct.barcodes.length > 0 ? currentProduct.barcodes : [''],
        weight: currentProduct.weight || '',
        length: currentProduct.length || '',
        width: currentProduct.width || '',
        height: currentProduct.height || '',
        volume: currentProduct.volume || '',
        kit_components: Array.isArray(currentProduct.kit_components) && currentProduct.kit_components.length > 0
          ? currentProduct.kit_components.map(c => ({ productId: c.productId ?? c.component_product_id, quantity: c.quantity || 1 }))
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
        mp_ym_description: currentProduct.mp_ym_description || ''
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
        ? Object.fromEntries(Object.entries(currentProduct.wb_attributes).map(([k, v]) => [String(k), v]))
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
  const [categoryRefreshMsg, setCategoryRefreshMsg] = useState('');
  const fetchCategoryDetails = useCallback((cid) => {
    const id = cid ? String(cid).trim() : '';
    if (!id) return Promise.resolve(null);
    setCategoryRefreshMsg('');
    setCategoryDetailsLoading(true);
    return userCategoriesApi.getById(id)
      .then((res) => {
        const raw = res?.data ?? res;
        const cat = (raw && (raw.id != null || raw.name)) ? raw : (raw?.data && (raw.data.id != null || raw.data.name)) ? raw.data : null;
        let mm = cat?.marketplace_mappings ?? cat?.marketplaceMappings;
        if (typeof mm === 'string') {
          try { mm = JSON.parse(mm || '{}'); } catch (_) { mm = {}; }
        }
        const ozonVal = mm && typeof mm === 'object' ? (mm.ozon != null ? String(mm.ozon).trim() : '') : '';
        const ozonDisplay = mm?.ozon_display ?? mm?.ozonDisplay ?? '';
        const hasPathDisplay = typeof ozonDisplay === 'string' && (ozonDisplay.includes('>') || ozonDisplay.includes('›'));
        const hasType = ozonVal.includes('_') || (Number(mm?.ozon_type_id ?? mm?.ozonTypeId) > 0);
        setCategoryDetails(cat ? { ...cat } : null);
        let msg = 'Данные обновлены.';
        if (!hasType) {
          msg = hasPathDisplay
            ? 'Путь в категории есть, но id без типа. Категории → редактировать эту категорию → нажмите «Сохранить» (форма подставит тип по пути). Затем снова нажмите здесь «Обновить данные категории».'
            : 'В категории сохранён только уровень категории. Категории → редактировать → Ozon: «Обновить список» → выбрать пункт с подписью «Тип товара» → Сохранить.';
        }
        setCategoryRefreshMsg(msg);
        return cat;
      })
      .catch(() => {
        setCategoryDetails(null);
        setCategoryRefreshMsg('Ошибка загрузки категории.');
        return null;
      })
      .finally(() => setCategoryDetailsLoading(false));
  }, []);
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
    const subject = mm?.wb;
    const n = subject != null ? Number(subject) : 0;
    return Number.isFinite(n) ? n : 0;
  }, [formData.categoryId, categoryResolvedForMappings]);

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

  useEffect(() => {
    if (ozonTypeIdForApi > 0) setCategoryRefreshMsg('');
  }, [ozonTypeIdForApi]);

  // Загрузка схемы атрибутов Ozon по сопоставлению категории (сервер дополняет пару desc/type по дереву Ozon)
  useEffect(() => {
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
  }, [formData.categoryId, hasOzonMarketplaceMapping]);

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
        const isVatField = /\bндс\b/.test(n) || /ставк/.test(n) && /\bндс\b/.test(n) || /\bvat\b/.test(n);
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

  const loadOzonDictValues = useCallback((attrId) => {
    if (!ozonDescIdForApi || !ozonTypeIdForApi || ozonTypeIdForApi <= 0) return;
    integrationsApi.getOzonAttributeValues(attrId, ozonDescIdForApi, ozonTypeIdForApi, { limit: 500 })
      .then(({ result }) => {
        setOzonDictValues((prev) => ({ ...prev, [attrId]: result || [] }));
      })
      .catch((err) => {
        console.warn('[ProductForm] Ozon attribute values load failed:', err);
        setOzonDictValues((prev) => ({ ...prev, [attrId]: [] }));
      });
  }, [ozonDescIdForApi, ozonTypeIdForApi]);

  // Подгружаем справочники Ozon, если в товаре уже есть значение (текст/id из БД/Excel) — иначе селект без нужной <option>
  useEffect(() => {
    if (!ozonAttributes?.length || !ozonDescIdForApi || !ozonTypeIdForApi || ozonTypeIdForApi <= 0) return;
    ozonAttributes.forEach((attr) => {
      const hasDict = attr.dictionary_id != null && Number(attr.dictionary_id) !== 0;
      if (!hasDict) return;
      const v = ozonAttributeValues[String(attr.id)];
      if (v === undefined || v === null || String(v).trim() === '') return;
      if (Array.isArray(ozonDictValues[attr.id])) return;
      loadOzonDictValues(attr.id);
    });
  }, [ozonAttributes, ozonDescIdForApi, ozonTypeIdForApi, ozonAttributeValues, ozonDictValues, loadOzonDictValues]);

  // WB: загрузка атрибутов категории (схема) по сопоставлению user category
  useEffect(() => {
    const userCategoryId = formData.categoryId ? String(formData.categoryId).trim() : '';
    if (!userCategoryId || !wbSubjectId || wbSubjectId <= 0) {
      setWbCategoryAttributes([]);
      setWbCategoryAttributesError('');
      return;
    }
    let cancelled = false;
    setWbCategoryAttributesLoading(true);
    setWbCategoryAttributesError('');
    userCategoriesApi.getMarketplaceAttributes(userCategoryId, 'wb')
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? res;
        setWbCategoryAttributes(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[ProductForm] WB category attributes load failed:', err);
          setWbCategoryAttributes([]);
          const msg = err?.response?.data?.error || err?.message || 'Ошибка загрузки атрибутов WB.';
          setWbCategoryAttributesError(msg);
        }
      })
      .finally(() => { if (!cancelled) setWbCategoryAttributesLoading(false); });
    return () => { cancelled = true; };
  }, [formData.categoryId, wbSubjectId]);

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

  // Яндекс.Маркет: характеристики листовой категории (Partner API category/parameters)
  useEffect(() => {
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
  }, [formData.categoryId, ymMarketCategoryId]);

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

  const fetchOzonProductInfo = useCallback(async () => {
    const productId = currentProduct?.ozon_product_id != null ? Number(currentProduct.ozon_product_id) : null;
    const offerId = formData.sku_ozon != null && String(formData.sku_ozon).trim() !== '' ? String(formData.sku_ozon).trim() : null;
    if (!productId && !offerId) {
      setOzonSyncError('Укажите артикул Ozon (offer_id) или привяжите товар к карточке Ozon.');
      return;
    }
    setOzonSyncError('');
    setOzonSyncSuccess('');
    setOzonSyncLoading(true);
    try {
      const data = await integrationsApi.getOzonProductInfo(productId ? { product_id: productId } : { offer_id: offerId });
      if (!data) {
        setOzonSyncError('Товар не найден в Ozon.');
        return;
      }
      setSyncedOzonProductId(data.id != null ? Number(data.id) : null);
      setOzonFetchedProduct(data);
      const offerIdFromOzon = (data.offer_id ?? data.sku ?? '').trim();
      setFormData((prev) => {
        const next = { ...prev };
        if (offerIdFromOzon) next.sku_ozon = offerIdFromOzon;
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
      setOzonSyncSuccess('Данные с Ozon загружены: артикул, атрибуты (в т.ч. название, аннотация, бренд) и при необходимости габариты. Сохраните товар.');
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message ?? 'Ошибка при загрузке данных с Ozon.';
      setOzonSyncError(msg);
    } finally {
      setOzonSyncLoading(false);
    }
  }, [currentProduct?.ozon_product_id, formData.sku_ozon]);

  const fetchWbProductInfo = useCallback(async () => {
    const nmId = formData.sku_wb != null && String(formData.sku_wb).trim() !== '' ? String(formData.sku_wb).trim() : null;
    if (!nmId) {
      setWbSyncError('Укажите nmId (ID номенклатуры Wildberries).');
      return;
    }
    setWbSyncError('');
    setWbSyncSuccess('');
    setWbSyncLoading(true);
    try {
      const data = await integrationsApi.getWildberriesProductInfo({ nm_id: nmId });
      if (!data) {
        setWbSyncError('Товар не найден в Wildberries.');
        return;
      }
      setWbFetchedProduct(data);
      // Заполним wbAttributeValues из пришедших характеристик (если в товаре ещё не сохранены)
      if (Array.isArray(data.characteristics) && data.characteristics.length > 0) {
        setWbAttributeValues((prev) => {
          const next = { ...prev };
          data.characteristics.forEach((c) => {
            const id = c?.id ?? c?.characteristic_id ?? c?.charcID;
            if (id == null) return;
            const v = Array.isArray(c?.value) ? (c.value[0] ?? '') : (c?.value ?? '');
            if (v == null) return;
            if (next[String(id)] != null && String(next[String(id)]).trim() !== '') return;
            next[String(id)] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
          });
          return next;
        });
      }
      // На вкладке WB заполняем nmId, если оно пришло нормализованным
      const nmFromWb = data.nmId ?? data.nmID ?? data.nm_id;
      if (nmFromWb != null && String(nmFromWb).trim() !== '') {
        setFormData((prev) => ({ ...prev, sku_wb: String(nmFromWb).trim() }));
      }
      setWbSyncSuccess('Данные с Wildberries загружены во вкладку.');
    } catch (err) {
      const msg = err.response?.data?.error ?? err.message ?? 'Ошибка при загрузке данных с Wildberries.';
      setWbSyncError(msg);
    } finally {
      setWbSyncLoading(false);
    }
  }, [formData.sku_wb]);

  const applyWbToMainCard = useCallback(() => {
    const p = wbFetchedProduct;
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
      // эвристика: если размеры выглядят как см (обычно 1..200), переводим в мм
      return max > 0 && max <= 200 ? Math.round(n * 10) : Math.round(n);
    };

    const convertWeightToG = (val) => {
      const n = toNumber(val);
      if (n == null) return null;
      // эвристика: <= 50 — скорее кг, > 50 — скорее граммы
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
      if (barcodes.length > 0 && (!Array.isArray(prev.barcodes) || prev.barcodes.every((b) => !b || String(b).trim() === ''))) {
        next.barcodes = barcodes;
      }
      return next;
    });
    setWbSyncSuccess('Текст и артикул продавца подставлены в поля WB; при пустых учётных полях — вес, габариты и штрихкоды. Сохраните товар.');
  }, [wbFetchedProduct]);

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

  // После загрузки данных с Ozon: подгрузить справочники для атрибутов-словарей (Бренд и др.), чтобы в селекте отображалось значение
  const loadOzonDictValuesRef = useRef(loadOzonDictValues);
  loadOzonDictValuesRef.current = loadOzonDictValues;
  useEffect(() => {
    if (!ozonFetchedProduct?.id || !ozonAttributes?.length) return;
    const productId = ozonFetchedProduct.id;
    if (ozonPreloadedForProductIdRef.current === productId) return;
    ozonPreloadedForProductIdRef.current = productId;
    ozonAttributes.forEach((attr) => {
      const hasDict = attr.dictionary_id != null && Number(attr.dictionary_id) !== 0;
      const val = ozonAttributeValues[String(attr.id)];
      if (hasDict && val !== undefined && val !== null && String(val).trim() !== '') {
        loadOzonDictValuesRef.current(attr.id);
      }
    });
  }, [ozonFetchedProduct?.id, ozonAttributes, ozonAttributeValues]);

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

  const handleBarcodeChange = (index, value) => {
    setFormData((prev) => {
      const newBarcodes = [...prev.barcodes];
      newBarcodes[index] = value;
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
    setFormData(prev => ({ ...prev, barcodes: [...prev.barcodes, ''] }));
  };

  const removeBarcodeField = (index) => {
    if (formData.barcodes.length > 1) {
      const newBarcodes = formData.barcodes.filter((_, i) => i !== index);
      setFormData(prev => ({ ...prev, barcodes: newBarcodes }));
    }
  };

  const addKitComponent = () => {
    setFormData(prev => ({ ...prev, kit_components: [...prev.kit_components, { productId: '', quantity: 1 }] }));
  };
  const removeKitComponent = (index) => {
    setFormData(prev => ({
      ...prev,
      kit_components: prev.kit_components.filter((_, i) => i !== index)
    }));
  };
  const updateKitComponent = (index, field, value) => {
    setFormData(prev => {
      const next = [...prev.kit_components];
      next[index] = { ...next[index], [field]: value };
      return { ...prev, kit_components: next };
    });
  };

  const handleAttributeChange = (attributeId, value) => {
    const key = String(attributeId);
    setFormData(prev => ({
      ...prev,
      attributeValues: { ...prev.attributeValues, [key]: value }
    }));
  };

  const availableComponents = (products || []).filter(p => p && String(p.id) !== String(currentProduct?.id));
  const filteredAvailableComponents = useMemo(() => {
    const q = String(kitComponentSearch || '').trim().toLowerCase();
    const list = Array.isArray(availableComponents) ? availableComponents : [];
    if (!q) return list.slice(0, 200);
    return list
      .filter((p) => {
        const sku = String(p?.sku || '').toLowerCase();
        const name = String(p?.name || '').toLowerCase();
        return sku.includes(q) || name.includes(q);
      })
      .slice(0, 200);
  }, [availableComponents, kitComponentSearch]);

  useEffect(() => {
    if (kitModalOpen) return;
    setKitComponentSearch('');
  }, [kitModalOpen]);

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
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!validate()) {
      return;
    }

    // Фильтруем пустые баркоды
    const filteredBarcodes = formData.barcodes.filter(b => b && b.trim() !== '');

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
      wb_attributes: Object.keys(wbAttributeValues).length > 0 ? wbAttributeValues : undefined,
      ym_attributes: Object.keys(ymAttributeValues).length > 0 ? ymAttributeValues : undefined,
      ...(syncedOzonProductId != null || currentProduct?.ozon_product_id != null
        ? { marketplace_ozon_product_id: syncedOzonProductId ?? currentProduct?.ozon_product_id ?? null }
        : {})
    };

    console.log('[ProductForm] Submitting payload:', payload);
    console.log('[ProductForm] Brand value:', formData.brand);
    console.log('[ProductForm] Buyout rate value:', formData.buyout_rate);

    onSubmit(payload);
  };

  const tabButtons = [
    { id: 'main', label: 'Основное' },
    { id: 'ozon', label: 'Ozon' },
    { id: 'wb', label: 'Wildberries' },
    { id: 'ym', label: 'Яндекс.Маркет' }
  ];

  return (
    <form className="product-form" onSubmit={handleSubmit}>
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
              onClick={() => setKitModalOpen(true)}
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
      >
          <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '10px' }}>
            Выберите товары, входящие в комплект, и их количество.
          </p>
          <div style={{ marginBottom: 10 }}>
            <input
              type="text"
              className="form-control form-control-sm"
              placeholder="Поиск по артикулу или названию…"
              value={kitComponentSearch}
              onChange={(e) => setKitComponentSearch(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <div className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Показано вариантов: {filteredAvailableComponents.length}{' '}
              {kitComponentSearch.trim() ? '(поиск)' : '(первые 200)'}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {formData.kit_components.map((row, index) => (
              <div key={index} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                className="form-select form-select-sm"
                  value={row.productId || ''}
                  onChange={(e) => updateKitComponent(index, 'productId', e.target.value ? Number(e.target.value) : '')}
                  style={{ flex: '1 1 200px', minWidth: '140px' }}
                >
                  <option value="">— Выберите товар —</option>
                  {filteredAvailableComponents.map(p => (
                    <option key={p.id} value={p.id}>{p.sku ? `${p.sku} — ` : ''}{p.name}</option>
                  ))}
                </select>
                <input
                  type="number"
                className="form-control form-control-sm"
                  min={1}
                  step={1}
                  value={row.quantity}
                  onChange={(e) => updateKitComponent(index, 'quantity', e.target.value)}
                  placeholder="Кол-во"
                  style={{ width: '80px' }}
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
            ))}
            <Button type="button" variant="secondary" onClick={addKitComponent} style={{ alignSelf: 'flex-start' }}>
              + Добавить комплектующее
            </Button>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {categoryAttributes.map((attr) => {
              const key = String(attr.id);
              const value = formData.attributeValues[key];
              const rawValue = value !== undefined && value !== null ? value : '';
              if (attr.type === 'checkbox') {
                const checked = rawValue === 'true' || rawValue === true;
                return (
                  <div key={attr.id} className="field">
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
                  <div key={attr.id} className="field">
                    <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span></label>
                    <input
                      id={`attr-${attr.id}`}
                      type="number"
                      className="form-control form-control-sm"
                      style={{ maxWidth: 240 }}
                      value={rawValue}
                      onChange={(e) => handleAttributeChange(attr.id, e.target.value)}
                    />
                  </div>
                );
              }
              if (attr.type === 'date') {
                return (
                  <div key={attr.id} className="field">
                    <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span></label>
                    <input
                      id={`attr-${attr.id}`}
                      type="date"
                      className="form-control form-control-sm"
                      style={{ maxWidth: 240 }}
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
                  <div key={attr.id} className="field">
                    <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type]})</span></label>
                    <select
                      id={`attr-${attr.id}`}
                      className="form-select form-select-sm"
                      style={{ maxWidth: 360 }}
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
                <div key={attr.id} className="field">
                  <label className="label" htmlFor={`attr-${attr.id}`}>{attr.name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({TYPE_LABELS[attr.type] || 'Текст'})</span></label>
                  <input
                    id={`attr-${attr.id}`}
                    type="text"
                    className="form-control form-control-sm"
                    style={{ maxWidth: 360 }}
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
        <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
          {formData.barcodes.map((barcode, index) => (
            <div key={index} style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Введите баркод (EAN, UPC и т.д.)"
                value={barcode}
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
          <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
            <Button
              type="button"
              variant="secondary"
              onClick={fetchOzonProductInfo}
              disabled={ozonSyncLoading || ((!currentProduct?.ozon_product_id) && (!formData.sku_ozon || String(formData.sku_ozon).trim() === ''))}
            >
              {ozonSyncLoading ? 'Загрузка…' : 'Обновить данные с Ozon'}
            </Button>
            <span className="text-muted small">
              Подтянуть атрибуты карточки с Ozon (название, аннотация, бренд и остальные поля категории). Нужен артикул или привязка к карточке.
            </span>
          </div>
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
          <div className="mt-2">
            <label className="form-label" htmlFor="sku_ozon">Артикул Ozon</label>
            <input
              id="sku_ozon"
              type="text"
              className="form-control form-control-sm"
              style={{ maxWidth: 320 }}
              placeholder="Артикул Ozon"
              value={formData.sku_ozon}
              onChange={(e) => handleChange('sku_ozon', e.target.value)}
            />
          </div>
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
          <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
            <Button
              type="button"
              variant="secondary"
              onClick={fetchWbProductInfo}
              disabled={wbSyncLoading || (!formData.sku_wb || String(formData.sku_wb).trim() === '')}
            >
              {wbSyncLoading ? 'Загрузка…' : 'Обновить данные с WB'}
            </Button>
            <span className="text-muted small">
              Подтянуть данные карточки товара с Wildberries по nmId.
            </span>
          </div>
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
          {wbFetchedProduct && (
            <div className="card mb-3">
              <div className="card-header">
                Данные с WB (все поля по товару)
              </div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                {(wbFetchedProduct.title || wbFetchedProduct.name) && (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Название:</span>
                    <span>{wbFetchedProduct.title || wbFetchedProduct.name}</span>
                  </div>
                )}
                {wbFetchedProduct.brand && (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Бренд:</span>
                    <span>{wbFetchedProduct.brand}</span>
                  </div>
                )}
                {(wbFetchedProduct.description || wbFetchedProduct.descriptionRu) && (
                  <div>
                    <span style={{ color: 'var(--muted)', marginRight: '6px' }}>Описание:</span>
                    <div style={{ marginTop: '4px', whiteSpace: 'pre-wrap', maxHeight: '120px', overflow: 'auto' }}>
                      {String(wbFetchedProduct.description || wbFetchedProduct.descriptionRu || '').trim().slice(0, 500)}
                      {String(wbFetchedProduct.description || wbFetchedProduct.descriptionRu || '').length > 500 ? '…' : ''}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 16px' }}>
                  {(wbFetchedProduct.nmId ?? wbFetchedProduct.nmID) != null && (
                    <span><span style={{ color: 'var(--muted)' }}>nmId:</span> {wbFetchedProduct.nmId ?? wbFetchedProduct.nmID}</span>
                  )}
                  {wbFetchedProduct.vendorCode && (
                    <span><span style={{ color: 'var(--muted)' }}>vendorCode:</span> {wbFetchedProduct.vendorCode}</span>
                  )}
                </div>
                <div className="mt-3 pt-3 border-top">
                  <button type="button" className="btn btn-link p-0" onClick={() => setWbShowAllFields((v) => !v)}>
                    {wbShowAllFields ? 'Свернуть все поля' : 'Все поля (сырой ответ API)'}
                  </button>
                  {wbShowAllFields && wbFetchedProduct && (
                    <div style={{ marginTop: '8px', maxHeight: '320px', overflow: 'auto', fontSize: '11px', fontFamily: 'monospace' }}>
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
              </div>
              <div className="card-footer d-flex gap-2 flex-wrap">
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  onClick={applyWbToMainCard}
                >
                  Подставить в поля WB
                </Button>
                <span className="text-muted small" style={{ alignSelf: 'center' }}>
                  Подставит в поля WB: название, описание, бренд, артикул продавца; при пустых учётных полях — вес, габариты и штрихкоды.
                </span>
              </div>
            </div>
          )}
          <div className="mt-2">
            <label className="form-label" htmlFor="sku_wb">Артикул WB (nmId)</label>
            <input
              id="sku_wb"
            type="text"
              className="form-control form-control-sm"
              style={{ maxWidth: 320 }}
              placeholder="Например: 527548163"
              value={formData.sku_wb}
              onChange={(e) => handleChange('sku_wb', e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
              Номенклатурный номер из карточки товара на Wildberries. По нему в заказах подставляется название товара.
        </div>
      </div>

          <div className="card mt-3 border-secondary">
            <div className="card-header">Текст и артикул продавца для Wildberries</div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' }}>
                Поля ниже относятся только к WB и не совпадают с названием/описанием/брендом на вкладке «Основное». Артикул ERP (<code>sku</code>) и артикул продавца на WB могут различаться.
              </p>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label" htmlFor="wb-tab-vendor-sku">Артикул продавца (vendorCode)</label>
                  <input
                    id="wb-tab-vendor-sku"
                    type="text"
                    className="form-control form-control-sm"
                    value={formData.mp_wb_vendor_code}
                    onChange={(e) => handleChange('mp_wb_vendor_code', e.target.value)}
                  />
                </div>
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
            </div>
      </div>

          <div className="card mt-3">
            <div className="card-header">Атрибуты WB (по категории)</div>
            <div className="card-body">
              {formData.categoryId && categoryDetailsLoading ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Загрузка данных категории…</div>
              ) : !formData.categoryId ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Выберите категорию выше, чтобы подгрузить атрибуты WB.</div>
              ) : !wbSubjectId || wbSubjectId <= 0 ? (
                <div className="alert alert-warning py-2 mb-0" style={{ fontSize: '12px' }}>
                  Для выбранной категории не задано сопоставление WB (subjectId). Заполните <code>marketplace_mappings.wb</code> в категории.
                </div>
              ) : wbCategoryAttributesError ? (
                <div className="alert alert-danger py-2 mb-0" style={{ fontSize: '12px' }}>
                  {wbCategoryAttributesError}
                </div>
              ) : wbCategoryAttributesLoading ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Загрузка атрибутов категории WB…</div>
              ) : wbCategoryAttributes.length === 0 ? (
                <div className="text-muted" style={{ fontSize: '12px' }}>Нет атрибутов для этой категории (или WB не вернул список).</div>
              ) : (
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
              )}
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }}>
                Значения ниже сохраняются как <code>wb_attributes</code> (характеристики предмета по категории). Название, описание, бренд и артикул продавца для WB — в блоке выше.
              </div>
            </div>
          </div>

          {wbFetchedProduct && (
            <div className="card mt-3">
              <div className="card-header">Поля карточки WB</div>
              <div className="card-body">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 14px', fontSize: '12px', marginBottom: '10px' }}>
                {(wbFetchedProduct.nmId ?? wbFetchedProduct.nmID) != null && (
                  <span><span style={{ color: 'var(--muted)' }}>nmId:</span> {wbFetchedProduct.nmId ?? wbFetchedProduct.nmID}</span>
                )}
                {wbFetchedProduct.imtID != null && (
                  <span><span style={{ color: 'var(--muted)' }}>imtID:</span> {wbFetchedProduct.imtID}</span>
                )}
                {wbFetchedProduct.nmUUID && (
                  <span><span style={{ color: 'var(--muted)' }}>nmUUID:</span> {String(wbFetchedProduct.nmUUID)}</span>
                )}
                {wbFetchedProduct.subjectID != null && (
                  <span><span style={{ color: 'var(--muted)' }}>subjectID:</span> {wbFetchedProduct.subjectID}</span>
                )}
                {wbFetchedProduct.subjectName && (
                  <span><span style={{ color: 'var(--muted)' }}>Категория WB:</span> {String(wbFetchedProduct.subjectName)}</span>
                )}
                {wbFetchedProduct.vendorCode && (
                  <span><span style={{ color: 'var(--muted)' }}>vendorCode:</span> {String(wbFetchedProduct.vendorCode)}</span>
                )}
                {wbFetchedProduct.needKiz != null && (
                  <span><span style={{ color: 'var(--muted)' }}>needKiz:</span> {wbFetchedProduct.needKiz ? 'true' : 'false'}</span>
                )}
                {wbFetchedProduct.createdAt && (
                  <span><span style={{ color: 'var(--muted)' }}>createdAt:</span> {String(wbFetchedProduct.createdAt).slice(0, 19)}</span>
                )}
                {wbFetchedProduct.updatedAt && (
                  <span><span style={{ color: 'var(--muted)' }}>updatedAt:</span> {String(wbFetchedProduct.updatedAt).slice(0, 19)}</span>
                )}
              </div>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label" htmlFor="wb-title">Название (WB)</label>
            <input
                    id="wb-title"
              type="text"
                    className="form-control form-control-sm"
                    value={String(wbFetchedProduct.title ?? wbFetchedProduct.name ?? '').trim()}
              readOnly
                    style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
            />
            </div>
                <div className="col-md-6">
                  <label className="form-label" htmlFor="wb-brand">Бренд (WB)</label>
                  <input
                    id="wb-brand"
                    type="text"
                    className="form-control form-control-sm"
                    value={String(wbFetchedProduct.brand ?? '').trim()}
                    readOnly
                    style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
                  />
          </div>
        </div>
              <div className="mt-3">
                <label className="form-label" htmlFor="wb-desc">Описание (WB)</label>
                <textarea
                  id="wb-desc"
                  className="form-control form-control-sm"
                  rows="4"
                  value={String(wbFetchedProduct.description ?? wbFetchedProduct.descriptionRu ?? '').trim()}
                  readOnly
                  style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
                />
              </div>
              <div className="row g-3 mt-1">
                <div className="col-md-3">
                  <label className="form-label" htmlFor="wb-weight">Вес (WB)</label>
            <input
                    id="wb-weight"
              type="number"
                    className="form-control form-control-sm"
                    value={wbFetchedProduct?.dimensions?.weightBrutto != null ? String(wbFetchedProduct.dimensions.weightBrutto) : ''}
                    readOnly
                    style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
            />
          </div>
                <div className="col-md-3">
                  <label className="form-label" htmlFor="wb-length">Длина (WB)</label>
            <input
                    id="wb-length"
              type="number"
                    className="form-control form-control-sm"
                    value={wbFetchedProduct?.dimensions?.length != null ? String(wbFetchedProduct.dimensions.length) : ''}
                    readOnly
                    style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
            />
          </div>
                <div className="col-md-3">
                  <label className="form-label" htmlFor="wb-width">Ширина (WB)</label>
            <input
                    id="wb-width"
              type="number"
                    className="form-control form-control-sm"
                    value={wbFetchedProduct?.dimensions?.width != null ? String(wbFetchedProduct.dimensions.width) : ''}
                    readOnly
                    style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
            />
          </div>
                <div className="col-md-3">
                  <label className="form-label" htmlFor="wb-height">Высота (WB)</label>
                  <input
                    id="wb-height"
                    type="number"
                    className="form-control form-control-sm"
                    value={wbFetchedProduct?.dimensions?.height != null ? String(wbFetchedProduct.dimensions.height) : ''}
                    readOnly
                    style={{ background: 'rgba(255,255,255,0.03)', cursor: 'default' }}
                  />
        </div>
      </div>

              {Array.isArray(wbFetchedProduct.photos) && wbFetchedProduct.photos.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '6px' }}>
                    Фото WB: {wbFetchedProduct.photos.length}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {wbFetchedProduct.photos.slice(0, 6).map((ph, idx) => {
                      const src = ph?.square || ph?.tm || ph?.c246x328 || ph?.big || ph?.hq;
                      if (!src) return null;
                      return (
                        <a key={idx} href={src} target="_blank" rel="noreferrer" style={{ display: 'inline-block' }}>
                          <img
                            src={src}
                            alt={`wb-${idx}`}
                            style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', border: '1px solid rgba(203, 17, 171, 0.18)' }}
                          />
                        </a>
                      );
                    })}
                    {wbFetchedProduct.photos.length > 6 && (
                      <div style={{ fontSize: '11px', color: 'var(--muted)', alignSelf: 'center' }}>
                        …ещё {wbFetchedProduct.photos.length - 6}
                      </div>
                    )}
                  </div>
        </div>
      )}

              {Array.isArray(wbFetchedProduct.sizes) && wbFetchedProduct.sizes.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '6px' }}>
                    Размеры/SKU WB: {wbFetchedProduct.sizes.length}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
                    {wbFetchedProduct.sizes.slice(0, 8).map((s, idx) => {
                      const skus = Array.isArray(s?.skus) ? s.skus.map((x) => String(x)).filter(Boolean) : [];
                      return (
                        <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 14px' }}>
                          {s?.chrtID != null && <span><span style={{ color: 'var(--muted)' }}>chrtID:</span> {s.chrtID}</span>}
                          {s?.techSize != null && <span><span style={{ color: 'var(--muted)' }}>techSize:</span> {String(s.techSize)}</span>}
                          {s?.wbSize != null && String(s.wbSize) !== '' && <span><span style={{ color: 'var(--muted)' }}>wbSize:</span> {String(s.wbSize)}</span>}
                          {skus.length > 0 && <span><span style={{ color: 'var(--muted)' }}>skus:</span> {skus.join(', ')}</span>}
                        </div>
                      );
                    })}
                    {wbFetchedProduct.sizes.length > 8 && (
                      <div style={{ fontSize: '11px', color: 'var(--muted)' }}>… и ещё {wbFetchedProduct.sizes.length - 8}</div>
                    )}
                  </div>
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }}>
                Примечание: `needKiz`, `photos`, `sizes/skus` и прочие служебные поля WB сохраняются в “сыром ответе” (кнопка «Все поля»). В ERP мы редактируем то, что реально используется: название/описание/бренд/упаковка/баркоды и характеристики.
              </div>
              </div>
            </div>
          )}

          {Array.isArray(wbFetchedProduct?.characteristics) && wbFetchedProduct.characteristics.length > 0 && (
            <div className="card mt-3">
              <div className="card-header">Атрибуты WB (характеристики категории)</div>
              <div className="card-body">
              <div className="row g-3">
                {wbFetchedProduct.characteristics.map((c) => {
                  const id = c?.id ?? c?.characteristic_id ?? c?.charcID;
                  const name = c?.name ?? c?.characteristic_name ?? (id != null ? `ID ${id}` : 'Характеристика');
                  const key = id != null ? String(id) : String(name);
                  const fromApi = Array.isArray(c?.value) ? c.value : (c?.value ?? '');
                  const value = wbAttributeValues[key] ?? fromApi;
                  const display = (() => {
                    if (Array.isArray(value)) return value.map((v) => (v == null ? '' : String(v))).join('; ');
                    if (value != null && typeof value === 'object') {
                      try { return JSON.stringify(value); } catch (_) { return String(value); }
                    }
                    return value == null ? '' : String(value);
                  })();
                  return (
                    <div key={key} className="col-12 col-md-6 col-lg-4">
                      <label className="form-label" htmlFor={`wb-attr-${key}`}>
                        {name} <span style={{ fontSize: '11px', color: 'var(--muted)' }}>(WB)</span>
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
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }}>
                Эти значения сохраняются в товаре как `wb_attributes` (аналогично `ozon_attributes`) и не создают отдельные атрибуты ERP.
              </div>
              </div>
            </div>
          )}

        </div>
      )}

      {activeTab === 'ym' && (
        <div className="product-form-marketplace-panel">
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="mp-badge ym">YM</span>
            Данные для Яндекс.Маркет
          </h4>
          <div className="mt-2">
            <label className="form-label" htmlFor="sku_ym">Артикул</label>
            <input
              id="sku_ym"
              type="text"
              className="form-control form-control-sm"
              style={{ maxWidth: 320 }}
              placeholder="Артикул Yandex"
              value={formData.sku_ym}
              onChange={(e) => handleChange('sku_ym', e.target.value)}
            />
          </div>

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

      <div className="d-flex justify-content-end gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Отмена
        </Button>
        <Button type="submit" variant="primary">
          Сохранить
        </Button>
      </div>
    </form>
  );
}

