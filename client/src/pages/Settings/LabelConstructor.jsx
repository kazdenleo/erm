/**
 * Конструктор этикеток: товар по категориям + ШК упаковки
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { categoryLabelTemplatesApi } from '../../services/categoryLabelTemplates.api.js';
import { packagingLabelTemplatesApi } from '../../services/packagingLabelTemplates.api.js';
import { cellLabelTemplatesApi } from '../../services/cellLabelTemplates.api.js';
import { userCategoriesApi } from '../../services/userCategories.api.js';
import { productAttributesApi } from '../../services/productAttributes.api.js';
import { productsApi } from '../../services/products.api.js';
import { addressStorageApi } from '../../services/addressStorage.api.js';
import { LABEL_SIZES } from './Labels.jsx';
import { LABEL_PRODUCT_FIELDS, labelProductFieldLabel } from '../../constants/labelProductFields.js';
import './LabelConstructor.css';

const ELEMENT_TYPES = [
  { type: 'name', label: 'Название товара' },
  { type: 'sku', label: 'SKU (артикул)' },
  { type: 'barcode', label: 'Штрихкод' },
  { type: 'kit_components', label: 'Комплектующие (только комплект)' },
  { type: 'attribute', label: 'Атрибут карточки' },
  { type: 'units_per_box', label: 'Шт. в упаковке' },
];

const PACKAGING_ELEMENT_TYPES = [
  { type: 'name', label: 'Название товара' },
  { type: 'sku', label: 'Артикул (SKU)' },
  { type: 'barcode', label: 'ШК упаковки' },
  { type: 'units_per_box', label: 'Шт. в упаковке' },
];

const CELL_ELEMENT_TYPES = [
  { type: 'code', label: 'Адрес ячейки' },
  { type: 'legend', label: 'Расшифровка уровней' },
  { type: 'warehouse', label: 'Склад' },
  { type: 'barcode', label: 'Штрихкод ячейки' },
];

const CELL_ELEMENT_TYPE_SET = new Set(CELL_ELEMENT_TYPES.map((t) => t.type));

const SAMPLE_CELL_PREVIEW = {
  id: 'sample',
  code: 'A-01-3-2',
  legend: 'Стеллаж A · Ряд 01 · Полка 3 · Ячейка 2',
  barcode: 'A-01-3-2',
  warehouseName: 'Основной склад',
};

function sanitizeCellElements(elements) {
  return (elements || []).filter((el) => el && CELL_ELEMENT_TYPE_SET.has(el.type));
}

function cellPreviewLegend(location, settings) {
  const levels = Array.isArray(settings?.levels) ? settings.levels : [];
  const parts = Array.isArray(location?.parts) ? location.parts : [];
  const legend = parts
    .map((p, i) => `${levels[i]?.label || ''} ${p}`.trim())
    .filter(Boolean)
    .join(' · ');
  return legend || SAMPLE_CELL_PREVIEW.legend;
}

const LABEL_PRESET_MM = {
  '58x40': { widthMm: 58, heightMm: 40 },
  '75x120': { widthMm: 75, heightMm: 120 },
};

const CUSTOM_SIZE_MIN_MM = 15;
const CUSTOM_SIZE_MAX_MM = 200;

function clampLabelMm(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CUSTOM_SIZE_MAX_MM, Math.max(CUSTOM_SIZE_MIN_MM, n));
}

function labelSizeMm(form) {
  if (form?.size_preset === 'custom') {
    return {
      widthMm: clampLabelMm(form?.width_mm, 58),
      heightMm: clampLabelMm(form?.height_mm, 40),
    };
  }
  const preset = LABEL_PRESET_MM[form?.size_preset] || LABEL_PRESET_MM['58x40'];
  const w = form?.width_mm != null && form?.width_mm !== '' ? Number(form.width_mm) : null;
  const h = form?.height_mm != null && form?.height_mm !== '' ? Number(form.height_mm) : null;
  return {
    widthMm: Number.isFinite(w) && w > 0 ? w : preset.widthMm,
    heightMm: Number.isFinite(h) && h > 0 ? h : preset.heightMm,
  };
}

function presetMatchesMm(presetKey, widthMm, heightMm) {
  const preset = LABEL_PRESET_MM[presetKey];
  if (!preset) return false;
  if (widthMm == null || heightMm == null) return true;
  return Number(widthMm) === preset.widthMm && Number(heightMm) === preset.heightMm;
}

function innerLabelWidthMm(form) {
  const { widthMm } = labelSizeMm(form);
  const left = Number(form?.margin_left_mm ?? 2);
  const right = Number(form?.margin_right_mm ?? 2);
  return Math.max(20, widthMm - left - right);
}

function defaultElements(form) {
  const innerW = innerLabelWidthMm(form);
  return [
    { id: 'name', type: 'name', enabled: true, fontSize: 11, bold: true },
    { id: 'sku', type: 'sku', enabled: true, fontSize: 9 },
    {
      id: 'barcode',
      type: 'barcode',
      enabled: true,
      widthMm: innerW,
      heightMm: 14,
      showText: true,
      textFontSize: 8,
    },
  ];
}

function defaultCellElements(form) {
  const innerW = innerLabelWidthMm(form);
  return [
    { id: 'code', type: 'code', enabled: true, fontSize: 22, bold: true, align: 'center' },
    { id: 'legend', type: 'legend', enabled: true, fontSize: 9, align: 'center' },
    {
      id: 'barcode',
      type: 'barcode',
      enabled: true,
      widthMm: innerW,
      heightMm: 12,
      showText: false,
      textFontSize: 8,
      align: 'center',
    },
  ];
}

function defaultPackagingElements(form) {
  const innerW = innerLabelWidthMm(form);
  return [
    { id: 'sku', type: 'sku', enabled: true, fontSize: 14, bold: true },
    {
      id: 'barcode',
      type: 'barcode',
      enabled: true,
      widthMm: innerW,
      heightMm: 16,
      showText: true,
      textFontSize: 12,
    },
    { id: 'units_per_box', type: 'units_per_box', enabled: true, fontSize: 16, bold: true },
  ];
}

function normalizeTemplate(data, { packaging = false, cell = false } = {}) {
  const d = data?.data ?? data ?? {};
  const hasElementsList = Array.isArray(d.elements);
  const widthRaw = d.width_mm ?? d.widthMm;
  const heightRaw = d.height_mm ?? d.heightMm;
  const width_mm = widthRaw != null && widthRaw !== '' ? Number(widthRaw) : null;
  const height_mm = heightRaw != null && heightRaw !== '' ? Number(heightRaw) : null;
  let size_preset = d.size_preset || d.sizePreset || '58x40';
  if (cell) {
    if (
      size_preset === 'custom' ||
      (Number.isFinite(width_mm) &&
        Number.isFinite(height_mm) &&
        !presetMatchesMm(size_preset, width_mm, height_mm))
    ) {
      size_preset = 'custom';
    }
  }
  const base = {
    size_preset,
    width_mm: Number.isFinite(width_mm) ? width_mm : size_preset === 'custom' ? 58 : null,
    height_mm: Number.isFinite(height_mm) ? height_mm : size_preset === 'custom' ? 40 : null,
    margin_top_mm: Number(d.margin_top_mm ?? d.marginTopMm ?? 2),
    margin_right_mm: Number(d.margin_right_mm ?? d.marginRightMm ?? 2),
    margin_bottom_mm: Number(d.margin_bottom_mm ?? d.marginBottomMm ?? 2),
    margin_left_mm: Number(d.margin_left_mm ?? d.marginLeftMm ?? 2),
    line_gap_mm: Number(d.line_gap_mm ?? d.lineGapMm ?? 1),
  };
  const fallback = cell
    ? defaultCellElements(base)
    : packaging
      ? defaultPackagingElements(base)
      : defaultElements(base);
  const rawElements = hasElementsList
    ? clampElementsForSave(d.elements, { packaging, cell })
    : fallback;
  return {
    ...base,
    elements: cell ? sanitizeCellElements(rawElements) : rawElements,
  };
}

function hasElementType(elements, type) {
  return (elements || []).some((el) => el.type === type);
}

function parseMmValue(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clampFontSize(v, fallback, max = 24) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(6, n));
}

function normalizeAlign(v, fallback = 'left') {
  const a = String(v ?? '').trim().toLowerCase();
  if (a === 'center' || a === 'middle') return 'center';
  if (a === 'right' || a === 'end') return 'right';
  if (a === 'left' || a === 'start') return 'left';
  return fallback;
}

function clampElementsForSave(elements, { packaging = false, cell = false } = {}) {
  const textMax = packaging || cell ? 48 : 24;
  const barcodeTextMax = packaging || cell ? 36 : 14;
  return (elements || []).map((el) => {
    const next = { ...el };
    if (el.type === 'barcode') {
      if (next.textFontSize != null) {
        next.textFontSize = clampFontSize(next.textFontSize, 8, barcodeTextMax);
      }
      if (next.widthMm != null) {
        next.widthMm = Math.min(120, Math.max(15, Number(next.widthMm) || 15));
      }
      if (next.heightMm != null) {
        next.heightMm = Math.min(40, Math.max(6, Number(next.heightMm) || 12));
      }
      next.align = normalizeAlign(next.align, 'center');
      return next;
    }
    if (
      el.type === 'name' ||
      el.type === 'sku' ||
      el.type === 'attribute' ||
      el.type === 'product_field' ||
      el.type === 'kit_components' ||
      el.type === 'units_per_box' ||
      el.type === 'code' ||
      el.type === 'legend' ||
      el.type === 'warehouse'
    ) {
      if (next.fontSize != null) {
        next.fontSize = clampFontSize(
          next.fontSize,
          el.type === 'name' ? 11 : el.type === 'units_per_box' ? 16 : 9,
          textMax
        );
      }
      if (next.titleFontSize != null) {
        next.titleFontSize = clampFontSize(next.titleFontSize, 8, packaging || cell ? 36 : 20);
      }
      next.align = normalizeAlign(
        next.align,
        el.type === 'units_per_box' ||
          el.type === 'code' ||
          el.type === 'legend' ||
          el.type === 'warehouse'
          ? 'center'
          : 'left'
      );
    }
    return next;
  });
}

/** Явный payload для API — чтобы line_gap_mm и отступы всегда уходили на сервер */
function buildTemplatePayload(form, { packaging = false, cell = false, previewCell = null } = {}) {
  const isCustom = cell && form.size_preset === 'custom';
  const size = labelSizeMm(form);
  const elements = clampElementsForSave(form.elements, { packaging, cell });
  const payload = {
    size_preset: isCustom ? 'custom' : form.size_preset || '58x40',
    width_mm: isCustom ? size.widthMm : null,
    height_mm: isCustom ? size.heightMm : null,
    margin_top_mm: parseMmValue(form.margin_top_mm, 2),
    margin_right_mm: parseMmValue(form.margin_right_mm, 2),
    margin_bottom_mm: parseMmValue(form.margin_bottom_mm, 2),
    margin_left_mm: parseMmValue(form.margin_left_mm, 2),
    line_gap_mm: parseMmValue(form.line_gap_mm, 1),
    elements: cell ? sanitizeCellElements(elements) : elements,
  };
  if (cell && previewCell) payload.previewCell = previewCell;
  return payload;
}

