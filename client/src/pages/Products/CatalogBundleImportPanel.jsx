/**
 * Вкладка «Из парсера»: ZIP или папка (Excel + папки фото по артикулам) → создание товаров.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { Button } from '../../components/common/Button/Button';
import { useBrands } from '../../hooks/useBrands';
import { useCategories } from '../../hooks/useCategories';
import { useOrganizations } from '../../hooks/useOrganizations';
import { productsApi } from '../../services/products.api.js';
import { pickSingleEntityId } from '../../utils/stockDestinationDefaults.js';

function rowKey(row) {
  return `${row.index}-${row.sku || ''}`;
}

/**
 * Собрать ZIP из FileList выбора папки (webkitdirectory).
 * @param {FileList|File[]} fileList
 * @returns {Promise<File>}
 */
async function zipFromFolderFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    throw new Error('Папка пустая');
  }
  const zip = new JSZip();
  let added = 0;
  for (const file of files) {
    const rel = String(file.webkitRelativePath || file.name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) continue;
    // пропускаем служебные файлы ОС
    if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(rel)) continue;
    if (rel.split('/').some((p) => p === '.' || p === '..')) continue;
    const buf = await file.arrayBuffer();
    zip.file(rel, buf);
    added += 1;
  }
  if (!added) {
    throw new Error('В папке нет файлов для импорта');
  }
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const rootName =
    String(files[0]?.webkitRelativePath || 'catalog')
      .split(/[/\\]/)[0]
      .replace(/[^\w\-А-Яа-яЁё .]+/g, '_')
      .trim() || 'catalog';
  return new File([blob], `${rootName}.zip`, { type: 'application/zip' });
}

