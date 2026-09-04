/**
 * Конструктор Rich-контента по категориям: страница собирается из модулей.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { categoryRichContentTemplatesApi } from '../../services/categoryRichContentTemplates.api.js';
import { userCategoriesApi } from '../../services/userCategories.api.js';
import { productsApi } from '../../services/products.api.js';
import {
  RICH_MODULE_TYPES,
  RICH_ALIGN_OPTIONS,
  RICH_SIZE_OPTIONS,
  RICH_FONT_OPTIONS,
  RICH_SPACE_OPTIONS,
  RICH_BG_PRESETS,
  RICH_BG_FIT_OPTIONS,
  createRichContentModule,
  defaultRichContentModules,
  normalizeRichContentModules,
  normalizeModuleStyle,
  resolveRichModulesForRender,
  parseStoredRichContentModules,
  sampleRichContentContext,
} from '../../utils/richContentTemplate.js';
import {
  buildRichContentPreviewHtml,
  buildRichContentPreviewHtmlFromResolved,
} from '../../utils/marketplaceRichContentPreview.js';
import './LabelConstructor.css';
import './RichContentConstructor.css';

const PLACEHOLDER_HINT =
  'Плейсхолдеры: {{name}}, {{brand}}, {{sku}}, {{description}}, {{attr:ID}} или {{attr:Имя}}.';

const SHARED_CATEGORY_ID = 'shared';

function isSharedSelection(id) {
  return String(id || '') === SHARED_CATEGORY_ID;
}

function templateIsShared(t) {
  if (!t) return false;
  if (t.shared === true) return true;
  const id = t.user_category_id ?? t.userCategoryId;
  return id == null;
}

function ModuleStyleFields({ style, onChange }) {
  const s = normalizeModuleStyle(style);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const res = await categoryRichContentTemplatesApi.uploadBackground(file);
      const url = res?.data?.url || res?.url;
      if (!url) throw new Error('Сервер не вернул ссылку на файл');
      onChange({ backgroundImage: url });
    } catch (err) {
      setUploadError(err?.response?.data?.message || err?.message || 'Не удалось загрузить изображение');
    } finally {
      setUploading(false);
    }
  };

  return (
    <details className="rich-content-style">
      <summary>Оформление</summary>
      <div className="rich-content-style-grid">
        <label className="label-constructor-mini">
          Цвет фона
          <select
            className="label-constructor-select-sm"
            value={RICH_BG_PRESETS.some((p) => p.value === s.background) ? s.background : s.background ? '__custom' : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__custom') onChange({ background: s.background || '#ffffff' });
              else onChange({ background: v });
            }}
          >
            {RICH_BG_PRESETS.map((p) => (
              <option key={p.label} value={p.value}>
                {p.label}
              </option>
            ))}
            {s.background && !RICH_BG_PRESETS.some((p) => p.value === s.background) ? (
              <option value="__custom">Свой цвет</option>
            ) : (
              <option value="__custom">Свой цвет…</option>
            )}
          </select>
          <input
            type="color"
            className="rich-content-color"
            value={s.background || '#ffffff'}
            onChange={(e) => onChange({ background: e.target.value })}
            title="Цвет фона"
          />
        </label>
        <div className="rich-content-bg-image">
          <span className="rich-content-bg-image-label">Картинка фона</span>
          <input
            className="rich-content-input"
            placeholder="https://… или загрузите файл"
            value={s.backgroundImage}
            onChange={(e) => onChange({ backgroundImage: e.target.value })}
          />
          <div className="rich-content-bg-image-actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              hidden
              onChange={handleUpload}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? 'Загрузка…' : 'Выбрать файл'}
            </button>
            {s.backgroundImage ? (
              <button
                type="button"
                className="btn btn-link btn-sm px-1"
                onClick={() => onChange({ backgroundImage: '' })}
              >
                убрать
              </button>
            ) : null}
            <label className="label-constructor-mini">
              Как вписать
              <select
                className="label-constructor-select-sm"
                value={s.backgroundFit}
                onChange={(e) => onChange({ backgroundFit: e.target.value })}
              >
                {RICH_BG_FIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {uploadError ? <p className="label-constructor-preview-error">{uploadError}</p> : null}
          {s.backgroundImage ? (
            <div
              className="rich-content-bg-thumb"
              style={{
                backgroundImage: `url("${s.backgroundImage}")`,
                backgroundSize: s.backgroundFit === 'repeat' ? 'auto' : s.backgroundFit === 'contain' ? 'contain' : 'cover',
                backgroundRepeat: s.backgroundFit === 'repeat' ? 'repeat' : 'no-repeat',
                backgroundPosition: 'center',
                backgroundColor: s.background || '#eee',
              }}
              title={s.backgroundImage}
            />
          ) : null}
        </div>
        <label className="label-constructor-mini">
          Заголовок
          <input
            type="color"
            className="rich-content-color"
            value={s.titleColor || '#1a1a1a'}
            onChange={(e) => onChange({ titleColor: e.target.value })}
          />
          <button type="button" className="btn btn-link btn-sm px-1" onClick={() => onChange({ titleColor: '' })}>
            сброс
          </button>
        </label>
        <label className="label-constructor-mini">
          Текст
          <input
            type="color"
            className="rich-content-color"
            value={s.textColor || '#2b2b2b'}
            onChange={(e) => onChange({ textColor: e.target.value })}
          />
          <button type="button" className="btn btn-link btn-sm px-1" onClick={() => onChange({ textColor: '' })}>
            сброс
          </button>
        </label>
        <label className="label-constructor-mini">
          Выравнивание
          <select
            className="label-constructor-select-sm"
            value={s.align}
            onChange={(e) => onChange({ align: e.target.value })}
          >
            {RICH_ALIGN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label-constructor-mini">
          Шрифт
          <select
            className="label-constructor-select-sm"
            value={s.font}
            onChange={(e) => onChange({ font: e.target.value })}
          >
            {RICH_FONT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label-constructor-mini">
          Размер заголовка
          <select
            className="label-constructor-select-sm"
            value={s.titleSize}
            onChange={(e) => onChange({ titleSize: e.target.value })}
          >
            {RICH_SIZE_OPTIONS.map((o) => (
              <option key={`t-${o.value || 'def'}`} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label-constructor-mini">
          Размер текста
          <select
            className="label-constructor-select-sm"
            value={s.textSize}
            onChange={(e) => onChange({ textSize: e.target.value })}
          >
            {RICH_SIZE_OPTIONS.map((o) => (
              <option key={`b-${o.value || 'def'}`} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label-constructor-mini">
          Отступ
          <select
            className="label-constructor-select-sm"
            value={s.padding}
            onChange={(e) => onChange({ padding: e.target.value })}
          >
            {RICH_SPACE_OPTIONS.map((o) => (
              <option key={`p-${o.value || 'def'}`} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label-constructor-mini">
          Скругление
          <select
            className="label-constructor-select-sm"
            value={s.radius}
            onChange={(e) => onChange({ radius: e.target.value })}
          >
            {RICH_SPACE_OPTIONS.map((o) => (
              <option key={`r-${o.value || 'def'}`} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="label-constructor-mini">
          <input
            type="checkbox"
            checked={s.boldTitle !== false}
            onChange={(e) => onChange({ boldTitle: e.target.checked })}
          />
          Жирный заголовок
        </label>
      </div>
      <p className="label-constructor-hint">
        Цвет и картинка фона, отступы и шрифт видны в предпросмотре. На Ozon уходят размер, выравнивание
        и цвет текста (тёмный или серый) — произвольный фон площадка не принимает.
      </p>
    </details>
  );
}

export function RichContentConstructor({
  embeddedProductId = '',
  onModulesChange,
  hidePageHeader = false,
} = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const productIdParam = String(embeddedProductId || searchParams.get('productId') || '').trim();
  const editingProduct = Boolean(productIdParam);
  const categoryIdParam = editingProduct ? '' : searchParams.get('categoryId') || '';
  const selectedCategoryId = isSharedSelection(categoryIdParam) ? '' : categoryIdParam;
  const [categories, setCategories] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [modules, setModules] = useState(() => defaultRichContentModules());
  const modulesRef = useRef(modules);
  modulesRef.current = modules;
  const loadedCategoryRef = useRef('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [marketplace, setMarketplace] = useState('ozon');
  const [availableFields, setAvailableFields] = useState([]);
  const [previewProductId, setPreviewProductId] = useState('');
  const [categoryProducts, setCategoryProducts] = useState([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [templateSource, setTemplateSource] = useState('default');
  const [productLabel, setProductLabel] = useState('');

  const hasCategoryTemplate = useMemo(
    () =>
      Boolean(selectedCategoryId) &&
      templates.some(
        (t) =>
          !templateIsShared(t) &&
          String(t.user_category_id ?? t.userCategoryId) === String(selectedCategoryId)
      ),
    [templates, selectedCategoryId]
  );

  const hasSavedTemplate = editingProduct
    ? saved || templateSource === 'product'
    : (saved && templateSource === 'category') || hasCategoryTemplate;

  const loadBase = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [catRes, tplRes] = await Promise.all([
        userCategoriesApi.getAll(),
        categoryRichContentTemplatesApi.getAll(),
      ]);
      setCategories(catRes?.data || []);
      setTemplates(tplRes?.data || []);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (embeddedProductId) {
      setLoading(false);
      return;
    }
    loadBase();
  }, [loadBase, embeddedProductId]);

  useEffect(() => {
    if (typeof onModulesChange === 'function') onModulesChange(modules);
  }, [modules, onModulesChange]);

  const selectCategory = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('categoryId', String(id));
    else next.delete('categoryId');
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (editingProduct) {
      let cancelled = false;
      const key = `product:${productIdParam}`;
      const productChanged = loadedCategoryRef.current !== key;
      loadedCategoryRef.current = key;
      (async () => {
        if (productChanged) {
          setSyncing(true);
          try {
            const prodRes = await productsApi.getById(productIdParam);
            if (cancelled) return;
            const product = prodRes?.data ?? prodRes ?? {};
            setProductLabel(product.name || product.sku || `Товар #${productIdParam}`);
            setPreviewProductId(String(product.id || productIdParam));
            setCategoryProducts(product.id ? [product] : []);
            const own = parseStoredRichContentModules(
              product.rich_content_modules ?? product.richContentModules
            );
            if (own) {
              setModules(own);
              setSaved(true);
              setTemplateSource('product');
              setError('');
              setAvailableFields([]);
              setSyncing(false);
              return;
            }
            const catId = product.user_category_id ?? product.categoryId ?? product.category_id;
            if (catId) {
              const res = await categoryRichContentTemplatesApi.getByCategoryId(catId);
              if (cancelled) return;
              const data = res?.data ?? res ?? {};
              setModules(normalizeRichContentModules(data.modules));
              setSaved(false);
              setTemplateSource(res?.source || 'default');
            } else {
              setModules(defaultRichContentModules());
              setSaved(false);
              setTemplateSource('default');
            }
            setError('');
          } catch (e) {
            if (cancelled) return;
            setError(e?.response?.data?.message || e?.message || 'Ошибка загрузки шаблона товара');
            setModules(defaultRichContentModules());
            setSaved(false);
            setTemplateSource('default');
          } finally {
            if (!cancelled) setSyncing(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (!selectedCategoryId) {
      loadedCategoryRef.current = '';
      setModules(defaultRichContentModules());
      setSaved(false);
      setTemplateSource('default');
      setAvailableFields([]);
      setCategoryProducts([]);
      setPreviewProductId('');
      setProductLabel('');
      return undefined;
    }
    let cancelled = false;
    const categoryChanged = loadedCategoryRef.current !== selectedCategoryId;
    loadedCategoryRef.current = selectedCategoryId;
    (async () => {
      let currentModules = modulesRef.current;
      if (categoryChanged) {
        setPreviewProductId('');
        setCategoryProducts([]);
        setSyncing(true);
        try {
          const res = await categoryRichContentTemplatesApi.getByCategoryId(selectedCategoryId);
          if (cancelled) return;
          const data = res?.data ?? res ?? {};
          currentModules = normalizeRichContentModules(data.modules);
          setModules(currentModules);
          setSaved(Boolean(res?.saved));
          setTemplateSource(res?.source || 'default');
          setError('');
        } catch (e) {
          if (cancelled) return;
          setError(e?.response?.data?.message || e?.message || 'Ошибка загрузки шаблона');
          currentModules = defaultRichContentModules();
          setModules(currentModules);
          setSaved(false);
          setTemplateSource('default');
        }
        try {
          const res = await productsApi.getAll({ categoryId: selectedCategoryId, limit: 50 });
          if (!cancelled) setCategoryProducts((res?.data || []).slice(0, 50));
        } catch {
          if (!cancelled) setCategoryProducts([]);
        }
      } else {
        setSyncing(true);
      }
      try {
        const res = await categoryRichContentTemplatesApi.syncFields(selectedCategoryId, {
          modules: currentModules,
          marketplace,
        });
        if (cancelled) return;
        const data = res?.data ?? res ?? {};
        setAvailableFields(Array.isArray(data.available) ? data.available : []);
        if (Array.isArray(data.modules)) {
          setModules(normalizeRichContentModules(data.modules));
        }
      } catch {
        if (!cancelled) setAvailableFields([]);
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCategoryId, marketplace, editingProduct, productIdParam]);

  const updateModule = (index, patch) => {
    setModules((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const updateModuleStyle = (index, patch) => {
    setModules((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        style: normalizeModuleStyle({ ...(next[index].style || {}), ...patch }),
      };
      return next;
    });
  };

  const toggleModule = (index) => {
    const mod = modules[index];
    updateModule(index, { enabled: mod.enabled === false });
  };

  const addModule = (type) => {
    setModules((prev) => {
      const created = createRichContentModule(type);
      if (type === 'characteristics' && availableFields.length) {
        created.fields = availableFields.map((f) => ({ key: f.key, label: f.label }));
      }
      return [...prev, created];
    });
  };

  const removeModule = (index) => {
    setModules((prev) => prev.filter((_, i) => i !== index));
  };

  const moveModule = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    setModules((prev) => {
      const next = [...prev];
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= next.length || toIndex >= next.length) return prev;
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  };

  const handleDragStart = (e, index) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  };

  const handleDrop = (e, toIndex) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    const fromIndex = dragIndex ?? (raw !== '' ? Number(raw) : NaN);
    if (Number.isFinite(fromIndex)) moveModule(fromIndex, toIndex);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleSave = async () => {
    if (editingProduct) {
      setSaving(true);
      setMessage('');
      setError('');
      try {
        await productsApi.update(productIdParam, { rich_content_modules: modules });
        setSaved(true);
        setTemplateSource('product');
        setMessage('Вёрстка сохранена для этого товара. Генерация Rich-контента будет брать её, а не шаблон категории.');
        setTimeout(() => setMessage(''), 4000);
      } catch (e) {
        setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить вёрстку товара');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!selectedCategoryId) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await categoryRichContentTemplatesApi.save(selectedCategoryId, modules);
      setSaved(true);
      setTemplateSource('category');
      setMessage('Шаблон категории сохранён. Генерация в карточке товара использует эти модули.');
      const tplRes = await categoryRichContentTemplatesApi.getAll();
      setTemplates(tplRes?.data || []);
      setTimeout(() => setMessage(''), 4000);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (editingProduct) {
      setSaving(true);
      setMessage('');
      setError('');
      try {
        await productsApi.update(productIdParam, { rich_content_modules: null });
        setSaved(false);
        try {
          const prodRes = await productsApi.getById(productIdParam);
          const product = prodRes?.data ?? prodRes ?? {};
          const catId = product.user_category_id ?? product.categoryId ?? product.category_id;
          if (catId) {
            const res = await categoryRichContentTemplatesApi.getByCategoryId(catId);
            setModules(normalizeRichContentModules(res?.data?.modules));
            setTemplateSource(res?.source || 'default');
          } else {
            setModules(defaultRichContentModules());
            setTemplateSource('default');
          }
        } catch {
          setModules(defaultRichContentModules());
          setTemplateSource('default');
        }
        setMessage('Свой шаблон товара сброшен — снова действует шаблон категории.');
        setTimeout(() => setMessage(''), 4000);
      } catch (e) {
        setError(e?.response?.data?.message || e?.message || 'Не удалось сбросить шаблон товара');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!selectedCategoryId || !hasSavedTemplate) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      await categoryRichContentTemplatesApi.remove(selectedCategoryId);
      setSaved(false);
      const tplResAfter = await categoryRichContentTemplatesApi.getAll();
      setTemplates(tplResAfter?.data || []);
      setModules(defaultRichContentModules());
      setTemplateSource('default');
      setMessage('Шаблон удалён — снова используется базовая вёрстка.');
      setTimeout(() => setMessage(''), 4000);
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось удалить шаблон');
    } finally {
      setSaving(false);
    }
  };

  const toggleField = (modIndex, field) => {
    const mod = modules[modIndex];
    const key = String(field.key);
    const current = Array.isArray(mod.fields) ? mod.fields : [];
    const exists = current.some((f) => String(f.key) === key);
    updateModule(modIndex, {
      fields: exists
        ? current.filter((f) => String(f.key) !== key)
        : [...current, { key: field.key, label: field.label }],
    });
  };

  useEffect(() => {
    if (!selectedCategoryId && !editingProduct) {
      setPreviewHtml('');
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError('');
      try {
        if (previewProductId) {
          const body = await productsApi.generateRichContent(
            previewProductId,
            marketplace,
            null,
            null,
            modules
          );
          if (cancelled) return;
          const payload = body?.data ?? body;
          setPreviewHtml(buildRichContentPreviewHtml(marketplace, payload?.[marketplace] || payload));
        } else {
          const ctx = sampleRichContentContext(availableFields);
          const blocks = resolveRichModulesForRender(modules, ctx);
          if (cancelled) return;
          setPreviewHtml(buildRichContentPreviewHtmlFromResolved(marketplace, blocks));
        }
      } catch (e) {
        if (!cancelled) {
          setPreviewError(e?.response?.data?.message || e?.message || 'Не удалось построить предпросмотр');
          setPreviewHtml('');
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedCategoryId, editingProduct, previewProductId, modules, marketplace, availableFields]);

  if (loading && !embeddedProductId) {
    return (
      <div className="settings-page card settings-labels">
        {hidePageHeader ? null : <h1 className="title">Rich-контент</h1>}
        <p className="label-constructor-loading">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className={`settings-page card settings-labels rich-content-constructor${embeddedProductId ? ' is-embedded' : ''}`}>
      {embeddedProductId ? (
        <p className="subtitle" style={{ marginTop: 0 }}>
          Вёрстка этого товара. Если не сохранить свою — используется шаблон категории.
        </p>
      ) : (
        <>
          {hidePageHeader ? null : (
            <h1 className="title">{editingProduct ? 'Rich-контент товара' : 'Rich-контент'}</h1>
          )}
          <p className="subtitle">
            {editingProduct
              ? 'Свой шаблон только для этого товара. Остальные товары категории используют шаблон категории.'
              : 'Соберите страницу карточки из модулей. Шаблон задаётся для каждой категории. В карточке товара значки OZ/WB/ЯМ связывают Rich-контент между маркетплейсами.'}
          </p>
        </>
      )}

      {error && <p className="error label-constructor-msg">{error}</p>}
      {message && <p className="label-constructor-success label-constructor-msg">{message}</p>}

      <div className="label-constructor-layout">
        <div className="label-constructor-sidebar">
          {editingProduct ? (
            <>
              <p className="label-constructor-label">Товар</p>
              <p className="label-constructor-hint" style={{ marginBottom: 12 }}>
                {productLabel || `№ ${productIdParam}`}
              </p>
              <p className="label-constructor-hint">
                {templateSource === 'product' || saved
                  ? 'Сохранён свой шаблон этого товара — он важнее шаблона категории.'
                  : templateSource === 'category'
                    ? 'Пока действует шаблон категории. Сохраните, чтобы задать вёрстку только этому товару.'
                    : 'Сохраните, чтобы этот товар больше не брал шаблон категории.'}
              </p>
            </>
          ) : (
            <>
          <label className="label-constructor-label" htmlFor="rc-category">
            Категория
          </label>
          <select
            id="rc-category"
            className="label-constructor-select"
            value={selectedCategoryId}
            onChange={(e) => selectCategory(e.target.value)}
          >
            <option value="">— выберите категорию —</option>
            {categories.map((c) => {
              const hasTpl = templates.some(
                (t) =>
                  !templateIsShared(t) &&
                  String(t.user_category_id ?? t.userCategoryId) === String(c.id)
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
              {templateSource === 'category' || hasCategoryTemplate
                ? 'Для категории сохранён шаблон — генерация в карточке товара использует эти модули.'
                : 'Шаблон не сохранён — в карточке используется базовая вёрстка.'}
            </p>
          )}
            </>
          )}

          {editingProduct || selectedCategoryId ? (
            <>
              <label className="label-constructor-label" htmlFor="rc-mp" style={{ marginTop: 16 }}>
                Маркетплейс для характеристик
              </label>
              <select
                id="rc-mp"
                className="label-constructor-select"
                value={marketplace}
                onChange={(e) => setMarketplace(e.target.value)}
              >
                <option value="ozon">Ozon</option>
                <option value="wb">Wildberries</option>
                <option value="ym">Яндекс.Маркет</option>
              </select>
              <p className="label-constructor-hint">
                {editingProduct
                  ? 'В карточку попадут все заполненные характеристики выбранного маркетплейса.'
                  : syncing
                    ? 'Загрузка характеристик категории…'
                    : availableFields.length
                      ? `Подтянуто полей: ${availableFields.length}.`
                      : 'Сопоставьте категорию с маркетплейсом, чтобы появились характеристики.'}
              </p>
            </>
          ) : null}
        </div>

        {editingProduct || selectedCategoryId ? (
          <div className="label-constructor-main">
            <div className="label-constructor-editor">
              <fieldset className="label-constructor-fieldset">
                <legend>Модули страницы</legend>
                <p className="label-constructor-order-hint">
                  Перетащите строку за ⋮⋮: что выше — выше на странице. {PLACEHOLDER_HINT}
                </p>
                <ul className="label-constructor-elements">
                  {modules.map((mod, idx) => {
                    const meta = RICH_MODULE_TYPES.find((t) => t.type === mod.type);
                    const rowClass = [
                      'label-constructor-element',
                      'rich-content-module',
                      dragIndex === idx ? 'is-dragging' : '',
                      dragOverIndex === idx && dragIndex !== idx ? 'is-drag-over' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <li
                        key={mod.id || `${mod.type}-${idx}`}
                        className={rowClass}
                        onDragOver={(e) => handleDragOver(e, idx)}
                        onDrop={(e) => handleDrop(e, idx)}
                      >
                        <button
                          type="button"
                          className="label-constructor-drag-handle"
                          draggable
                          onDragStart={(e) => handleDragStart(e, idx)}
                          onDragEnd={() => {
                            setDragIndex(null);
                            setDragOverIndex(null);
                          }}
                          title="Перетащите вверх или вниз"
                          aria-label="Изменить порядок модулей"
                        >
                          ⋮⋮
                        </button>
                        <div className="label-constructor-element-body rich-content-module-body">
                          <label className="label-constructor-element-check">
                            <input
                              type="checkbox"
                              checked={mod.enabled !== false}
                              onChange={() => toggleModule(idx)}
                            />
                            <span>{meta?.label || mod.type}</span>
                          </label>

                          {mod.type === 'heading' ? (
                            <>
                              <label className="label-constructor-mini">
                                Источник
                                <select
                                  className="label-constructor-select-sm"
                                  value={mod.source}
                                  onChange={(e) => updateModule(idx, { source: e.target.value })}
                                >
                                  <option value="name">Название товара</option>
                                  <option value="custom">Свой текст</option>
                                </select>
                              </label>
                              {mod.source === 'custom' ? (
                                <input
                                  className="rich-content-input"
                                  placeholder="Заголовок, можно {{name}}"
                                  value={mod.text}
                                  onChange={(e) => updateModule(idx, { text: e.target.value })}
                                />
                              ) : null}
                              <label className="label-constructor-mini">
                                <input
                                  type="checkbox"
                                  checked={mod.showBrand !== false}
                                  onChange={(e) => updateModule(idx, { showBrand: e.target.checked })}
                                />
                                Показать бренд
                              </label>
                            </>
                          ) : null}

                          {mod.type === 'text' ? (
                            <>
                              <label className="label-constructor-mini">
                                Источник
                                <select
                                  className="label-constructor-select-sm"
                                  value={mod.source}
                                  onChange={(e) => updateModule(idx, { source: e.target.value })}
                                >
                                  <option value="description">Описание карточки</option>
                                  <option value="brand">Бренд</option>
                                  <option value="custom">Свой текст</option>
                                </select>
                              </label>
                              <input
                                className="rich-content-input"
                                placeholder="Заголовок блока"
                                value={mod.title}
                                onChange={(e) => updateModule(idx, { title: e.target.value })}
                              />
                              {mod.source === 'custom' ? (
                                <textarea
                                  className="rich-content-textarea"
                                  rows={3}
                                  placeholder="Текст с плейсхолдерами"
                                  value={mod.text}
                                  onChange={(e) => updateModule(idx, { text: e.target.value })}
                                />
                              ) : null}
                            </>
                          ) : null}

                          {mod.type === 'characteristics' ? (
                            <>
                              <input
                                className="rich-content-input"
                                placeholder="Заголовок"
                                value={mod.title}
                                onChange={(e) => updateModule(idx, { title: e.target.value })}
                              />
                              <label className="label-constructor-mini">
                                Поля
                                <select
                                  className="label-constructor-select-sm"
                                  value={mod.mode}
                                  onChange={(e) => updateModule(idx, { mode: e.target.value })}
                                >
                                  <option value="auto">Все заполненные</option>
                                  <option value="selected">Выбранные</option>
                                </select>
                              </label>
                              <label className="label-constructor-mini">
                                <input
                                  type="checkbox"
                                  checked={mod.includeBrand !== false}
                                  onChange={(e) => updateModule(idx, { includeBrand: e.target.checked })}
                                />
                                Бренд
                              </label>
                              <label className="label-constructor-mini">
                                <input
                                  type="checkbox"
                                  checked={mod.includeSku !== false}
                                  onChange={(e) => updateModule(idx, { includeSku: e.target.checked })}
                                />
                                Артикул
                              </label>
                              {mod.mode === 'selected' ? (
                                <div className="rich-content-fields">
                                  {syncing ? (
                                    <p className="label-constructor-hint">Загрузка характеристик категории…</p>
                                  ) : (availableFields.length ? availableFields : mod.fields || []).length === 0 ? (
                                    <p className="label-constructor-hint">
                                      У категории нет характеристик выбранного маркетплейса. Сопоставьте
                                      категорию в карточке категории.
                                    </p>
                                  ) : (
                                    (availableFields.length ? availableFields : mod.fields).map((field) => {
                                      const checked = (mod.fields || []).some(
                                        (f) => String(f.key) === String(field.key)
                                      );
                                      return (
                                        <label key={field.key} className="rich-content-field">
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => toggleField(idx, field)}
                                          />
                                          {field.label}
                                        </label>
                                      );
                                    })
                                  )}
                                </div>
                              ) : (
                                <p className="label-constructor-hint">
                                  {syncing
                                    ? 'Загрузка характеристик категории…'
                                    : availableFields.length
                                      ? `В карточку попадут все заполненные характеристики (${availableFields.length} полей категории).`
                                      : 'В карточку попадут все заполненные характеристики выбранного маркетплейса.'}
                                </p>
                              )}
                            </>
                          ) : null}

                          {mod.type === 'list' ? (
                            <>
                              <input
                                className="rich-content-input"
                                placeholder="Заголовок списка"
                                value={mod.title}
                                onChange={(e) => updateModule(idx, { title: e.target.value })}
                              />
                              <textarea
                                className="rich-content-textarea"
                                rows={4}
                                placeholder={'Пункты, каждый с новой строки\n{{brand}} · {{sku}}'}
                                value={(mod.items || []).join('\n')}
                                onChange={(e) =>
                                  updateModule(idx, {
                                    items: e.target.value.split(/\r?\n/),
                                  })
                                }
                              />
                            </>
                          ) : null}

                          {mod.type === 'images' ? (
                            <label className="label-constructor-mini">
                              Макс. фото
                              <input
                                type="number"
                                min={1}
                                max={15}
                                value={mod.max ?? 6}
                                onChange={(e) =>
                                  updateModule(idx, { max: Math.min(15, Math.max(1, Number(e.target.value) || 6)) })
                                }
                              />
                            </label>
                          ) : null}

                          <ModuleStyleFields
                            style={mod.style}
                            onChange={(patch) => updateModuleStyle(idx, patch)}
                          />
                        </div>
                        <button
                          type="button"
                          className="label-constructor-remove"
                          onClick={() => removeModule(idx)}
                          aria-label="Удалить модуль"
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="label-constructor-add-buttons d-flex flex-wrap gap-2 mt-2">
                  {RICH_MODULE_TYPES.map((t) => (
                    <button
                      key={t.type}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => addModule(t.type)}
                    >
                      + {t.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="label-constructor-actions d-flex flex-wrap gap-2">
                <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
                  {saving
                    ? 'Сохранение…'
                    : editingProduct
                      ? 'Сохранить для этого товара'
                      : 'Сохранить шаблон категории'}
                </Button>
                {hasSavedTemplate ? (
                  <Button type="button" variant="danger" onClick={handleDelete} disabled={saving}>
                    {editingProduct
                      ? 'Вернуть шаблон категории'
                      : 'Удалить шаблон категории'}
                  </Button>
                ) : null}
              </div>
            </div>

            <aside className="label-constructor-preview-panel">
              <p className="label-constructor-preview-title">Предпросмотр</p>
              <div className="form-group">
                <label htmlFor="rc-preview-product" className="label-constructor-label">
                  Данные для предпросмотра
                </label>
                <select
                  id="rc-preview-product"
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
                  <p className="label-constructor-hint">
                    В категории нет товаров — показан пример.
                  </p>
                )}
              </div>
              {previewError ? (
                <p className="label-constructor-preview-status label-constructor-preview-error">{previewError}</p>
              ) : null}
              {previewLoading && !previewHtml ? (
                <p className="label-constructor-preview-status">Сборка предпросмотра…</p>
              ) : previewHtml ? (
                <iframe
                  title="Предпросмотр Rich-контента"
                  srcDoc={previewHtml}
                  sandbox="allow-same-origin"
                  className={previewLoading ? 'rich-content-preview-frame is-loading' : 'rich-content-preview-frame'}
                />
              ) : (
                <p className="label-constructor-preview-status">Нет данных для предпросмотра.</p>
              )}
            </aside>
          </div>
        ) : (
          <p className="label-constructor-placeholder">
            Выберите категорию слева, чтобы собрать страницу из модулей.
          </p>
        )}
      </div>
    </div>
  );
}
