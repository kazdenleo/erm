/**
 * Страница массового обогащения товаров (PartsIndex).
 * Вход: Товары → кнопка «Обогащение» в шапке (если модуль включён системным админом).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { Button } from '../../components/common/Button/Button';
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
import './ProductEnrichment.css';

/** Вес/габариты из БД (г / мм) → подпись в единицах аккаунта. */
function formatWeightDims(row, lengthUnit, weightUnit) {
  const wLabel = weightUnitLabel(weightUnit);
  const lLabel = lengthUnitLabel(lengthUnit);
  const weightStr =
    row.weight != null ? `${weightGToDisplay(row.weight, weightUnit) || '—'} ${wLabel}` : null;
  const hasDims = ![row.length, row.width, row.height].every((v) => v == null);
  const dimsStr = hasDims
    ? `${lengthMmToDisplay(row.length, lengthUnit) || '—'} × ${
        lengthMmToDisplay(row.width, lengthUnit) || '—'
      } × ${lengthMmToDisplay(row.height, lengthUnit) || '—'} ${lLabel}`
    : null;
  return { weightStr, dimsStr };
}

/**
 * Разбор строк: brand;sku | brand\tsku | brand,sku | brand sku
 * @param {string} text
 * @returns {{ brand: string, sku: string }[]}
 */
function parseBrandSkuList(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    if (/^(бренд|brand)\s*[;,\t]/i.test(line) && /артикул|sku|number/i.test(line)) {
      continue;
    }
    let brand = '';
    let sku = '';
    if (line.includes(';')) {
      const parts = line.split(';').map((p) => p.trim());
      brand = parts[0] || '';
      sku = parts[1] || '';
    } else if (line.includes('\t')) {
      const parts = line.split('\t').map((p) => p.trim());
      brand = parts[0] || '';
      sku = parts[1] || '';
    } else if (line.includes(',')) {
      const parts = line.split(',').map((p) => p.trim());
      brand = parts[0] || '';
      sku = parts[1] || '';
    } else {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        brand = parts[0];
        sku = parts.slice(1).join(' ');
      } else {
        sku = parts[0] || '';
      }
    }
    if (brand || sku) items.push({ brand, sku });
  }
  return items;
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

function buildDraftRows(reportResults, brands) {
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
        imageUrls: (c.images || [])
          .map((x) => (typeof x === 'string' ? x : x?.url))
          .filter(Boolean),
        brandId: findBrandIdByName(brands, brandName),
        categoryId: '',
        organizationId: '',
        createStatus: null,
        createError: null,
        productId: null,
      };
    });
}

