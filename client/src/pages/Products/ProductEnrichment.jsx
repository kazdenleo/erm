/**
 * Страница массового обогащения товаров (PartsIndex).
 * Вход: Товары → кнопка «Обогащение» в шапке (если модуль включён системным админом).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { useAuth } from '../../context/AuthContext.jsx';
import { useBrands } from '../../hooks/useBrands';
import { useCategories } from '../../hooks/useCategories';
import { useOrganizations } from '../../hooks/useOrganizations';
import { isProfileProductEnrichmentEnabled } from '../../utils/profileFlags.js';
import {
  getProfileLengthUnit,
  getProfileWeightUnit,
  lengthMmToDisplay,
  lengthUnitLabel,
  weightGToDisplay,
  weightUnitLabel,
} from '../../utils/displayUnits.js';
import { productsApi } from '../../services/products.api.js';
import { profilesApi } from '../../services/profiles.api.js';
import {
  emptyPartsIndexKeysForm,
  partsIndexKeysFromProfile,
} from '../../constants/partsindexKeys.js';
import { pickSingleEntityId } from '../../utils/stockDestinationDefaults.js';
import './ProductEnrichment.css';

const FILLABLE_COLUMNS = {
  brandId: { key: 'brandId', label: 'Бренд', optionsKey: 'brands' },
  categoryId: { key: 'categoryId', label: 'Категория', optionsKey: 'categories' },
  organizationId: {
    key: 'organizationId',
    label: 'Организация',
    optionsKey: 'organizations',
  },
};

/** Вес/габариты из БД (г / мм) → отображение в единицах аккаунта. */
function formatDimCell(mm, lengthUnit) {
  if (mm == null) return '—';
  return lengthMmToDisplay(mm, lengthUnit) || '—';
}

function formatWeightCell(g, weightUnit) {
  if (g == null) return '—';
  return weightGToDisplay(g, weightUnit) || '—';
}

/** Только артикулы аналогов через «; ». */
function formatAnalogsCodes(analogs) {
  const codes = (analogs || [])
    .map((a) => String(a?.code || '').trim())
    .filter(Boolean);
  return [...new Set(codes)].join('; ');
}

/**
 * Разбор столбца артикулов (вставка из Excel/таблиц):
 * - 1 артикул на строку
 * - поддерживаем табы и лишние разделители ; , как переносы строк
 * @param {string} text
 * @returns {string[]} уникальные SKU (в оригинальном виде), дедуп по UPPERCASE
 */
function parseSkuColumn(text) {
  const out = [];
  const seen = new Set();

  const raw = String(text || '')
    .replace(/\t/g, '\n')
    .replace(/[;,]/g, '\n');

  const lines = raw.split(/\r?\n/).map((l) => String(l).trim());
  for (const line of lines) {
    if (!line) continue;
    // Если в строке получилось "sku something" — берём первое слово.
    const token = line.split(/\s+/)[0]?.trim();
    if (!token) continue;

    const key = String(token).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }

  return out;
}

function normBrand(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9А-ЯЁ]/gi, '')
    .replace(/Ё/g, 'Е');
}

function findBrandIdByName(brands, name) {
  const want = normBrand(name);
  if (!want) return '';
  const hit = (brands || []).find((b) => normBrand(b.name) === want);
  if (hit?.id != null) return String(hit.id);
  const soft = (brands || []).find((b) => {
    const n = normBrand(b.name);
    return n && want && (n.includes(want) || want.includes(n));
  });
  return soft?.id != null ? String(soft.id) : '';
}

function rowKey(row, idx) {
  return `${row.index ?? idx}-${row.sku || ''}-${row.brand || ''}`;
}

