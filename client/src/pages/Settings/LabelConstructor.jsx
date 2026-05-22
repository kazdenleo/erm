/**
 * Конструктор этикеток по категориям
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/common/Button/Button';
import { categoryLabelTemplatesApi } from '../../services/categoryLabelTemplates.api.js';
import { userCategoriesApi } from '../../services/userCategories.api.js';
import { productAttributesApi } from '../../services/productAttributes.api.js';
import { productsApi } from '../../services/products.api.js';
import { LABEL_SIZES } from './Labels.jsx';
import { LABEL_PRODUCT_FIELDS, labelProductFieldLabel } from '../../constants/labelProductFields.js';
import './LabelConstructor.css';

const ELEMENT_TYPES = [
  { type: 'name', label: 'Название товара' },
  { type: 'sku', label: 'SKU (артикул)' },
  { type: 'barcode', label: 'Штрихкод' },
  { type: 'kit_components', label: 'Комплектующие (только комплект)' },
  { type: 'attribute', label: 'Атрибут карточки' },
];

const LABEL_PRESET_MM = {
  '58x40': { widthMm: 58, heightMm: 40 },
  '75x120': { widthMm: 75, heightMm: 120 },
};

function innerLabelWidthMm(form) {
  const preset = LABEL_PRESET_MM[form?.size_preset] || LABEL_PRESET_MM['58x40'];
  const left = Number(form?.margin_left_mm ?? 2);
  const right = Number(form?.margin_right_mm ?? 2);
  return Math.max(20, preset.widthMm - left - right);
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

function normalizeTemplate(data) {
  const d = data?.data ?? data ?? {};
  const hasElementsList = Array.isArray(d.elements);
  return {
    size_preset: d.size_preset || d.sizePreset || '58x40',
    margin_top_mm: Number(d.margin_top_mm ?? d.marginTopMm ?? 2),
    margin_right_mm: Number(d.margin_right_mm ?? d.marginRightMm ?? 2),
    margin_bottom_mm: Number(d.margin_bottom_mm ?? d.marginBottomMm ?? 2),
    margin_left_mm: Number(d.margin_left_mm ?? d.marginLeftMm ?? 2),
    line_gap_mm: Number(d.line_gap_mm ?? d.lineGapMm ?? 1),
    elements: hasElementsList ? clampElementsForSave(d.elements) : defaultElements(d),
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

function clampElementsForSave(elements) {
  return (elements || []).map((el) => {
    const next = { ...el };
    if (el.type === 'barcode') {
      if (next.textFontSize != null) {
        next.textFontSize = clampFontSize(next.textFontSize, 8, 14);
      }
      if (next.widthMm != null) {
        next.widthMm = Math.min(120, Math.max(15, Number(next.widthMm) || 15));
      }
      if (next.heightMm != null) {
        next.heightMm = Math.min(40, Math.max(6, Number(next.heightMm) || 12));
      }
      return next;
    }
    if (
      el.type === 'name' ||
      el.type === 'sku' ||
      el.type === 'attribute' ||
      el.type === 'product_field' ||
      el.type === 'kit_components'
    ) {
      if (next.fontSize != null) {
        next.fontSize = clampFontSize(next.fontSize, el.type === 'name' ? 11 : 9);
      }
      if (next.titleFontSize != null) {
        next.titleFontSize = clampFontSize(next.titleFontSize, 8, 20);
      }
    }
    return next;
  });
}

/** Явный payload для API — чтобы line_gap_mm и отступы всегда уходили на сервер */
function buildTemplatePayload(form) {
  return {
    size_preset: form.size_preset,
    margin_top_mm: parseMmValue(form.margin_top_mm, 2),
    margin_right_mm: parseMmValue(form.margin_right_mm, 2),
    margin_bottom_mm: parseMmValue(form.margin_bottom_mm, 2),
    margin_left_mm: parseMmValue(form.margin_left_mm, 2),
    line_gap_mm: parseMmValue(form.line_gap_mm, 1),
    elements: clampElementsForSave(form.elements),
  };
}