export function ProductEnrichment() {
  const navigate = useNavigate();
  const { profile, isTenantAccountAdmin, refreshUser } = useAuth();
  const { brands } = useBrands();
  const { categories } = useCategories();
  const { organizations } = useOrganizations();

  const flagEnabled = isProfileProductEnrichmentEnabled(profile);
  const lengthUnit = getProfileLengthUnit(profile);
  const weightUnit = getProfileWeightUnit(profile);
  const [statusEnabled, setStatusEnabled] = useState(null);
  const enabled = statusEnabled === true || (statusEnabled == null && flagEnabled);
  const canEditKeys = isTenantAccountAdmin;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keys, setKeys] = useState(() => emptyPartsIndexKeysForm());
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysSaving, setKeysSaving] = useState(false);
  const [keysMessage, setKeysMessage] = useState('');
  const [keysError, setKeysError] = useState('');
  const [moduleInfo, setModuleInfo] = useState(null);

  const [listText, setListText] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [reportMeta, setReportMeta] = useState(null);
  const [draftRows, setDraftRows] = useState([]);
  const [bulkBrandId, setBulkBrandId] = useState('');
  const [bulkCategoryId, setBulkCategoryId] = useState('');
  const [bulkOrganizationId, setBulkOrganizationId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [createError, setCreateError] = useState('');

  const parsedItems = useMemo(() => parseBrandSkuList(listText), [listText]);
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
    refreshUser?.();
  }, [refreshUser]);

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
    setDraftRows((prev) =>
      prev.map((row) => {
        if (row.brandId || !row.brandName) return row;
        const id = findBrandIdByName(brands, row.brandName);
        return id ? { ...row, brandId: id } : row;
      })
    );
  }, [brands]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const items = parseBrandSkuList(listText);
    if (!items.length) {
      setRunError('Добавьте хотя бы одну строку: бренд и артикул');
      return;
    }
    setRunning(true);
    setRunError('');
    setReportMeta(null);
    setDraftRows([]);
    setCreateMessage('');
    setCreateError('');
    try {
      const res = await productsApi.enrichBulk(items, { apply: false });
      const data = res?.data ?? res;
      setReportMeta({
        total: data?.total ?? 0,
        ok: data?.ok ?? 0,
        failed: data?.failed ?? 0,
      });
      setDraftRows(buildDraftRows(data?.results || [], brands));
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

  const applyBulkToSelected = (field, value) => {
    setDraftRows((prev) =>
      prev.map((r) => (r.selected && !r.productId ? { ...r, [field]: value } : r))
    );
  };

  const createSelected = async () => {
    const toCreate = draftRows.filter((r) => r.selected && !r.productId);
    if (!toCreate.length) {
      setCreateError('Выберите хотя бы один товар');
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
          <label className="d-block mb-1" htmlFor="enrichment-list">
            <strong>Список для сбора</strong>
            <span
              className="text-muted small"
              style={{ display: 'block', fontWeight: 'normal', marginTop: 4 }}
            >
              Одна позиция на строку: <code>бренд;артикул</code>. После сбора появится таблица —
              отметьте строки, укажите бренд / категорию / организацию и нажмите «Добавить».
            </span>
          </label>
          <textarea
            id="enrichment-list"
            className="form-control"
            rows={8}
            value={listText}
            onChange={(e) => setListText(e.target.value)}
            placeholder={'Zekkert;TG-5127\nBosch;0986424590'}
            spellCheck={false}
          />
          <div className="product-enrichment-actions">
            <span className="text-muted small">
              {parsedItems.length > 0 ? `Строк: ${parsedItems.length}` : 'Список пуст'}
            </span>
            <Button
              type="button"
              variant="primary"
              onClick={runEnrichment}
              disabled={running || !parsedItems.length}
            >
              {running ? 'Сбор…' : 'Собрать контент'}
            </Button>
          </div>
          {runError && <div className="error mt-2">{runError}</div>}
        </section>

        {reportMeta && (
          <section className="product-enrichment-report">
            <h2 className="h6 mb-2">
              Собрано: {reportMeta.ok ?? 0} / {reportMeta.total ?? 0}
              {reportMeta.failed ? `, ошибок ${reportMeta.failed}` : ''}
            </h2>

            {draftRows.length === 0 ? (
              <p className="text-muted small mb-0">Нет успешных позиций для создания.</p>
            ) : (
              <>
                <div className="product-enrichment-bulk-bar">
                  <span className="text-muted small">Для выбранных:</span>
                  <select
                    className="form-control form-control-sm"
                    value={bulkBrandId}
                    onChange={(e) => {
                      setBulkBrandId(e.target.value);
                      applyBulkToSelected('brandId', e.target.value);
                    }}
                    title="Бренд"
                  >
                    <option value="">Бренд…</option>
                    {(brands || []).map((b) => (
                      <option key={b.id} value={String(b.id)}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="form-control form-control-sm"
                    value={bulkCategoryId}
                    onChange={(e) => {
                      setBulkCategoryId(e.target.value);
                      applyBulkToSelected('categoryId', e.target.value);
                    }}
                    title="Категория"
                  >
                    <option value="">Категория…</option>
                    {(categories || []).map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="form-control form-control-sm"
                    value={bulkOrganizationId}
                    onChange={(e) => {
                      setBulkOrganizationId(e.target.value);
                      applyBulkToSelected('organizationId', e.target.value);
                    }}
                    title="Организация"
                  >
                    <option value="">Организация…</option>
                    {(organizations || []).map((o) => (
                      <option key={o.id} value={String(o.id)}>
                        {o.name}
                      </option>
                    ))}
                  </select>
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
                        <th>Вес / габариты</th>
                        <th>Штрихкоды</th>
                        <th>Аналоги</th>
                        <th>Применимость</th>
                        <th>Описание</th>
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draftRows.map((row) => {
                        const { weightStr, dimsStr } = formatWeightDims(
                          row,
                          lengthUnit,
                          weightUnit
                        );
                        const descText =
                          row.description ||
                          (row.attributes?.length
                            ? row.attributes.map((a) => `${a.name}: ${a.value}`).join('\n')
                            : '');
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
                              {row.brandName ? (
                                <div className="text-muted small">{row.brandName}</div>
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
                                <option value="">—</option>
                                {(brands || []).map((b) => (
                                  <option key={b.id} value={String(b.id)}>
                                    {b.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
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
                            <td className="small">
                              <div>{weightStr || '—'}</div>
                              <div className="text-muted">{dimsStr || '—'}</div>
                            </td>
                            <td className="small product-enrichment-cell-scroll">
                              {row.barcodes?.length ? row.barcodes.join('\n') : '—'}
                            </td>
                            <td className="product-enrichment-cell-scroll">
                              {row.analogs?.length ? (
                                <ul className="product-enrichment-cell-list">
                                  {row.analogs.map((a, idx) => (
                                    <li key={`${a.id || a.code || idx}-${a.brand || ''}`}>
                                      {[a.brand, a.code].filter(Boolean).join(' ')}
                                      {a.relation ? (
                                        <span className="text-muted"> · {a.relation}</span>
                                      ) : null}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="text-muted small">—</span>
                              )}
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
                            <td className="small">
                              {row.productId ? (
                                <span className="text-success">создан #{row.productId}</span>
                              ) : row.createStatus === 'error' ? (
                                <span className="text-danger">
                                  {row.createError || 'ошибка'}
                                </span>
                              ) : (
                                <span className="text-muted">готов</span>
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
    </div>
  );
}

export default ProductEnrichment;