function buildDraftRows(reportResults, brands, defaultOrganizationId = '') {
  const orgId = defaultOrganizationId ? String(defaultOrganizationId) : '';
  return (reportResults || [])
    .filter((r) => r.ok)
    .map((r, idx) => {
      const c = r.content || {};
      const brandName = r.matchedBrand || r.brand || '';
      return {
        key: rowKey(r, idx),
        selected: true,
        sourceIndex: r.index,
        brandName,
        sku: r.matchedNumber || r.sku || '',
        name: c.name || r.name || '',
        description: c.description || '',
        weight: c.weight ?? null,
        length: c.length ?? null,
        width: c.width ?? null,
        height: c.height ?? null,
        barcodes: Array.isArray(c.barcodes) ? c.barcodes : [],
        attributes: Array.isArray(c.attributes) ? c.attributes : [],
        analogs: Array.isArray(c.analogs) ? c.analogs : [],
        applicability: Array.isArray(c.applicability) ? c.applicability : [],
        imageUrls: (() => {
          const seen = new Set();
          const out = [];
          for (const x of c.images || []) {
            const url = String(typeof x === 'string' ? x : x?.url || '').trim();
            if (!url) continue;
            const key = url.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(url);
          }
          return out;
        })(),
        brandId: findBrandIdByName(brands, brandName),
        categoryId: '',
        organizationId: orgId,
        createStatus: null,
        createError: null,
        productId: null,
      };
    });
}