export function LabelConstructor() {
  const [categories, setCategories] = useState([]);
  const [allAttributes, setAllAttributes] = useState([]);
  const [templates, setTemplates] = useState([]);
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
  const [dragElementIndex, setDragElementIndex] = useState(null);
  const [dragOverElementIndex, setDragOverElementIndex] = useState(null);

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
    if (!selectedCategoryId) return;
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
  }, [selectedCategoryId]);

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
    if (!selectedCategoryId) {
      setPreviewUrl('');
      return undefined;
    }

    let cancelled = false;
    let objectUrl = '';
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError('');
      try {
        const blob = await categoryLabelTemplatesApi.preview(
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
    selectedCategoryId,
    previewProductId,
    form.size_preset,
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
    if (!selectedCategoryId) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await categoryLabelTemplatesApi.save(selectedCategoryId, buildTemplatePayload(form));
      setMessage('Шаблон сохранён');
      const tplRes = await categoryLabelTemplatesApi.getAll();
      setTemplates(tplRes?.data || []);
      setTimeout(() => setMessage(''), 3000);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const previewSize = LABEL_SIZES.find((s) => s.value === form.size_preset)?.label || form.size_preset;
  const previewAspect = form.size_preset === '75x120' ? '75 / 120' : '58 / 40';

  if (loading) {
    return <p className="label-constructor-loading">Загрузка…</p>;
  }

  return (
    <div className="label-constructor">
      <p className="subtitle">
        Настройте содержимое и отступы этикетки для каждой категории. При печати стикера товара используется шаблон его категории.
      </p>

      {error && <p className="error label-constructor-msg">{error}</p>}
      {message && <p className="label-constructor-success label-constructor-msg">{message}</p>}

      <div className="label-constructor-layout">
        <div className="label-constructor-sidebar">
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
        </div>

        {selectedCategoryId ? (
          <div className="label-constructor-main">
          <div className="label-constructor-editor">
            <div className="label-constructor-row">
              <div className="form-group">
                <label htmlFor="lc-size">Размер этикетки</label>
                <select
                  id="lc-size"
                  value={form.size_preset}
                  onChange={(e) => setForm((p) => ({ ...p, size_preset: e.target.value }))}
                  className="label-constructor-select"
                >
                  {LABEL_SIZES.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
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
                «Между строками» — интервал внутри перенесённого текста (название, атрибуты) и отступ между
                полями (название, SKU, штрихкод). Для проверки переноса выберите товар с длинным названием
                или увеличьте шрифт названия.
              </p>
            </fieldset>

            <fieldset className="label-constructor-fieldset">
              <legend>Содержимое этикетки</legend>
              <p className="label-constructor-order-hint">
                Перетащите строку за ⋮⋮: что выше в списке — выше на этикетке.
              </p>
              <ul className="label-constructor-elements">
                {(form.elements || []).map((el, idx) => {
                  const meta = ELEMENT_TYPES.find((t) => t.type === el.type);
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
                      el.type === 'product_field' ? (
                        <label className="label-constructor-mini">
                          Шрифт
                          <input
                            type="number"
                            min={6}
                            max={24}
                            value={el.fontSize ?? 9}
                            onChange={(e) =>
                              updateElement(idx, { fontSize: Number(e.target.value) || 9 })
                            }
                          />
                        </label>
                      ) : null}
                      {el.type === 'barcode' ? (
                        <>
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
                                max={24}
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
                {!hasElementType(form.elements, 'name') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addNameElement}>
                    + Название
                  </button>
                ) : null}
                {!hasElementType(form.elements, 'sku') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addSkuElement}>
                    + SKU
                  </button>
                ) : null}
                {!hasElementType(form.elements, 'barcode') ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addBarcodeElement}>
                    + Штрихкод
                  </button>
                ) : null}
                {!hasElementType(form.elements, 'kit_components') ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={addKitComponentsElement}
                    title="Печатается только для товаров типа «Комплект» с указанным составом"
                  >
                    + Комплектующие
                  </button>
                ) : null}
                {availableAttributes.length > 0 ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addAttributeElement}>
                    + Добавить атрибут
                  </button>
                ) : categoryAttributeIds.length > 0 ? (
                  <span className="text-muted small">
                    {previewProductId
                      ? 'У выбранного товара нет заполненных атрибутов категории.'
                      : 'Выберите товар для предпросмотра или заполните атрибуты в карточках.'}
                  </span>
                ) : (
                  <span className="text-muted small">К категории не прикреплены атрибуты (Настройки → Категории).</span>
                )}
                <button type="button" className="btn btn-secondary btn-sm" onClick={addProductFieldElement}>
                  + Добавить поле карточки
                </button>
              </div>
              <p className="text-muted small mt-2 mb-0">
                Поля карточки: габариты, бренд, категория и др. Блок «Комплектующие» выводится только у комплектов с
                составом в карточке товара. Не выводятся описание, фото, % выкупа, себестоимость, доп. расходы и мин.
                чистая прибыль.
              </p>
            </fieldset>

            <div className="label-constructor-actions">
              <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Сохранение…' : 'Сохранить шаблон'}
              </Button>
            </div>

          </div>

          <aside className="label-constructor-preview-panel">
            <p className="label-constructor-preview-title">Предпросмотр ({previewSize})</p>
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
                {categoryProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.sku || `Товар #${p.id}`}
                  </option>
                ))}
              </select>
              {categoryProducts.length === 0 && (
                <p className="label-constructor-hint">В категории нет товаров — показан пример.</p>
              )}
            </div>
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
              Предпросмотр увеличен для наглядности. Атрибуты — только с заполненным значением. Для блока комплектующих
              выберите комплект в списке или смотрите пример с тестовым составом.
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
