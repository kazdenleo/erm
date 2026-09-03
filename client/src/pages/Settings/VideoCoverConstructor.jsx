/**
 * Конструктор шаблона видеообложки Ozon: слайды из фото + эффект перехода.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/common/Button/Button';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { categoryVideoCoverTemplatesApi } from '../../services/categoryVideoCoverTemplates.api.js';
import { userCategoriesApi } from '../../services/userCategories.api.js';
import { productsApi } from '../../services/products.api.js';
import {
  VIDEO_COVER_TRANSITIONS,
  defaultVideoCoverSettings,
  normalizeVideoCoverSettings,
} from '../../utils/videoCoverTemplate.js';
import {
  VideoCoverPreview,
  productImageUrlsForVideoCoverPreview,
} from '../../components/common/VideoCoverPreview/VideoCoverPreview.jsx';
import './LabelConstructor.css';

const SHARED_ID = 'shared';

function isShared(id) {
  return String(id || '') === SHARED_ID;
}

function productLabel(p) {
  if (!p) return '';
  const name = String(p.name || p.title || '').trim();
  const sku = String(p.sku || p.article || '').trim();
  if (name && sku) return `${name} (${sku})`;
  return name || sku || `Товар #${p.id}`;
}

export function VideoCoverConstructor() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [categories, setCategories] = useState([]);
  const [selectedId, setSelectedId] = useState(() => searchParams.get('categoryId') || SHARED_ID);
  const [settings, setSettings] = useState(() => defaultVideoCoverSettings());
  /** Редактирование своего шаблона товара (?productId=) */
  const [productId, setProductId] = useState(() => searchParams.get('productId') || '');
  const [productTemplate, setProductTemplate] = useState(null);
  /** Товар только для превью (категорийный / общий шаблон) */
  const [previewProductId, setPreviewProductId] = useState('');
  const [previewProducts, setPreviewProducts] = useState([]);
  const [productImageUrls, setProductImageUrls] = useState([]);
  const [previewProductName, setPreviewProductName] = useState('');
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await userCategoriesApi.getAll();
        const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        if (!cancelled) setCategories(list.filter(Boolean));
      } catch (e) {
        if (!cancelled) setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить категории');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cat = searchParams.get('categoryId');
    const pid = searchParams.get('productId');
    if (pid) setProductId(String(pid));
    if (cat) setSelectedId(String(cat));
  }, [searchParams]);

  /** Загрузка шаблона (категория / общий / товар) */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      setMessage('');
      try {
        if (productId && /^\d+$/.test(String(productId))) {
          const res = await productsApi.getById(productId);
          const p = res?.data ?? res;
          if (cancelled) return;
          const own = p?.video_cover_template;
          setProductTemplate(own && typeof own === 'object' ? normalizeVideoCoverSettings(own) : null);
          setProductImageUrls(productImageUrlsForVideoCoverPreview(p?.images));
          setPreviewProductName(productLabel(p));
          setPreviewProductId(String(productId));
          if (own) {
            setSettings(normalizeVideoCoverSettings(own));
          } else if (p?.user_category_id || p?.categoryId) {
            const cid = p.user_category_id || p.categoryId;
            setSelectedId(String(cid));
            const tpl = await categoryVideoCoverTemplatesApi.getByCategoryId(cid);
            if (!cancelled) setSettings(normalizeVideoCoverSettings(tpl?.data?.settings || tpl?.settings));
          } else {
            const tpl = await categoryVideoCoverTemplatesApi.getShared();
            if (!cancelled) {
              setSelectedId(SHARED_ID);
              setSettings(normalizeVideoCoverSettings(tpl?.data?.settings || tpl?.settings));
            }
          }
        } else if (isShared(selectedId)) {
          const tpl = await categoryVideoCoverTemplatesApi.getShared();
          if (!cancelled) setSettings(normalizeVideoCoverSettings(tpl?.data?.settings || tpl?.settings));
        } else {
          const tpl = await categoryVideoCoverTemplatesApi.getByCategoryId(selectedId);
          if (!cancelled) setSettings(normalizeVideoCoverSettings(tpl?.data?.settings || tpl?.settings));
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить шаблон');
          setSettings(defaultVideoCoverSettings());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, productId]);

  /** Список товаров для селекта превью */
  useEffect(() => {
    if (productId && /^\d+$/.test(String(productId))) {
      setPreviewProducts([]);
      return undefined;
    }
    let cancelled = false;
    setPreviewProductId('');
    setProductImageUrls([]);
    setPreviewProductName('');
    setPreviewProducts([]);
    (async () => {
      try {
        const opts = isShared(selectedId)
          ? { limit: 50 }
          : { categoryId: selectedId, limit: 50 };
        const res = await productsApi.getAll(opts);
        if (cancelled) return;
        const list = (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []).slice(0, 50);
        setPreviewProducts(list);
        // Сразу пример конкретного товара, а не демо
        if (list.length) setPreviewProductId(String(list[0].id));
      } catch {
        if (!cancelled) setPreviewProducts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, productId]);

  /** Фото выбранного товара для превью (когда редактируем категорийный шаблон) */
  useEffect(() => {
    if (productId && /^\d+$/.test(String(productId))) return undefined;
    if (!previewProductId || !/^\d+$/.test(String(previewProductId))) {
      setProductImageUrls([]);
      setPreviewProductName('');
      return undefined;
    }
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        const res = await productsApi.getById(previewProductId);
        const p = res?.data ?? res;
        if (cancelled) return;
        setProductImageUrls(productImageUrlsForVideoCoverPreview(p?.images));
        setPreviewProductName(productLabel(p));
      } catch {
        if (!cancelled) {
          setProductImageUrls([]);
          setPreviewProductName('');
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewProductId, productId]);

  const patchSettings = (partial) => {
    setSettings((prev) => normalizeVideoCoverSettings({ ...prev, ...partial }));
  };

  const selectedCategoryName = useMemo(() => {
    if (isShared(selectedId)) return 'Все товары';
    const c = categories.find((x) => String(x.id) === String(selectedId));
    return c?.name || `Категория #${selectedId}`;
  }, [categories, selectedId]);

  const handleClearShared = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await categoryVideoCoverTemplatesApi.deleteShared();
      setSettings(defaultVideoCoverSettings());
      setMessage('Общий шаблон сброшен');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сбросить общий шаблон');
    } finally {
      setSaving(false);
    }
  };

  const handleClearCategory = async () => {
    if (isShared(selectedId)) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await categoryVideoCoverTemplatesApi.delete(selectedId);
      setSettings(defaultVideoCoverSettings());
      setMessage('Шаблон категории сброшен — для товаров этой категории будет общий');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сбросить шаблон категории');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCategory = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const normalized = normalizeVideoCoverSettings(settings);
      if (isShared(selectedId)) {
        await categoryVideoCoverTemplatesApi.saveShared(normalized);
        setMessage('Общий шаблон сохранён — действует для всех товаров без своего/категорийного');
      } else {
        await categoryVideoCoverTemplatesApi.save(selectedId, normalized);
        setMessage('Шаблон категории сохранён');
      }
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProduct = async () => {
    if (!productId || !/^\d+$/.test(String(productId))) {
      setError('Укажите id товара в URL (?productId=) или откройте конструктор из карточки');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const normalized = normalizeVideoCoverSettings(settings);
      await productsApi.update(productId, { video_cover_template: normalized });
      setProductTemplate(normalized);
      setMessage('Шаблон товара сохранён (переопределяет категорийный)');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Ошибка сохранения шаблона товара');
    } finally {
      setSaving(false);
    }
  };

  const handleClearProduct = async () => {
    if (!productId) return;
    setSaving(true);
    setError('');
    try {
      await productsApi.update(productId, { video_cover_template: null });
      setProductTemplate(null);
      setMessage('Свой шаблон товара сброшен — используется категорийный');
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось сбросить');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectCategory = (id) => {
    setProductId('');
    setSelectedId(id);
    const next = new URLSearchParams(searchParams);
    next.delete('productId');
    if (isShared(id)) next.delete('categoryId');
    else next.set('categoryId', String(id));
    setSearchParams(next, { replace: true });
  };

  const editingProduct = Boolean(productId && /^\d+$/.test(String(productId)));

  return (
    <div className="label-constructor-page">
      <PageTitle
        iconClass="pe-7s-film"
        iconBgClass="bg-happy-itmeo"
        title="Видеообложка Ozon"
        subtitle="Шаблон для всех товаров или отдельно по категории. Генерация слайдов — в карточке товара."
        actions={
          <Link to="/settings" className="btn btn-secondary btn-sm btn-shadow">
            ← К настройкам
          </Link>
        }
      />

      <div className="card p-3 mb-3">
        <div className="row g-2 align-items-end">
          <div className="col-md-6">
            <label className="form-label small text-muted mb-1">Область шаблона</label>
            <select
              className="form-select form-select-sm"
              value={isShared(selectedId) ? SHARED_ID : selectedId}
              onChange={(e) => handleSelectCategory(e.target.value)}
              disabled={loading || editingProduct}
            >
              <option value={SHARED_ID}>Все товары (общий шаблон)</option>
              {categories.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  Категория: {c.name || `#${c.id}`}
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-6">
            <div className="small text-muted">
              Сейчас: <strong>{editingProduct ? `товар #${productId}` : selectedCategoryName}</strong>
              {productTemplate ? ' · свой шаблон товара' : ''}
            </div>
            {!editingProduct ? (
              <p className="small text-muted mb-0 mt-1">
                Приоритет: свой шаблон товара → шаблон категории →{' '}
                <strong>все товары</strong>.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}
      {message ? <div className="alert alert-success">{message}</div> : null}

      {loading ? (
        <p className="text-muted">Загрузка…</p>
      ) : (
        <div className="row g-3">
          <div className="col-lg-8">
            <div className="card p-3">
              <h6 className="mb-3">Параметры слайдов</h6>
              <div className="row g-3">
                <div className="col-md-4">
                  <label className="form-label small">Макс. слайдов</label>
                  <input
                    type="number"
                    className="form-control form-control-sm"
                    min={1}
                    max={10}
                    value={settings.maxSlides}
                    onChange={(e) => patchSettings({ maxSlides: e.target.value })}
                  />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Длительность кадра, мс</label>
                  <input
                    type="number"
                    className="form-control form-control-sm"
                    min={400}
                    max={8000}
                    step={100}
                    value={settings.slideDurationMs}
                    onChange={(e) => patchSettings({ slideDurationMs: e.target.value })}
                  />
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Длительность перехода, мс</label>
                  <input
                    type="number"
                    className="form-control form-control-sm"
                    min={0}
                    max={3000}
                    step={50}
                    value={settings.transitionMs}
                    onChange={(e) => patchSettings({ transitionMs: e.target.value })}
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label small">Эффект перехода</label>
                  <select
                    className="form-select form-select-sm"
                    value={settings.transition}
                    onChange={(e) => patchSettings({ transition: e.target.value })}
                  >
                    {VIDEO_COVER_TRANSITIONS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-md-3">
                  <label className="form-label small">Соотношение</label>
                  <select
                    className="form-select form-select-sm"
                    value={settings.aspectRatio}
                    onChange={(e) => {
                      const aspectRatio = e.target.value;
                      if (aspectRatio === '1:1') patchSettings({ aspectRatio, width: 1000, height: 1000 });
                      else if (aspectRatio === '16:9') patchSettings({ aspectRatio, width: 1280, height: 720 });
                      else patchSettings({ aspectRatio: '3:4', width: 900, height: 1200 });
                    }}
                  >
                    <option value="3:4">3:4 (карточка)</option>
                    <option value="1:1">1:1</option>
                    <option value="16:9">16:9</option>
                  </select>
                </div>
                <div className="col-md-3 d-flex align-items-end">
                  <label className="form-check small mb-2">
                    <input
                      type="checkbox"
                      className="form-check-input me-2"
                      checked={settings.skipFirst === true}
                      onChange={(e) => patchSettings({ skipFirst: e.target.checked })}
                    />
                    Пропустить первое фото
                  </label>
                </div>
              </div>

              <p className="text-muted small mt-3 mb-0">
                Берутся изображения товара с включённым бейджем Ozon, по порядку галереи. При генерации
                создаются слайды; при ручной отправке карточки на Ozon URL уходит в атрибут «Видеообложка»
                (21845).
              </p>

              <div className="d-flex flex-wrap gap-2 mt-3">
                {editingProduct ? (
                  <>
                    <Button type="button" variant="primary" size="small" disabled={saving} onClick={handleSaveProduct}>
                      {saving ? 'Сохранение…' : 'Сохранить для этого товара'}
                    </Button>
                    {productTemplate ? (
                      <Button type="button" variant="secondary" size="small" disabled={saving} onClick={handleClearProduct}>
                        Сбросить шаблон товара
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Button type="button" variant="primary" size="small" disabled={saving} onClick={handleSaveCategory}>
                      {saving
                        ? 'Сохранение…'
                        : isShared(selectedId)
                          ? 'Сохранить для всех товаров'
                          : 'Сохранить шаблон категории'}
                    </Button>
                    {isShared(selectedId) ? (
                      <Button type="button" variant="secondary" size="small" disabled={saving} onClick={handleClearShared}>
                        Сбросить общий шаблон
                      </Button>
                    ) : (
                      <Button type="button" variant="secondary" size="small" disabled={saving} onClick={handleClearCategory}>
                        Сбросить шаблон категории
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="col-lg-4">
            <div className="card p-3 h-100">
              <h6 className="mb-3">Превью</h6>
              {!editingProduct ? (
                <div className="mb-3">
                  <label className="form-label small text-muted mb-1" htmlFor="vc-preview-product">
                    Товар для превью
                  </label>
                  <select
                    id="vc-preview-product"
                    className="form-select form-select-sm"
                    value={previewProductId}
                    onChange={(e) => setPreviewProductId(e.target.value)}
                    disabled={previewLoading}
                  >
                    <option value="">Демо-слайды</option>
                    {previewProducts.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {productLabel(p)}
                      </option>
                    ))}
                  </select>
                  {previewProducts.length === 0 ? (
                    <p className="text-muted small mt-1 mb-0">
                      {isShared(selectedId)
                        ? 'Нет товаров в профиле — показаны демо-слайды.'
                        : 'В категории нет товаров — показаны демо-слайды.'}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted small mb-3">
                  Фото товара {previewProductName || `#${productId}`}
                </p>
              )}
              {previewLoading ? (
                <p className="text-muted small">Загрузка фото…</p>
              ) : (
                <VideoCoverPreview settings={settings} imageUrls={productImageUrls} size="lg" />
              )}
              <p className="text-muted small mt-2 mb-0">
                {productImageUrls.length
                  ? `Показаны фото${previewProductName ? `: ${previewProductName}` : ' выбранного товара'} (Ozon).`
                  : 'Демо-слайды — выберите товар выше, чтобы увидеть реальные фото.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default VideoCoverConstructor;