export function ProductEnrichment() {
  const navigate = useNavigate();
  const { profile, isTenantAccountAdmin, refreshUser } = useAuth();
  const { brands, createBrand, loadBrands } = useBrands();
  const { categories, createCategory } = useCategories();
  const { organizations } = useOrganizations();
  const singleOrganizationId = useMemo(
    () => pickSingleEntityId(organizations),
    [organizations]
  );

  const flagEnabled = isProfileProductEnrichmentEnabled(profile);
  const lengthUnit = getProfileLengthUnit(profile);
  const weightUnit = getProfileWeightUnit(profile);
  const lengthLbl = lengthUnitLabel(lengthUnit);
  const weightLbl = weightUnitLabel(weightUnit);
  const [statusEnabled, setStatusEnabled] = useState(null);
  // Не затираем флаг профиля ложным ответом статуса (гонка/пустой контекст).
  const enabled = flagEnabled || statusEnabled === true;
  const canEditKeys = isTenantAccountAdmin;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keys, setKeys] = useState(() => emptyPartsIndexKeysForm());
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysSaving, setKeysSaving] = useState(false);
  const [keysMessage, setKeysMessage] = useState('');
  const [keysError, setKeysError] = useState('');
  const [moduleInfo, setModuleInfo] = useState(null);

  const [brandText, setBrandText] = useState('');
  const [skuList, setSkuList] = useState([]);
  const [skuPasteModalOpen, setSkuPasteModalOpen] = useState(false);
  const [skuPasteText, setSkuPasteText] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [reportMeta, setReportMeta] = useState(null);
  const [collectErrors, setCollectErrors] = useState([]);
  const [draftRows, setDraftRows] = useState([]);
  const [bulkModal, setBulkModal] = useState({ open: false, column: null });
  const [bulkDraft, setBulkDraft] = useState('');
  const [categoryCreateModal, setCategoryCreateModal] = useState({
    open: false,
    applyMode: 'row',
    rowKey: null,
  });
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryCreating, setCategoryCreating] = useState(false);
  const [categoryCreateError, setCategoryCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [createError, setCreateError] = useState('');

  const skuCount = skuList.length;
  const selectedCount = useMemo(
    () => draftRows.filter((r) => r.selected && !r.productId).length,
    [draftRows]
  );
  const allSelectableSelected =
    draftRows.filter((r) => !r.productId).length > 0 &&
    draftRows.filter((r) => !r.productId).every((r) => r.selected);

  const reloadStatus = useCallback(async () => {
    try {
      const res = await productsApi.enrichmentStatus();
      const data = res?.data ?? res;
      setModuleInfo(data);
      if (typeof data?.enabled === 'boolean') setStatusEnabled(data.enabled);
    } catch {
      setModuleInfo(null);
      setStatusEnabled(null);
    }
  }, []);

  useEffect(() => {
    reloadStatus();
  }, [reloadStatus]);

  useEffect(() => {
    if (!canEditKeys || !settingsOpen) return;
    let cancelled = false;
    (async () => {
      setKeysLoading(true);
      setKeysError('');
      try {
        const res = await profilesApi.getMe();
        if (cancelled) return;
        setKeys(
          partsIndexKeysFromProfile(res?.data?.partsindex_keys ?? res?.data?.partsindexKeys)
        );
      } catch (err) {
        if (!cancelled) {
          setKeysError(err?.response?.data?.message || err?.message || 'Не удалось загрузить ключ');
        }
      } finally {
        if (!cancelled) setKeysLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canEditKeys, settingsOpen]);

  // Подставить brandId, когда бренды догрузились после сбора
  useEffect(() => {
    if (!brands?.length || !draftRows.length) return;
    setDraftRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (row.brandId || !row.brandName) return row;
        const id = findBrandIdByName(brands, row.brandName);
        if (!id) return row;
        changed = true;
        return { ...row, brandId: id };
      });
      return changed ? next : prev;
    });
  }, [brands, draftRows.length]);

  // Одна организация в аккаунте — подставляем по умолчанию
  useEffect(() => {
    if (!singleOrganizationId || !draftRows.length) return;
    setDraftRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (row.productId || row.organizationId) return row;
        changed = true;
        return { ...row, organizationId: singleOrganizationId };
      });
      return changed ? next : prev;
    });
  }, [singleOrganizationId, draftRows.length]);

  /** Найти бренд в каталоге или создать по имени из PartsIndex. */
  const ensureBrandIdsForRows = useCallback(
    async (rows) => {
      let list = brands || [];
      const result = [];
      for (const row of rows) {
        if (row.brandId || !row.brandName) {
          result.push(row);
          continue;
        }
        let id = findBrandIdByName(list, row.brandName);
        if (!id) {
          try {
            const created = await createBrand({ name: row.brandName });
            if (created?.id != null) {
              id = String(created.id);
              list = [...list, created];
            }
          } catch {
            /* оставляем пустым — пользователь выберет вручную */
          }
        }
        result.push(id ? { ...row, brandId: id } : row);
      }
      if (list !== brands) {
        await loadBrands?.();
      }
      return result;
    },
    [brands, createBrand, loadBrands]
  );

  const saveKeys = async () => {
    if (!canEditKeys) return;
    setKeysSaving(true);
    setKeysError('');
    setKeysMessage('');
    try {
      const res = await profilesApi.updateMe({
        partsindex_keys: partsIndexKeysFromProfile(keys),
      });
      if (!res?.ok) throw new Error(res?.message || 'Ошибка сохранения');
      setKeys(partsIndexKeysFromProfile(res?.data?.partsindex_keys ?? keys));
      setKeysMessage('Ключ сохранён');
      await refreshUser?.();
      await reloadStatus();
    } catch (err) {
      setKeysError(err?.response?.data?.message || err?.message || 'Ошибка сохранения ключа');
    } finally {
      setKeysSaving(false);
    }
  };

  const runEnrichment = async () => {
    const brand = String(brandText || '').trim();
    const skus = Array.isArray(skuList) ? skuList : [];
    if (!brand) {
      setRunError('Введите название бренда');
      return;
    }
    if (!skus.length) {
      setRunError('Добавьте хотя бы один артикул');
      return;
    }
    const items = skus.map((sku) => ({ brand, sku }));
    setRunning(true);
    setRunError('');
    setReportMeta(null);
    setCollectErrors([]);
    setDraftRows([]);
    setCreateMessage('');
    setCreateError('');
    try {
      const res = await productsApi.enrichBulk(items, { apply: false });
      const data = res?.data ?? res;
      const results = Array.isArray(data?.results) ? data.results : [];
      setReportMeta({
        total: data?.total ?? 0,
        ok: data?.ok ?? 0,
        failed: data?.failed ?? 0,
      });
      setCollectErrors(
        results
          .filter((r) => !r?.ok || (Array.isArray(r.warnings) && r.warnings.length))
          .map((r) => ({
            index: r.index,
            brand: r.brand || '',
            sku: r.sku || '',
            error: r.ok ? null : r.error || 'Ошибка сбора',
            warnings: Array.isArray(r.warnings) ? r.warnings : [],
          }))
      );
      const rows = buildDraftRows(results, brands, singleOrganizationId);
      setDraftRows(await ensureBrandIdsForRows(rows));
      await reloadStatus();
    } catch (err) {
      setRunError(err?.response?.data?.message || err?.message || 'Ошибка обогащения');
    } finally {
      setRunning(false);
    }
  };

  const toggleSelectAll = () => {
    const next = !allSelectableSelected;
    setDraftRows((prev) =>
      prev.map((r) => (r.productId ? r : { ...r, selected: next }))
    );
  };

  const updateRow = (key, patch) => {
    setDraftRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const openBulk = (columnKey) => {
    const col = FILLABLE_COLUMNS[columnKey];
    if (!col) return;
    setBulkDraft('');
    setBulkModal({ open: true, column: col });
  };

  const openCategoryCreate = (applyMode, rowKey = null) => {
    setNewCategoryName('');
    setCategoryCreateError('');
    setCategoryCreateModal({ open: true, applyMode, rowKey });
  };

  const closeCategoryCreate = () => {
    setCategoryCreateModal({ open: false, applyMode: 'row', rowKey: null });
    setNewCategoryName('');
    setCategoryCreateError('');
  };

  const submitCategoryCreate = async () => {
    const name = String(newCategoryName || '').trim();
    if (!name) {
      setCategoryCreateError('Укажите название категории');
      return;
    }
    setCategoryCreating(true);
    setCategoryCreateError('');
    try {
      const created = await createCategory({ name });
      const id = created?.id != null ? String(created.id) : '';
      if (!id) throw new Error('Категория создана без id');
      if (categoryCreateModal.applyMode === 'all') {
        setDraftRows((prev) =>
          prev.map((r) => (r.productId ? r : { ...r, categoryId: id }))
        );
        setBulkModal({ open: false, column: null });
        setBulkDraft('');
      } else if (categoryCreateModal.applyMode === 'row' && categoryCreateModal.rowKey) {
        updateRow(categoryCreateModal.rowKey, { categoryId: id });
      }
      closeCategoryCreate();
    } catch (err) {
      setCategoryCreateError(
        err?.response?.data?.message || err?.message || 'Не удалось создать категорию'
      );
    } finally {
      setCategoryCreating(false);
    }
  };

  const applyBulk = () => {
    const col = bulkModal.column;
    if (!col) return;
    setDraftRows((prev) =>
      prev.map((r) => (r.productId ? r : { ...r, [col.key]: bulkDraft }))
    );
    setBulkModal({ open: false, column: null });
    setBulkDraft('');
  };

  const createSelected = async () => {
    const toCreate = draftRows.filter((r) => r.selected && !r.productId);
    if (!toCreate.length) {
      setCreateError('Выберите хотя бы один товар');
      return;
    }
    const missing = toCreate.filter((r) => !r.categoryId || !r.organizationId);
    if (missing.length) {
      setCreateError(
        `Укажите категорию и организацию для всех выбранных товаров (без них: ${missing.length})`
      );
      return;
    }
    setCreating(true);
    setCreateError('');
    setCreateMessage('');
    try {
      const items = toCreate.map((r) => ({
        brand: r.brandName,
        sku: r.sku,
        name: r.name,
        description: r.description,
        weight: r.weight,
        length: r.length,
        width: r.width,
        height: r.height,
        barcodes: r.barcodes,
        imageUrls: r.imageUrls,
        analogs: r.analogs,
        applicability: r.applicability,
        brandId: r.brandId || null,
        categoryId: r.categoryId || null,
        organizationId: r.organizationId || null,
      }));
      const res = await productsApi.enrichCreate(items);
      const data = res?.data ?? res;
      const bySku = new Map(
        (data?.results || []).map((x) => [String(x.sku || '').toUpperCase(), x])
      );
      setDraftRows((prev) =>
        prev.map((row) => {
          if (!row.selected || row.productId) return row;
          const hit = bySku.get(String(row.sku || '').toUpperCase());
          if (!hit) return row;
          if (hit.ok) {
            return {
              ...row,
              selected: false,
              productId: hit.productId,
              createStatus: 'ok',
              createError: hit.imageWarning || null,
            };
          }
          return {
            ...row,
            createStatus: 'error',
            createError: hit.error || 'Ошибка создания',
          };
        })
      );
      setCreateMessage(
        `Создано: ${data?.ok ?? 0} из ${data?.total ?? toCreate.length}` +
          (data?.failed ? `, ошибок: ${data.failed}` : '')
      );
    } catch (err) {
      setCreateError(err?.response?.data?.message || err?.message || 'Ошибка создания товаров');
    } finally {
      setCreating(false);
    }
  };

  if (!enabled) {
    return (
      <div className="product-enrichment-page">
        <PageTitle
          iconClass="pe-7s-magic-wand"
          iconBgClass="bg-mean-fruit"
          title="Обогащение"
          subtitle="Модуль обогащения карточек через PartsIndex"
        />
        <div className="card product-enrichment-card">
          <p className="mb-0">
            Модуль не включён для этого аккаунта. Системный администратор включает его в админке
            платформы (Аккаунты → колонка «Обогащение»), затем администратор аккаунта открывает
            Товары → Обогащение и задаёт API-ключ PartsIndex.
          </p>
        </div>
      </div>
    );
  }

  const missingKey = !moduleInfo?.configured && (moduleInfo?.missingMethods || []).includes('apiKey');

  return (
    <div className="product-enrichment-page">
      <PageTitle
        iconClass="pe-7s-magic-wand"
        iconBgClass="bg-mean-fruit"
        title="Обогащение"
        subtitle="Список бренд + артикул → сбор из PartsIndex → создание карточек в каталоге."
        actions={
          <>
            <Button
              type="button"
              className="btn-shadow me-2"
              variant="secondary"
              size="small"
              onClick={() => navigate('/products')}
            >
              К списку товаров
            </Button>
            <Button
              type="button"
              className="btn-shadow"
              variant="secondary"
              size="small"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              {settingsOpen ? 'Скрыть настройки' : 'Настройки'}
            </Button>
          </>
        }
      />

      <div className="card product-enrichment-card">
        {settingsOpen && (
          <section className="product-enrichment-settings">
            <h2 className="h6 mb-1">API-ключ PartsIndex</h2>
            <p className="text-muted small mb-3">
              Ключ из кабинета{' '}
              <a href="https://api.parts-index.com/docs/ru/#/" target="_blank" rel="noreferrer">
                PartsIndex
              </a>
              . Scopes: <code>access</code>, <code>info</code>, <code>relations</code>,{' '}
              <code>old-apply</code>.
            </p>
            {!canEditKeys ? (
              <p className="text-muted small mb-0">
                Ключ задаёт администратор аккаунта (не системный admin платформы).
              </p>
            ) : keysLoading ? (
              <p className="text-muted small">Загрузка…</p>
            ) : (
              <div className="product-enrichment-keys">
                <label className="d-block mb-2">
                  <span className="text-muted small d-block mb-1">API Key</span>
                  <input
                    type="text"
                    className="form-control form-control-sm"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Ключ PartsIndex"
                    value={keys.apiKey || ''}
                    onChange={(e) => setKeys({ apiKey: e.target.value })}
                  />
                </label>
                <div className="d-flex gap-2 align-items-center flex-wrap mt-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="small"
                    onClick={saveKeys}
                    disabled={keysSaving}
                  >
                    {keysSaving ? 'Сохранение…' : 'Сохранить ключ'}
                  </Button>
                  {keysMessage && <span className="small">{keysMessage}</span>}
                </div>
                {keysError && <div className="error mt-2">{keysError}</div>}
              </div>
            )}
          </section>
        )}

        {missingKey && !settingsOpen && (
          <div className="product-enrichment-hint text-muted small">
            Нет API-ключа PartsIndex. Откройте «Настройки» и вставьте ключ.
          </div>
        )}

        <section className="product-enrichment-list">
          <div style={{ maxWidth: 720 }}>
            <div className="mb-3">
              <label className="d-block mb-1" htmlFor="enrichment-brand">
                <strong>Бренд</strong>
                <span
                  className="text-muted small"
                  style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}
                >
                  Название бренда пишем один раз (для всех артикулов ниже).
                </span>
              </label>
              <input
                id="enrichment-brand"
                type="text"
                className="form-control"
                value={brandText}
                onChange={(e) => setBrandText(e.target.value)}
                placeholder="Например: Zekkert"
                autoComplete="off"
              />
            </div>

            <div>
              <div className="d-flex align-items-end gap-2" style={{ flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <label className="d-block mb-1">
                    <strong>Артикулы</strong>
                    <span className="text-muted small d-block" style={{ fontWeight: 'normal', marginTop: 4 }}>
                      Нажмите кнопку — откроется окно, куда можно вставить список артикулов в столбец.
                    </span>
                  </label>
                  <div className="text-muted small" style={{ marginTop: 6 }}>
                    Добавлено: <strong>{skuCount}</strong>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setSkuPasteModalOpen(true)}
                >
                  Вставить артикулы
                </Button>
              </div>
            </div>
          </div>

          <div className="product-enrichment-actions">
            <span className="text-muted small">
              {brandText.trim() ? `Бренд: ${brandText.trim()}` : 'Бренд не задан'} ·{' '}
              {skuCount > 0 ? `Артикулы: ${skuCount}` : 'Артикулы не добавлены'}
            </span>
            <Button
              type="button"
              variant="primary"
              onClick={runEnrichment}
              disabled={running || !brandText.trim() || skuCount === 0}
            >
              {running ? 'Сбор…' : 'Собрать контент'}
            </Button>
          </div>
          {runError && <div className="error mt-2">{runError}</div>}
        </section>

        <Modal
          isOpen={skuPasteModalOpen}
          onClose={() => {
            setSkuPasteModalOpen(false);
            setSkuPasteText('');
          }}
          title="Артикулы для обогащения"
          size="small"
          scrollable
        >
          <div>
            <p className="text-muted small mb-2">
              Вставьте артикулы в столбец: один артикул на строку. Можно вставлять из Excel/таблиц.
            </p>
            <textarea
              className="form-control"
              rows={10}
              value={skuPasteText}
              onChange={(e) => setSkuPasteText(e.target.value)}
              placeholder={'TG-5127\n0986424590\n...'}
              spellCheck={false}
              autoFocus
            />
            <div className="product-enrichment-actions" style={{ marginTop: 12 }}>
              <span className="text-muted small">
                Будет добавлено:{' '}
                <strong>{parseSkuColumn(skuPasteText).length}</strong>
              </span>
              <div className="d-flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setSkuPasteModalOpen(false);
                    setSkuPasteText('');
                  }}
                >
                  Отмена
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    const next = parseSkuColumn(skuPasteText);
                    if (!next.length) {
                      setSkuPasteModalOpen(false);
                      setSkuPasteText('');
                      return;
                    }
                    setSkuList((prev) => {
                      const merged = [...(prev || [])];
                      const seen = new Set(merged.map((s) => String(s).toUpperCase()));
                      for (const s of next) {
                        const key = String(s).toUpperCase();
                        if (seen.has(key)) continue;
                        seen.add(key);
                        merged.push(s);
                      }
                      return merged;
                    });
                    setSkuPasteModalOpen(false);
                    setSkuPasteText('');
                  }}
                >
                  Добавить
                </Button>
              </div>
            </div>
          </div>
        </Modal>

        {reportMeta && (
          <section className="product-enrichment-report">
            <h2 className="h6 mb-2">
              Собрано: {reportMeta.ok ?? 0} / {reportMeta.total ?? 0}
              {reportMeta.failed ? `, ошибок ${reportMeta.failed}` : ''}
            </h2>

            {collectErrors.length > 0 ? (
              <div className="product-enrichment-errors mb-3" role="alert">
                <div className="product-enrichment-errors__title">
                  Ошибки и предупреждения сбора ({collectErrors.length})
                </div>
                <ul className="product-enrichment-errors__list">
                  {collectErrors.map((e, i) => (
                    <li key={`${e.index || i}-${e.sku}-${e.brand}`}>
                      <span className="product-enrichment-errors__sku">
                        {[e.brand, e.sku].filter(Boolean).join(' · ') || `Строка ${e.index || i + 1}`}
                      </span>
                      {e.error ? (
                        <span className="product-enrichment-errors__msg">{e.error}</span>
                      ) : null}
                      {e.warnings?.length ? (
                        <span className="product-enrichment-errors__warn">
                          {e.warnings.join('; ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {draftRows.length === 0 ? (
              <p className="text-muted small mb-0">
                {collectErrors.length
                  ? 'Успешных позиций для создания нет.'
                  : 'Нет успешных позиций для создания.'}
              </p>
            ) : (
              <>
                <div className="product-enrichment-bulk-bar">
                  <Button
                    type="button"
                    variant="primary"
                    size="small"
                    onClick={createSelected}
                    disabled={creating || selectedCount === 0}
                  >
                    {creating ? 'Создание…' : `Добавить (${selectedCount})`}
                  </Button>
                </div>
                {createMessage && <div className="small mb-2">{createMessage}</div>}
                {createError && <div className="error mb-2">{createError}</div>}

                <div className="product-enrichment-table-wrap">
                  <table className="product-enrichment-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            checked={allSelectableSelected}
                            onChange={toggleSelectAll}
                            title="Выбрать все"
                            aria-label="Выбрать все"
                          />
                        </th>
                        <th>Фото</th>
                        <th>Артикул</th>
                        <th>Название</th>
                        <th>Бренд</th>
                        <th>Категория</th>
                        <th>Организация</th>
                        <th>Длина, {lengthLbl}</th>
                        <th>Ширина, {lengthLbl}</th>
                        <th>Высота, {lengthLbl}</th>
                        <th>Вес, {weightLbl}</th>
                        <th>Штрихкоды</th>
                        <th>Аналоги</th>
                        <th>Применимость</th>
                        <th>Описание</th>
                      </tr>
                      <tr className="bulk-actions-row">
                        <th colSpan={4}>
                          <span className="text-muted" style={{ fontSize: 10 }}>
                            —
                          </span>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="product-enrichment-fill-btn"
                            onClick={() => openBulk('brandId')}
                          >
                            Заполнить
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="product-enrichment-fill-btn"
                            onClick={() => openBulk('categoryId')}
                          >
                            Заполнить
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="product-enrichment-fill-btn"
                            onClick={() => openBulk('organizationId')}
                          >
                            Заполнить
                          </button>
                        </th>
                        <th colSpan={8}>
                          <span className="text-muted" style={{ fontSize: 10 }}>
                            —
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {draftRows.map((row) => {
                        const descText =
                          row.description ||
                          (row.attributes?.length
                            ? row.attributes.map((a) => `${a.name}: ${a.value}`).join('\n')
                            : '');
                        const analogsText = formatAnalogsCodes(row.analogs);
                        return (
                          <tr
                            key={row.key}
                            className={
                              row.productId
                                ? 'is-created'
                                : row.createStatus === 'error'
                                  ? 'is-error'
                                  : ''
                            }
                          >
                            <td>
                              <input
                                type="checkbox"
                                checked={!!row.selected}
                                disabled={!!row.productId}
                                onChange={(e) =>
                                  updateRow(row.key, { selected: e.target.checked })
                                }
                                aria-label={`Выбрать ${row.sku}`}
                              />
                            </td>
                            <td>
                              {row.imageUrls?.length ? (
                                <div className="product-enrichment-images product-enrichment-images--table">
                                  {row.imageUrls.map((url) => (
                                    <a
                                      key={url}
                                      href={url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title="Открыть фото"
                                    >
                                      <img src={url} alt="" loading="lazy" />
                                    </a>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-muted small">—</span>
                              )}
                            </td>
                            <td>
                              <div className="small fw-semibold">{row.sku || '—'}</div>
                              {row.productId ? (
                                <div className="text-success small">#{row.productId}</div>
                              ) : row.createStatus === 'error' ? (
                                <div className="text-danger small">
                                  {row.createError || 'ошибка'}
                                </div>
                              ) : null}
                            </td>
                            <td>
                              <div className="product-enrichment-name-cell">
                                {row.name || '—'}
                              </div>
                            </td>
                            <td>
                              <select
                                className="form-control form-control-sm"
                                value={row.brandId}
                                disabled={!!row.productId}
                                onChange={(e) =>
                                  updateRow(row.key, { brandId: e.target.value })
                                }
                              >
                                <option value="">
                                  {row.brandName ? `${row.brandName}…` : '—'}
                                </option>
                                {(brands || []).map((b) => (
                                  <option key={b.id} value={String(b.id)}>
                                    {b.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <div className="product-enrichment-select-with-action">
                                <select
                                  className="form-control form-control-sm"
                                  value={row.categoryId}
                                  disabled={!!row.productId}
                                  onChange={(e) =>
                                    updateRow(row.key, { categoryId: e.target.value })
                                  }
                                >
                                  <option value="">—</option>
                                  {(categories || []).map((c) => (
                                    <option key={c.id} value={String(c.id)}>
                                      {c.name}
                                    </option>
                                  ))}
                                </select>
                                {!row.productId ? (
                                  <button
                                    type="button"
                                    className="product-enrichment-create-cat-btn"
                                    title="Создать категорию"
                                    onClick={() => openCategoryCreate('row', row.key)}
                                  >
                                    +
                                  </button>
                                ) : null}
                              </div>
                            </td>
                            <td>
                              <select
                                className="form-control form-control-sm"
                                value={row.organizationId}
                                disabled={!!row.productId}
                                onChange={(e) =>
                                  updateRow(row.key, { organizationId: e.target.value })
                                }
                              >
                                <option value="">—</option>
                                {(organizations || []).map((o) => (
                                  <option key={o.id} value={String(o.id)}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="small product-enrichment-dim-cell">
                              {formatDimCell(row.length, lengthUnit)}
                            </td>
                            <td className="small product-enrichment-dim-cell">
                              {formatDimCell(row.width, lengthUnit)}
                            </td>
                            <td className="small product-enrichment-dim-cell">
                              {formatDimCell(row.height, lengthUnit)}
                            </td>
                            <td className="small product-enrichment-dim-cell">
                              {formatWeightCell(row.weight, weightUnit)}
                            </td>
                            <td className="small product-enrichment-cell-scroll">
                              {row.barcodes?.length ? row.barcodes.join('\n') : '—'}
                            </td>
                            <td className="small product-enrichment-cell-scroll">
                              {analogsText || '—'}
                            </td>
                            <td className="product-enrichment-cell-scroll">
                              {row.applicability?.length ? (
                                <ul className="product-enrichment-cell-list">
                                  {row.applicability.map((a, idx) => (
                                    <li key={`${a.brand}-${a.model}-${idx}`}>
                                      {[a.brand, a.model, a.modif, a.years]
                                        .filter(Boolean)
                                        .join(' ')}
                                      {a.body ? (
                                        <span className="text-muted"> · {a.body}</span>
                                      ) : null}
                                      {a.engCode ? (
                                        <span className="text-muted"> · дв. {a.engCode}</span>
                                      ) : null}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="text-muted small">—</span>
                              )}
                            </td>
                            <td className="product-enrichment-cell-scroll">
                              {descText ? (
                                <pre className="product-enrichment-desc product-enrichment-desc--cell">
                                  {descText}
                                </pre>
                              ) : (
                                <span className="text-muted small">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}
      </div>

      <Modal
        isOpen={bulkModal.open && bulkModal.column != null}
        onClose={() => {
          setBulkModal({ open: false, column: null });
          setBulkDraft('');
        }}
        title={
          bulkModal.column
            ? `Массово: ${bulkModal.column.label}`
            : 'Массовое заполнение'
        }
        size="small"
      >
        {bulkModal.column ? (
          <div>
            <p className="text-muted small mb-2">
              Значение будет записано во все строки, которые ещё не созданы как товары.
            </p>
            <select
              className="form-control"
              value={bulkDraft}
              onChange={(e) => setBulkDraft(e.target.value)}
              autoFocus
            >
              <option value="">—</option>
              {(bulkModal.column.optionsKey === 'brands'
                ? brands
                : bulkModal.column.optionsKey === 'categories'
                  ? categories
                  : organizations || []
              ).map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name}
                </option>
              ))}
            </select>
            {bulkModal.column.key === 'categoryId' ? (
              <div className="mt-2">
                <button
                  type="button"
                  className="btn btn-link btn-sm p-0"
                  onClick={() => {
                    setBulkModal({ open: false, column: null });
                    openCategoryCreate('all');
                  }}
                >
                  Создать новую категорию…
                </button>
              </div>
            ) : null}
            <div className="d-flex justify-content-end gap-2 mt-3">
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => {
                  setBulkModal({ open: false, column: null });
                  setBulkDraft('');
                }}
              >
                Отмена
              </Button>
              <Button type="button" variant="primary" size="small" onClick={applyBulk}>
                Применить ко всем строкам
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        isOpen={categoryCreateModal.open}
        onClose={closeCategoryCreate}
        title="Новая категория"
        size="small"
      >
        <div>
          <p className="text-muted small mb-2">
            {categoryCreateModal.applyMode === 'all'
              ? 'Категория будет создана и проставлена во все строки без созданного товара.'
              : 'Категория будет создана и подставлена в выбранную строку.'}
          </p>
          <label className="form-label small mb-1" htmlFor="enrichment-new-category-name">
            Название
          </label>
          <input
            id="enrichment-new-category-name"
            className="form-control"
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitCategoryCreate();
              }
            }}
            placeholder="Например: Опоры шаровые"
            autoFocus
            disabled={categoryCreating}
          />
          {categoryCreateError ? (
            <div className="error mt-2 mb-0">{categoryCreateError}</div>
          ) : null}
          <div className="d-flex justify-content-end gap-2 mt-3">
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={closeCategoryCreate}
              disabled={categoryCreating}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant="primary"
              size="small"
              onClick={submitCategoryCreate}
              disabled={categoryCreating || !String(newCategoryName || '').trim()}
            >
              {categoryCreating ? 'Создание…' : 'Создать'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default ProductEnrichment;