export function CatalogBundleImportPanel() {
  const zipRef = useRef(null);
  const folderRef = useRef(null);
  const { brands } = useBrands();
  const { categories } = useCategories();
  const { organizations } = useOrganizations();
  const singleOrganizationId = useMemo(
    () => pickSingleEntityId(organizations),
    [organizations]
  );

  useEffect(() => {
    const el = folderRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [columns, setColumns] = useState([]);
  const [mapping, setMapping] = useState({ sku: '', name: '', brand: '' });
  const [rows, setRows] = useState([]);
  const [defaults, setDefaults] = useState({
    categoryId: '',
    organizationId: '',
    brandId: '',
  });
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [createError, setCreateError] = useState('');

  const selectedCount = useMemo(
    () => rows.filter((r) => r.selected && !r.productId && !r.skipped).length,
    [rows]
  );
  const selectable = rows.filter((r) => !r.productId && !r.skipped);
  const allSelected =
    selectable.length > 0 && selectable.every((r) => r.selected);

  const applyPreview = async (file) => {
    setUploading(true);
    setUploadError('');
    setCreateMessage('');
    setCreateError('');
    setRows([]);
    setSessionId('');
    try {
      const res = await productsApi.catalogBundlePreview(file);
      const data = res?.data ?? res;
      const suggested = data?.suggestedMapping || {};
      setSessionId(String(data?.sessionId || ''));
      setColumns(Array.isArray(data?.columns) ? data.columns : []);
      setMapping({
        sku: suggested.sku || '',
        name: suggested.name || '',
        brand: suggested.brand || '',
      });
      const nextRows = (data?.rows || []).map((r) => ({
        ...r,
        key: rowKey(r),
        selected: true,
        productId: null,
        skipped: false,
        createStatus: '',
        createError: '',
        imagesAdded: null,
      }));
      setRows(nextRows);
      setDefaults((d) => ({
        ...d,
        organizationId: d.organizationId || singleOrganizationId || '',
      }));
    } catch (err) {
      setUploadError(
        err?.response?.data?.message || err?.message || 'Не удалось разобрать данные'
      );
    } finally {
      setUploading(false);
    }
  };

  const onPickZip = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await applyPreview(file);
  };

  const onPickFolder = async (e) => {
    const list = e.target.files;
    e.target.value = '';
    if (!list?.length) return;
    setUploading(true);
    setUploadError('');
    setCreateMessage('');
    setCreateError('');
    try {
      const zipFile = await zipFromFolderFiles(list);
      await applyPreview(zipFile);
    } catch (err) {
      setUploading(false);
      setUploadError(err?.message || 'Не удалось упаковать папку');
    }
  };

  const updateRow = (key, patch) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const toggleSelectAll = (e) => {
    const checked = e.target.checked;
    setRows((prev) =>
      prev.map((r) =>
        r.productId || r.skipped ? r : { ...r, selected: checked }
      )
    );
  };

  const createSelected = async () => {
    if (!sessionId) {
      setCreateError('Сначала загрузите ZIP или папку');
      return;
    }
    const selected = rows.filter((r) => r.selected && !r.productId && !r.skipped);
    if (!selected.length) {
      setCreateError('Выберите позиции');
      return;
    }
    if (!defaults.categoryId || !defaults.organizationId) {
      setCreateError('Укажите категорию и организацию');
      return;
    }
    if (!mapping.sku) {
      setCreateError('Укажите колонку артикула');
      return;
    }

    setCreating(true);
    setCreateError('');
    setCreateMessage('');
    try {
      const brandName =
        (brands || []).find((b) => String(b.id) === String(defaults.brandId))?.name ||
        '';
      const res = await productsApi.catalogBundleCreate({
        sessionId,
        mapping,
        defaults: {
          categoryId: defaults.categoryId,
          organizationId: defaults.organizationId,
          brandId: defaults.brandId || undefined,
          brand: brandName || undefined,
        },
        selectedIndexes: selected.map((r) => r.index),
      });
      const data = res?.data ?? res;
      const byIndex = new Map(
        (data?.results || []).map((r) => [Number(r.index), r])
      );
      setRows((prev) =>
        prev.map((row) => {
          const hit = byIndex.get(Number(row.index));
          if (!hit) return row;
          if (hit.ok) {
            return {
              ...row,
              selected: false,
              productId: hit.productId,
              imagesAdded: hit.imagesAdded ?? 0,
              createStatus: 'ok',
              createError: '',
              skipped: false,
            };
          }
          if (hit.skipped) {
            return {
              ...row,
              selected: false,
              productId: hit.productId || row.productId,
              skipped: true,
              createStatus: 'skipped',
              createError: hit.error || 'Уже существует',
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
        `Создано: ${data?.ok ?? 0}` +
          (data?.skipped ? `, пропущено: ${data.skipped}` : '') +
          (data?.failed ? `, ошибок: ${data.failed}` : '')
      );
      setSessionId('');
    } catch (err) {
      setCreateError(
        err?.response?.data?.message || err?.message || 'Ошибка создания товаров'
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="catalog-bundle-panel">
      <p className="text-muted small mb-3">
        Загрузите результат парсера: ZIP или целиком папку — один Excel (.xlsx) и рядом папки,
        названные как артикулы, с фото внутри. До 5000 товаров и до 50 фото на товар.
        Существующие артикулы будут пропущены.
      </p>

      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <input
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          className="d-none"
          onChange={onPickZip}
        />
        <input
          ref={folderRef}
          type="file"
          className="d-none"
          multiple
          onChange={onPickFolder}
        />
        <Button
          type="button"
          variant="primary"
          onClick={() => folderRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Загрузка…' : 'Выбрать папку'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => zipRef.current?.click()}
          disabled={uploading}
        >
          Загрузить ZIP
        </Button>
        {rows.length > 0 ? (
          <span className="text-muted small">Строк: {rows.length}</span>
        ) : null}
      </div>
      {uploadError ? <div className="error mb-3">{uploadError}</div> : null}

      {rows.length > 0 ? (
        <>
          <section className="catalog-bundle-mapping mb-3">
            <h2 className="h6 mb-2">Сопоставление колонок</h2>
            <div className="catalog-bundle-mapping-grid">
              <label className="small">
                Артикул
                <select
                  className="form-control form-control-sm"
                  value={mapping.sku}
                  onChange={(e) => setMapping((m) => ({ ...m, sku: e.target.value }))}
                >
                  <option value="">—</option>
                  {columns.map((c) => (
                    <option key={`sku-${c}`} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Название
                <select
                  className="form-control form-control-sm"
                  value={mapping.name}
                  onChange={(e) => setMapping((m) => ({ ...m, name: e.target.value }))}
                >
                  <option value="">— (или артикул)</option>
                  {columns.map((c) => (
                    <option key={`name-${c}`} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Бренд (колонка)
                <select
                  className="form-control form-control-sm"
                  value={mapping.brand}
                  onChange={(e) => setMapping((m) => ({ ...m, brand: e.target.value }))}
                >
                  <option value="">—</option>
                  {columns.map((c) => (
                    <option key={`brand-${c}`} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="catalog-bundle-defaults mb-3">
            <h2 className="h6 mb-2">Общие поля для создания</h2>
            <div className="catalog-bundle-mapping-grid">
              <label className="small">
                Категория
                <select
                  className="form-control form-control-sm"
                  value={defaults.categoryId}
                  onChange={(e) =>
                    setDefaults((d) => ({ ...d, categoryId: e.target.value }))
                  }
                >
                  <option value="">—</option>
                  {(categories || []).map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Организация
                <select
                  className="form-control form-control-sm"
                  value={defaults.organizationId}
                  onChange={(e) =>
                    setDefaults((d) => ({ ...d, organizationId: e.target.value }))
                  }
                >
                  <option value="">—</option>
                  {(organizations || []).map((o) => (
                    <option key={o.id} value={String(o.id)}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Бренд (справочник)
                <select
                  className="form-control form-control-sm"
                  value={defaults.brandId}
                  onChange={(e) => setDefaults((d) => ({ ...d, brandId: e.target.value }))}
                >
                  <option value="">— из колонки / пусто</option>
                  {(brands || []).map((b) => (
                    <option key={b.id} value={String(b.id)}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <div className="product-enrichment-bulk-bar">
            <Button
              type="button"
              variant="primary"
              size="small"
              onClick={createSelected}
              disabled={creating || selectedCount === 0 || !sessionId}
            >
              {creating ? 'Создание…' : `Добавить (${selectedCount})`}
            </Button>
            {!sessionId ? (
              <span className="text-muted small ms-2">
                Сессия уже использована — загрузите данные снова для нового импорта
              </span>
            ) : null}
          </div>
          {createMessage ? <div className="small mb-2">{createMessage}</div> : null}
          {createError ? <div className="error mb-2">{createError}</div> : null}

          <div className="product-enrichment-table-wrap">
            <table className="product-enrichment-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      title="Выбрать все"
                      aria-label="Выбрать все"
                    />
                  </th>
                  <th>Артикул</th>
                  <th>Название</th>
                  <th>Бренд</th>
                  <th>Фото</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.key}
                    className={
                      row.productId && !row.skipped
                        ? 'is-created'
                        : row.skipped
                          ? 'is-skipped'
                          : row.createStatus === 'error'
                            ? 'is-error'
                            : ''
                    }
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={!!row.selected}
                        disabled={!!row.productId || !!row.skipped || !sessionId}
                        onChange={(e) => updateRow(row.key, { selected: e.target.checked })}
                        aria-label={`Выбрать ${row.sku}`}
                      />
                    </td>
                    <td>
                      <div className="small fw-semibold">{row.sku || '—'}</div>
                      {row.productId ? (
                        <div className="text-success small">#{row.productId}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="product-enrichment-name-cell">{row.name || '—'}</div>
                    </td>
                    <td className="small">{row.brand || '—'}</td>
                    <td className="small">
                      {row.imagesAdded != null
                        ? `${row.imagesAdded} прикреплено`
                        : row.imageCount
                          ? `${row.imageCount} в папке`
                          : '—'}
                    </td>
                    <td className="small">
                      {row.warnings?.length ? (
                        <span className="text-warning">{row.warnings.join('; ')}</span>
                      ) : null}
                      {row.createStatus === 'error' || row.skipped ? (
                        <div className={row.skipped ? 'text-muted' : 'text-danger'}>
                          {row.createError || (row.skipped ? 'пропуск' : 'ошибка')}
                        </div>
                      ) : row.productId ? (
                        <span className="text-success">создан</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default CatalogBundleImportPanel;