export function LabelConstructor() {
  const [editorMode, setEditorMode] = useState('product'); // 'product' | 'packaging' | 'cell'
  const [categories, setCategories] = useState([]);
  const [allAttributes, setAllAttributes] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [packagingSaved, setPackagingSaved] = useState(false);
  const [cellSaved, setCellSaved] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [form, setForm] = useState(() => normalizeTemplate({}));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewProductId, setPreviewProductId] = useState('');
  const [previewProductDetail, setPreviewProductDetail] = useState(null);
  const [categoryProducts, setCategoryProducts] = useState([]);
  const [packagingProducts, setPackagingProducts] = useState([]);
  const [dragElementIndex, setDragElementIndex] = useState(null);
  const [dragOverElementIndex, setDragOverElementIndex] = useState(null);
  const [cellWarehouses, setCellWarehouses] = useState([]);
  const [cellLocations, setCellLocations] = useState([]);
  const [cellWarehouseSettings, setCellWarehouseSettings] = useState(null);
  const [previewWarehouseId, setPreviewWarehouseId] = useState('');
  const [previewLocationId, setPreviewLocationId] = useState('');
  const isPackaging = editorMode === 'packaging';
  const isCell = editorMode === 'cell';

  const selectedPreviewLocation = useMemo(() => {
    if (!previewLocationId) return null;
    return cellLocations.find((l) => String(l.id) === String(previewLocationId)) || null;
  }, [cellLocations, previewLocationId]);

  const cellPreviewPayload = useMemo(() => {
    if (!isCell) return null;
    if (!selectedPreviewLocation) return SAMPLE_CELL_PREVIEW;
    const wh =
      cellWarehouses.find((w) => String(w.id) === String(previewWarehouseId)) ||
      cellWarehouses.find((w) => String(w.id) === String(selectedPreviewLocation.warehouse_id)) ||
      null;
    const code = String(selectedPreviewLocation.code || '').trim() || SAMPLE_CELL_PREVIEW.code;
    return {
      id: selectedPreviewLocation.id,
      code,
      legend: cellPreviewLegend(selectedPreviewLocation, cellWarehouseSettings),
      barcode:
        String(
          selectedPreviewLocation.effective_barcode ||
            selectedPreviewLocation.effectiveBarcode ||
            selectedPreviewLocation.barcode ||
            code
        ).trim() || code,
      warehouseName: String(wh?.name || '').trim() || SAMPLE_CELL_PREVIEW.warehouseName,
    };
  }, [
    isCell,
    selectedPreviewLocation,
    cellWarehouses,
    previewWarehouseId,
    cellWarehouseSettings,
  ]);

  const categoryById = useMemo(() => {
    const m = {};
    for (const c of categories) m[String(c.id)] = c;
    return m;
  }, [categories]);

  const categoryAttributeIds = useMemo(() => {
    const cat = categoryById[selectedCategoryId];
    if (!cat) return [];
    const ids = cat.attribute_ids || cat.attributeIds || [];
    return Array.isArray(ids) ? ids.map(String) : [];
  }, [categoryById, selectedCategoryId]);

  /** Только атрибуты, прикреплённые к категории; при выборе товара — с заполненным значением в карточке */
  const availableAttributes = useMemo(() => {
    if (!categoryAttributeIds.length) return [];
    const catSet = new Set(categoryAttributeIds.map(String));
    let list = allAttributes.filter((a) => catSet.has(String(a.id)));
    if (previewProductId && previewProductDetail) {
      const vals = previewProductDetail.attribute_values || previewProductDetail.attributeValues || {};
      list = list.filter((a) => {
        const v = vals[String(a.id)] ?? vals[a.id];
        return v != null && String(v).trim() !== '';
      });
    }
    return list.sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    );
  }, [allAttributes, categoryAttributeIds, previewProductId, previewProductDetail]);

  const hasSavedTemplate = useMemo(() => {
    return templates.some((t) => String(t.user_category_id ?? t.userCategoryId) === String(selectedCategoryId));
  }, [templates, selectedCategoryId]);

  const loadBase = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catRes, attrRes, tplRes] = await Promise.all([
        userCategoriesApi.getAll(),
        productAttributesApi.getAll(),
        categoryLabelTemplatesApi.getAll(),
      ]);
      setCategories(catRes?.data || []);
      setAllAttributes(attrRes?.data || []);
      setTemplates(tplRes?.data || []);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  useEffect(() => {
    if (isPackaging || !selectedCategoryId) return;
    let cancelled = false;
    setPreviewProductId('');
    setPreviewProductDetail(null);
    setCategoryProducts([]);
    (async () => {
      try {
        const res = await categoryLabelTemplatesApi.getByCategoryId(selectedCategoryId);
        if (!cancelled) setForm(normalizeTemplate(res));
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.message || e?.message || 'Ошибка загрузки шаблона');
      }
    })();
    (async () => {
      try {
        const res = await productsApi.getAll({ categoryId: selectedCategoryId, limit: 50 });
        if (!cancelled) setCategoryProducts((res?.data || []).slice(0, 50));
      } catch {
        if (!cancelled) setCategoryProducts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCategoryId, isPackaging]);

  useEffect(() => {
    if (!isPackaging) return;
    let cancelled = false;
    setPreviewProductId('');
    setPreviewProductDetail(null);
    setError('');
    (async () => {
      try {
        const res = await packagingLabelTemplatesApi.get();
        if (cancelled) return;
        setForm(normalizeTemplate(res, { packaging: true }));
        setPackagingSaved(Boolean(res?.saved));
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.message || e?.message || 'Ошибка загрузки шаблона упаковки');
      }
    })();
    (async () => {
      try {
        const res = await productsApi.getAll({ limit: 50 });
        if (!cancelled) setPackagingProducts((res?.data || []).slice(0, 50));
      } catch {
        if (!cancelled) setPackagingProducts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPackaging]);

  useEffect(() => {
    if (!isCell) return;
    let cancelled = false;
    setPreviewProductId('');
    setPreviewProductDetail(null);
    setPreviewLocationId('');
    setError('');
    (async () => {
      try {
        const res = await cellLabelTemplatesApi.get();
        if (cancelled) return;
        setForm(normalizeTemplate(res, { cell: true }));
        setCellSaved(Boolean(res?.saved));
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.message || e?.message || 'Ошибка загрузки шаблона ячейки');
      }
    })();
    (async () => {
      try {
        const whRes = await addressStorageApi.listWarehouses();
        const list = Array.isArray(whRes?.data) ? whRes.data : Array.isArray(whRes) ? whRes : [];
        if (cancelled) return;
        setCellWarehouses(list);
        if (list.length) {
          setPreviewWarehouseId((prev) => prev || String(list[0].id));
        }
      } catch {
        if (!cancelled) setCellWarehouses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCell]);

  /** Поля товара (sku/name/…) в шаблоне ячейки бессмысленны — убираем из формы сразу. */
  useEffect(() => {
    if (!isCell) return;
    setForm((prev) => {
      const next = sanitizeCellElements(prev.elements);
      if (next.length === (prev.elements || []).length) return prev;
      return { ...prev, elements: next };
    });
  }, [isCell, form.elements]);

  useEffect(() => {
    if (!isCell || !previewWarehouseId) {
      if (isCell) {
        setCellLocations([]);
        setCellWarehouseSettings(null);
      }
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const [locRes, settingsRes] = await Promise.all([
          addressStorageApi.listLocations(previewWarehouseId),
          addressStorageApi.getSettings(previewWarehouseId),
        ]);
        if (cancelled) return;
        const locs = Array.isArray(locRes?.data)
          ? locRes.data
          : Array.isArray(locRes)
            ? locRes
            : [];
        setCellLocations(locs.slice(0, 200));
        setCellWarehouseSettings(settingsRes?.data ?? settingsRes ?? null);
        setPreviewLocationId((prev) => {
          if (prev && locs.some((l) => String(l.id) === String(prev))) return prev;
          return '';
        });
      } catch {
        if (!cancelled) {
          setCellLocations([]);
          setCellWarehouseSettings(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCell, previewWarehouseId]);

  useEffect(() => {
    if (!previewProductId) {
      setPreviewProductDetail(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await productsApi.getById(previewProductId);
        const p = res?.data ?? res;
        if (!cancelled) setPreviewProductDetail(p || null);
      } catch {
        if (!cancelled) setPreviewProductDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewProductId]);

  useEffect(() => {
    if (!isPackaging && !isCell && !selectedCategoryId) {
      setPreviewUrl('');
      return undefined;
    }

    let cancelled = false;
    let objectUrl = '';
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError('');
      try {
        const blob = isCell
          ? await cellLabelTemplatesApi.preview(
              buildTemplatePayload(form, { cell: true, previewCell: cellPreviewPayload }),
              { scale: 4 }
            )
          : isPackaging
          ? await packagingLabelTemplatesApi.preview(buildTemplatePayload(form, { packaging: true }), {
              productId: previewProductId || undefined,
              scale: 4,
            })
          : await categoryLabelTemplatesApi.preview(
              selectedCategoryId,
              buildTemplatePayload(form),
              {
                productId: previewProductId || undefined,
                scale: 4,
              }
            );
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      } catch (e) {
        if (!cancelled) {
          setPreviewError(e?.response?.data?.message || e?.message || 'Не удалось построить предпросмотр');
          setPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return '';
          });
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    isPackaging,
    isCell,
    selectedCategoryId,
    previewProductId,
    cellPreviewPayload,
    form.size_preset,
    form.width_mm,
    form.height_mm,
    form.margin_top_mm,
    form.margin_right_mm,
    form.margin_bottom_mm,
    form.margin_left_mm,
    form.line_gap_mm,
    form.elements,
  ]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const updateElement = (index, patch) => {
    setForm((prev) => {
      const elements = [...(prev.elements || [])];
      elements[index] = { ...elements[index], ...patch };
      return { ...prev, elements };
    });
  };

  const toggleElement = (index) => {
    const el = form.elements[index];
    updateElement(index, { enabled: el.enabled === false });
  };

  const addAttributeElement = () => {
    const firstAttr = availableAttributes[0];
    if (!firstAttr) return;
    setForm((prev) => ({
      ...prev,
      elements: [
        ...(prev.elements || []),
        {
          id: `attr-${firstAttr.id}-${Date.now()}`,
          type: 'attribute',
          attributeId: firstAttr.id,
          enabled: true,
          fontSize: 8,
          showName: true,
        },
      ],
    }));
  };

  const appendElement = (element) => {
    setForm((prev) => ({
      ...prev,
      elements: [...(prev.elements || []), element],
    }));
  };

  const addNameElement = () => {
    if (hasElementType(form.elements, 'name')) return;
    appendElement({ id: 'name', type: 'name', enabled: true, fontSize: 11, bold: true });
  };

  const addSkuElement = () => {
    if (hasElementType(form.elements, 'sku')) return;
    appendElement({ id: 'sku', type: 'sku', enabled: true, fontSize: 9 });
  };

  const addBarcodeElement = () => {
    if (hasElementType(form.elements, 'barcode')) return;
    appendElement({
      id: 'barcode',
      type: 'barcode',
      enabled: true,
      widthMm: innerLabelWidthMm(form),
      heightMm: 14,
      showText: true,
      textFontSize: 8,
    });
  };

  const addKitComponentsElement = () => {
    if (hasElementType(form.elements, 'kit_components')) return;
    appendElement({
      id: 'kit_components',
      type: 'kit_components',
      enabled: true,
      fontSize: 8,
      titleFontSize: 8,
      showTitle: true,
      showQuantity: true,
      showSku: true,
      showName: true,
    });
  };

  const addUnitsPerBoxElement = () => {
    if (hasElementType(form.elements, 'units_per_box')) return;
    appendElement({
      id: 'units_per_box',
      type: 'units_per_box',
      enabled: true,
      fontSize: 16,
      bold: true,
    });
  };

  const addProductFieldElement = () => {
    const first = LABEL_PRODUCT_FIELDS[0];
    if (!first) return;
    setForm((prev) => ({
      ...prev,
      elements: [
        ...(prev.elements || []),
        {
          id: `field-${first.key}-${Date.now()}`,
          type: 'product_field',
          fieldKey: first.key,
          enabled: true,
          fontSize: 8,
          showName: true,
        },
      ],
    }));
  };

  const removeElement = (index) => {
    setForm((prev) => ({
      ...prev,
      elements: (prev.elements || []).filter((_, i) => i !== index),
    }));
  };

  const moveElement = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    setForm((prev) => {
      const elements = [...(prev.elements || [])];
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= elements.length || toIndex >= elements.length) {
        return prev;
      }
      const [item] = elements.splice(fromIndex, 1);
      elements.splice(toIndex, 0, item);
      return { ...prev, elements };
    });
  };

  const handleElementDragStart = (e, index) => {
    setDragElementIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleElementDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverElementIndex(index);
  };

  const handleElementDrop = (e, toIndex) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    const fromIndex = dragElementIndex ?? (raw !== '' ? Number(raw) : NaN);
    if (Number.isFinite(fromIndex)) moveElement(fromIndex, toIndex);
    setDragElementIndex(null);
    setDragOverElementIndex(null);
  };

  const handleElementDragEnd = () => {
    setDragElementIndex(null);
    setDragOverElementIndex(null);
  };

  const handleSave = async () => {
    if (!isPackaging && !isCell && !selectedCategoryId) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      if (isCell) {
        await cellLabelTemplatesApi.save(buildTemplatePayload(form, { cell: true }));
        setCellSaved(true);
        setMessage('Шаблон ячейки сохранён');
      } else if (isPackaging) {
        await packagingLabelTemplatesApi.save(buildTemplatePayload(form, { packaging: true }));
        setPackagingSaved(true);
        setMessage('Шаблон упаковки сохранён');
      } else {
        await categoryLabelTemplatesApi.save(selectedCategoryId, buildTemplatePayload(form));
        setMessage('Шаблон сохранён');
        const tplRes = await categoryLabelTemplatesApi.getAll();
        setTemplates(tplRes?.data || []);
      }
      setTimeout(() => setMessage(''), 3000);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const elementTypeMeta = isCell
    ? CELL_ELEMENT_TYPES
    : isPackaging
      ? PACKAGING_ELEMENT_TYPES
      : ELEMENT_TYPES;
  const previewProductList = isPackaging ? packagingProducts : categoryProducts;
  const showEditor = isPackaging || isCell || Boolean(selectedCategoryId);

  const labelMm = labelSizeMm(form);
  const previewSize =
    form.size_preset === 'custom'
      ? `${labelMm.widthMm} × ${labelMm.heightMm} мм`
      : LABEL_SIZES.find((s) => s.value === form.size_preset)?.label || form.size_preset;
  const previewAspect = `${labelMm.widthMm} / ${labelMm.heightMm}`;

  if (loading) {
    return <p className="label-constructor-loading">Загрузка…</p>;
  }

  return (
    <div className="label-constructor">
      <div className="label-constructor-mode-tabs" role="tablist" aria-label="Тип этикетки">
        <button
          type="button"
          role="tab"
          aria-selected={!isPackaging && !isCell}
          className={`label-constructor-mode-tab${!isPackaging && !isCell ? ' is-active' : ''}`}
          onClick={() => setEditorMode('product')}
        >
          Товар
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isPackaging}
          className={`label-constructor-mode-tab${isPackaging ? ' is-active' : ''}`}
          onClick={() => setEditorMode('packaging')}
        >
          Упаковка (ШК коробки)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isCell}
          className={`label-constructor-mode-tab${isCell ? ' is-active' : ''}`}
          onClick={() => setEditorMode('cell')}
        >
          Ячейка
        </button>
      </div>
      <p className="subtitle">
        {isCell
          ? 'Шаблон этикетки ячейки адресного хранения. Один на профиль — печать со вкладки «Ячейки».'
          : isPackaging
          ? 'Шаблон этикетки ШК упаковки для приёмки. Один на весь профиль — используется при печати из карточки товара.'
          : 'Настройте содержимое и отступы этикетки для каждой категории. При печати стикера товара используется шаблон его категории.'}
      </p>

      {error && <p className="error label-constructor-msg">{error}</p>}
      {message && <p className="label-constructor-success label-constructor-msg">{message}</p>}

      <div className="label-constructor-layout">
        <div className="label-constructor-sidebar">
          {isCell ? (
            <p className="label-constructor-hint" style={{ marginTop: 0 }}>
              {cellSaved
                ? 'Шаблон ячейки сохранён — печать этикеток ячеек идёт по нему.'
                : 'Шаблон не сохранён — печать ячеек идёт в прежнем виде (размер из настроек склада).'}
            </p>
          ) : isPackaging ? (
            <p className="label-constructor-hint" style={{ marginTop: 0 }}>
              {packagingSaved
                ? 'Шаблон упаковки сохранён.'
                : 'Шаблон не сохранён — при печати используются значения по умолчанию.'}
            </p>
          ) : (
            <>
              <label className="label-constructor-label" htmlFor="lc-category">
                Категория
              </label>
              <select
                id="lc-category"
                className="label-constructor-select"
                value={selectedCategoryId}
                onChange={(e) => setSelectedCategoryId(e.target.value)}
              >
                <option value="">— выберите категорию —</option>
                {categories.map((c) => {
                  const hasTpl = templates.some(
                    (t) => String(t.user_category_id ?? t.userCategoryId) === String(c.id)
                  );
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {hasTpl ? ' ✓' : ''}
                    </option>
                  );
                })}
              </select>
              {selectedCategoryId && (
                <p className="label-constructor-hint">
                  {hasSavedTemplate
                    ? 'Для категории сохранён свой шаблон.'
                    : 'Шаблон не сохранён — при печати используются значения по умолчанию.'}
                </p>
              )}
            </>
          )}
        </div>

        {showEditor ? (
          <div className="label-constructor-main">
          <div className="label-constructor-editor">
            <div className="label-constructor-row">
              <div className="form-group">
                <label htmlFor="lc-size">Размер этикетки</label>
                <select
                  id="lc-size"
                  value={form.size_preset}
                  onChange={(e) => {
                    const next = e.target.value;
                    setForm((p) => {
                      if (next === 'custom') {
                        const cur = labelSizeMm(p);
                        return {
                          ...p,
                          size_preset: 'custom',
                          width_mm: cur.widthMm,
                          height_mm: cur.heightMm,
                        };
                      }
                      return { ...p, size_preset: next, width_mm: null, height_mm: null };
                    });
                  }}
                  className="label-constructor-select"
                >
                  {LABEL_SIZES.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                  {isCell ? <option value="custom">Свой размер</option> : null}
                </select>
              </div>
              {isCell && form.size_preset === 'custom' ? (
                <>
                  <div className="form-group">
                    <label htmlFor="lc-width-mm">Ширина, мм</label>
                    <input
                      id="lc-width-mm"
                      type="number"
                      min={CUSTOM_SIZE_MIN_MM}
                      max={CUSTOM_SIZE_MAX_MM}
                      step={1}
                      className="label-constructor-select"
                      value={form.width_mm ?? 58}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          width_mm: clampLabelMm(e.target.value, 58),
                        }))
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="lc-height-mm">Высота, мм</label>
                    <input
                      id="lc-height-mm"
                      type="number"
                      min={CUSTOM_SIZE_MIN_MM}
                      max={CUSTOM_SIZE_MAX_MM}
                      step={1}
                      className="label-constructor-select"
                      value={form.height_mm ?? 40}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          height_mm: clampLabelMm(e.target.value, 40),
                        }))
                      }
                    />
                  </div>
                </>
              ) : null}
            </div>

            <fieldset className="label-constructor-fieldset">
              <legend>Отступы (мм)</legend>
              <div className="label-constructor-margins">
                {[
                  ['margin_top_mm', 'Сверху'],
                  ['margin_right_mm', 'Справа'],
                  ['margin_bottom_mm', 'Снизу'],
                  ['margin_left_mm', 'Слева'],
                  ['line_gap_mm', 'Между строками'],
                ].map(([key, label]) => (
                  <label key={key} className="label-constructor-margin-item">
                    <span>{label}</span>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      step={0.5}
                      value={form[key]}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setForm((p) => ({
                          ...p,
                          [key]: Number.isFinite(n) && n >= 0 ? n : 0,
                        }));
                      }}
                    />
                  </label>
                ))}
              </div>
              <p className="label-constructor-hint" style={{ marginTop: 8 }}>
                {isCell
                  ? '«Между строками» — интервал между полями (адрес, расшифровка, склад, штрихкод) и внутри длинного текста.'
                  : '«Между строками» — интервал внутри перенесённого текста (название, атрибуты) и отступ между полями (название, SKU, штрихкод). Для проверки переноса выберите товар с длинным названием или увеличьте шрифт названия.'}
              </p>
            </fieldset>

            <fieldset className="label-constructor-fieldset">
              <legend>Содержимое этикетки</legend>
              <p className="label-constructor-order-hint">
                Перетащите строку за ⋮⋮: что выше в списке — выше на этикетке.
              </p>
              <ul className="label-constructor-elements">
                {(form.elements || []).map((el, idx) => {
                  const meta = elementTypeMeta.find((t) => t.type === el.type);
                  const rowClass = [
                    'label-constructor-element',
                    dragElementIndex === idx ? 'is-dragging' : '',
                    dragOverElementIndex === idx && dragElementIndex !== idx ? 'is-drag-over' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <li
                      key={el.id || `${el.type}-${idx}`}
                      className={rowClass}
                      onDragOver={(e) => handleElementDragOver(e, idx)}
                      onDrop={(e) => handleElementDrop(e, idx)}
                    >
                      <button
                        type="button"
                        className="label-constructor-drag-handle"
                        draggable
                        onDragStart={(e) => handleElementDragStart(e, idx)}
                        onDragEnd={handleElementDragEnd}
                        title="Перетащите вверх или вниз"
                        aria-label="Изменить порядок на этикетке"
                      >
                        ⋮⋮
                      </button>
                      <div className="label-constructor-element-body">
                      <label className="label-constructor-element-check">
                        <input
                          type="checkbox"
                          checked={el.enabled !== false}
                          onChange={() => toggleElement(idx)}
                        />
                        <span>
                          {el.type === 'attribute'
                            ? `Атрибут: ${
                                availableAttributes.find((a) => String(a.id) === String(el.attributeId))
                                  ?.name || el.attributeId
                              }`
                            : el.type === 'product_field'
                              ? `Поле: ${labelProductFieldLabel(el.fieldKey)}`
                              : meta?.label || el.type}
                        </span>
                      </label>
                      {el.type === 'name' ||
                      el.type === 'sku' ||
                      el.type === 'kit_components' ||
                      el.type === 'attribute' ||
                      el.type === 'product_field' ||
                      el.type === 'units_per_box' ||
                      el.type === 'code' ||
                      el.type === 'legend' ||
                      el.type === 'warehouse' ? (
                        <>
                          <label className="label-constructor-mini">
                            Шрифт
                            <input
                              type="number"
                              min={6}
                              max={isPackaging || isCell ? 48 : 24}
                              value={el.fontSize ?? 9}
                              onChange={(e) =>
                                updateElement(idx, { fontSize: Number(e.target.value) || 9 })
                              }
                            />
                          </label>
                          <label className="label-constructor-mini">
                            Выравнивание
                            <select
                              className="label-constructor-select-sm"
                              value={normalizeAlign(
                                el.align,
                                el.type === 'units_per_box' ? 'center' : 'left'
                              )}
                              onChange={(e) => updateElement(idx, { align: e.target.value })}
                            >
                              <option value="left">Слева</option>
                              <option value="center">По центру</option>
                              <option value="right">Справа</option>
                            </select>
                          </label>
                        </>
                      ) : null}
                      {el.type === 'barcode' ? (
                        <>
                          <label className="label-constructor-mini">
                            Выравнивание
                            <select
                              className="label-constructor-select-sm"
                              value={normalizeAlign(el.align, 'center')}
                              onChange={(e) => updateElement(idx, { align: e.target.value })}
                            >
                              <option value="left">Слева</option>
                              <option value="center">По центру</option>
                              <option value="right">Справа</option>
                            </select>
                          </label>
                          <label className="label-constructor-mini">
                            Ширина кода (мм)
                            <input
                              type="number"
                              min={15}
                              max={120}
                              value={el.widthMm ?? innerLabelWidthMm(form)}
                              onChange={(e) =>
                                updateElement(idx, {
                                  widthMm: Math.min(
                                    120,
                                    Math.max(15, Number(e.target.value) || innerLabelWidthMm(form))
                                  ),
                                })
                              }
                            />
                          </label>
                          <label className="label-constructor-mini">
                            Высота кода (мм)
                            <input
                              type="number"
                              min={6}
                              max={40}
                              value={el.heightMm ?? 14}
                              onChange={(e) =>
                                updateElement(idx, { heightMm: Number(e.target.value) || 14 })
                              }
                            />
                          </label>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showText !== false}
                              onChange={(e) => updateElement(idx, { showText: e.target.checked })}
                            />
                            Цифры под кодом
                          </label>
                          {el.showText !== false ? (
                            <label className="label-constructor-mini">
                              Шрифт цифр
                              <input
                                type="number"
                                min={6}
                                max={isPackaging ? 36 : 24}
                                value={el.textFontSize ?? el.fontSize ?? 8}
                                onChange={(e) =>
                                  updateElement(idx, { textFontSize: Number(e.target.value) || 8 })
                                }
                              />
                            </label>
                          ) : null}
                        </>
                      ) : null}
                      {el.type === 'kit_components' ? (
                        <>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showTitle !== false}
                              onChange={(e) => updateElement(idx, { showTitle: e.target.checked })}
                            />
                            Заголовок «Состав:»
                          </label>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showQuantity !== false}
                              onChange={(e) => updateElement(idx, { showQuantity: e.target.checked })}
                            />
                            Количество
                          </label>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showSku !== false}
                              onChange={(e) => updateElement(idx, { showSku: e.target.checked })}
                            />
                            SKU
                          </label>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showName !== false}
                              onChange={(e) => updateElement(idx, { showName: e.target.checked })}
                            />
                            Название
                          </label>
                        </>
                      ) : null}
                      {el.type === 'attribute' ? (
                        <>
                          <select
                            className="label-constructor-select-sm"
                            value={el.attributeId ?? ''}
                            onChange={(e) =>
                              updateElement(idx, { attributeId: Number(e.target.value) })
                            }
                          >
                            {availableAttributes.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showName !== false}
                              onChange={(e) => updateElement(idx, { showName: e.target.checked })}
                            />
                            Показывать название
                          </label>
                        </>
                      ) : null}
                      {el.type === 'product_field' ? (
                        <>
                          <select
                            className="label-constructor-select-sm"
                            value={el.fieldKey ?? ''}
                            onChange={(e) => updateElement(idx, { fieldKey: e.target.value })}
                          >
                            {LABEL_PRODUCT_FIELDS.map((f) => (
                              <option key={f.key} value={f.key}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                          <label className="label-constructor-mini">
                            <input
                              type="checkbox"
                              checked={el.showName !== false}
                              onChange={(e) => updateElement(idx, { showName: e.target.checked })}
                            />
                            Показывать название
                          </label>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="label-constructor-remove"
                        onClick={() => removeElement(idx)}
                        title="Удалить поле"
                        aria-label="Удалить поле"
                      >
                        ×
                      </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="label-constructor-add-buttons d-flex flex-wrap gap-2 mt-2">
                {!isCell && !hasElementType(form.elements, 'name') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addNameElement}>
                    + Название
                  </button>
                ) : null}
                {!isCell && !hasElementType(form.elements, 'sku') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addSkuElement}>
                    + {isPackaging ? 'Артикул' : 'SKU'}
                  </button>
                ) : null}
                {!hasElementType(form.elements, 'barcode') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addBarcodeElement}>
                    + {isPackaging ? 'ШК упаковки' : isCell ? 'Штрихкод ячейки' : 'Штрихкод'}
                  </button>
                ) : null}
                {isCell && !hasElementType(form.elements, 'code') ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      appendElement({
                        id: 'code',
                        type: 'code',
                        enabled: true,
                        fontSize: 22,
                        bold: true,
                        align: 'center',
                      })
                    }
                  >
                    + Адрес ячейки
                  </button>
                ) : null}
                {isCell && !hasElementType(form.elements, 'legend') ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      appendElement({
                        id: 'legend',
                        type: 'legend',
                        enabled: true,
                        fontSize: 9,
                        align: 'center',
                      })
                    }
                  >
                    + Расшифровка
                  </button>
                ) : null}
                {isCell && !hasElementType(form.elements, 'warehouse') ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() =>
                      appendElement({
                        id: 'warehouse',
                        type: 'warehouse',
                        enabled: true,
                        fontSize: 9,
                        align: 'center',
                      })
                    }
                  >
                    + Склад
                  </button>
                ) : null}
                {isPackaging && !hasElementType(form.elements, 'units_per_box') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addUnitsPerBoxElement}>
                    + Шт. в упаковке
                  </button>
                ) : null}
                {!isPackaging && !isCell && !hasElementType(form.elements, 'kit_components') ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={addKitComponentsElement}
                    title="Печатается только для товаров типа «Комплект» с указанным составом"
                  >
                    + Комплектующие
                  </button>
                ) : null}
                {!isPackaging && !isCell && availableAttributes.length > 0 ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addAttributeElement}>
                    + Добавить атрибут
                  </button>
                ) : null}
                {!isPackaging && !isCell && availableAttributes.length === 0 && categoryAttributeIds.length > 0 ? (
                  <span className="text-muted small">
                    {previewProductId
                      ? 'У выбранного товара нет заполненных атрибутов категории.'
                      : 'Выберите товар для предпросмотра или заполните атрибуты в карточках.'}
                  </span>
                ) : null}
                {!isPackaging && !isCell && availableAttributes.length === 0 && categoryAttributeIds.length === 0 ? (
                  <span className="text-muted small">К категории не прикреплены атрибуты (Настройки → Категории).</span>
                ) : null}
                {!isPackaging && !isCell ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addProductFieldElement}>
                    + Добавить поле карточки
                  </button>
                ) : null}
              </div>
              <p className="text-muted small mt-2 mb-0">
                {isCell
                  ? 'На этикетке ячейки — только адрес, расшифровка уровней, склад и штрихкод. Поля товара (SKU, название) сюда не подходят.'
                  : isPackaging
                  ? 'На этикетке упаковки печатаются поля шаблона: артикул/название товара, ШК коробки и количество штук в упаковке. На маркетплейс не отправляется.'
                  : 'Поля карточки: габариты, бренд, категория и др. Блок «Комплектующие» выводится только у комплектов с составом в карточке товара. Не выводятся описание, фото, % выкупа, себестоимость, доп. расходы и мин. чистая прибыль.'}
              </p>
            </fieldset>

            <div className="label-constructor-actions">
              <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
                {saving
                  ? 'Сохранение…'
                  : isCell
                    ? 'Сохранить шаблон ячейки'
                    : isPackaging
                      ? 'Сохранить шаблон упаковки'
                      : 'Сохранить шаблон'}
              </Button>
            </div>

          </div>

          <aside className="label-constructor-preview-panel">
            <p className="label-constructor-preview-title">Предпросмотр ({previewSize})</p>
            {!isCell ? (
            <div className="form-group">
              <label htmlFor="lc-preview-product" className="label-constructor-label">
                Данные для предпросмотра
              </label>
              <select
                id="lc-preview-product"
                className="label-constructor-select"
                value={previewProductId}
                onChange={(e) => setPreviewProductId(e.target.value)}
              >
                <option value="">Пример (тестовые данные)</option>
                {previewProductList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.sku || `Товар #${p.id}`}
                  </option>
                ))}
              </select>
              {previewProductList.length === 0 && (
                <p className="label-constructor-hint">
                  {isPackaging ? 'Нет товаров — показан пример.' : 'В категории нет товаров — показан пример.'}
                </p>
              )}
            </div>
            ) : (
              <div className="form-group label-constructor-cell-preview-data">
                <label className="label-constructor-label">Данные для предпросмотра</label>
                {cellWarehouses.length > 1 ? (
                  <select
                    className="label-constructor-select mb-2"
                    value={previewWarehouseId}
                    onChange={(e) => {
                      setPreviewWarehouseId(e.target.value);
                      setPreviewLocationId('');
                    }}
                    aria-label="Склад для предпросмотра"
                  >
                    {cellWarehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name || `Склад #${w.id}`}
                      </option>
                    ))}
                  </select>
                ) : null}
                <select
                  className="label-constructor-select"
                  value={previewLocationId}
                  onChange={(e) => setPreviewLocationId(e.target.value)}
                  aria-label="Ячейка для предпросмотра"
                >
                  <option value="">Пример: {SAMPLE_CELL_PREVIEW.code}</option>
                  {cellLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.code || `Ячейка #${loc.id}`}
                    </option>
                  ))}
                </select>
                <dl className="label-constructor-sample-dl">
                  <div>
                    <dt>Адрес</dt>
                    <dd>{cellPreviewPayload?.code}</dd>
                  </div>
                  <div>
                    <dt>Расшифровка</dt>
                    <dd>{cellPreviewPayload?.legend}</dd>
                  </div>
                  <div>
                    <dt>Склад</dt>
                    <dd>{cellPreviewPayload?.warehouseName}</dd>
                  </div>
                  <div>
                    <dt>Штрихкод</dt>
                    <dd>{cellPreviewPayload?.barcode}</dd>
                  </div>
                </dl>
                {!previewLocationId ? (
                  <p className="label-constructor-hint mb-0">
                    Показан тестовый пример. Можно выбрать реальную ячейку — поля на этикетке обновятся.
                  </p>
                ) : null}
              </div>
            )}
            <div
              className="label-constructor-preview-frame"
              style={{ aspectRatio: previewAspect }}
            >
              {previewLoading && !previewUrl ? (
                <p className="label-constructor-preview-status">Обновление…</p>
              ) : null}
              {previewError ? (
                <p className="label-constructor-preview-status label-constructor-preview-error">{previewError}</p>
              ) : null}
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Предпросмотр этикетки"
                  className={`label-constructor-preview-img${previewLoading ? ' is-loading' : ''}`}
                />
              ) : !previewLoading && !previewError ? (
                <p className="label-constructor-preview-status">Нет данных</p>
              ) : null}
            </div>
            <p className="label-constructor-hint">
              {isCell
                ? 'Предпросмотр увеличен по данным выше. После сохранения печать ячеек использует этот шаблон.'
                : isPackaging
                ? 'Предпросмотр увеличен. Если у товара есть ШК коробки — он подставится; иначе используются тестовые данные.'
                : 'Предпросмотр увеличен для наглядности. Атрибуты — только с заполненным значением. Для блока комплектующих выберите комплект в списке или смотрите пример с тестовым составом.'}
            </p>
          </aside>
          </div>
        ) : (
          <p className="label-constructor-placeholder">Выберите категорию, чтобы настроить шаблон этикетки.</p>
        )}
      </div>
    </div>
  );
}
