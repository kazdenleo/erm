/**
 * Products Page
 * Страница управления товарами
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProducts } from '../../hooks/useProducts';
import { useCategories } from '../../hooks/useCategories';
import { useBrands } from '../../hooks/useBrands';
import { useOrganizations } from '../../hooks/useOrganizations';
import { useWarehouses } from '../../hooks/useWarehouses';
import { productsApi } from '../../services/products.api.js';
import { Button } from '../../components/common/Button/Button';
import { Modal } from '../../components/common/Modal/Modal';
import { ProductForm } from '../../components/forms/ProductForm/ProductForm';
import { PageTitle } from '../../components/layout/PageTitle/PageTitle';
import { getPrimaryProductImageUrl } from '../../utils/productImage.js';
import './Products.css';

export function Products() {
  const PAGE_SIZE = 50;
  const [searchParams, setSearchParams] = useSearchParams();
  const { products, meta, loading, listRefreshing, error, createProduct, updateProduct, deleteProduct, loadProducts } = useProducts({ autoLoad: false });
  const { categories, loadCategories } = useCategories();
  const { brands } = useBrands();
  const { organizations } = useOrganizations();
  const { warehouses: warehousesList = [] } = useWarehouses();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [isRefreshingStocks, setIsRefreshingStocks] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportOrgId, setExportOrgId] = useState('');
  const [exportCatId, setExportCatId] = useState('');
  const [exportSearch, setExportSearch] = useState('');
  /** true — в Excel без колонок маркетплейсов, только ERP; по умолчанию false (выгружаем все атрибуты МП) */
  const [exportExcludeMpAttributes, setExportExcludeMpAttributes] = useState(false);
  const [filterOrganizationId, setFilterOrganizationId] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  /** '' | 'product' | 'kit' */
  const [filterProductType, setFilterProductType] = useState('');
  /** Остаток в списке по выбранному складу (свой склад, не поставщик) */
  const [filterWarehouseId, setFilterWarehouseId] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('productsListWarehouseId') || '' : '';
    } catch {
      return '';
    }
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** Поиск по названию / артикулу / штрихкоду (сервер, debounce) */
  const [listSearch, setListSearch] = useState('');
  const listSearchDebounceRef = useRef(null);
  const loadListRef = useRef(() => {});
  const [importExcelLoading, setImportExcelLoading] = useState(false);
  const importFileInputRef = useRef(null);
  const [importTemplateModalOpen, setImportTemplateModalOpen] = useState(false);
  const [importTemplateCatId, setImportTemplateCatId] = useState('');
  const [importTemplateExcludeMpAttributes, setImportTemplateExcludeMpAttributes] = useState(false);
  const [importTemplateLoading, setImportTemplateLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  /** id выбранных строк в текущем отфильтрованном списке */
  const [selectedProductIds, setSelectedProductIds] = useState(() => new Set());
  const selectAllCheckboxRef = useRef(null);

  const visibleProducts = useMemo(() => products.filter(Boolean), [products]);

  useEffect(() => {
    const visibleIds = new Set(visibleProducts.map((p) => String(p.id)));
    setSelectedProductIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (visibleIds.has(String(id))) next.add(String(id));
      }
      if (next.size === prev.size) {
        let same = true;
        for (const id of prev) {
          if (!next.has(String(id))) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, [visibleProducts]);

  const allVisibleSelected =
    visibleProducts.length > 0 && visibleProducts.every((p) => selectedProductIds.has(String(p.id)));
  const someVisibleSelected = visibleProducts.some((p) => selectedProductIds.has(String(p.id)));

  useEffect(() => {
    const el = selectAllCheckboxRef.current;
    if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  const toggleProductSelected = (productId, e) => {
    e?.stopPropagation?.();
    const sid = String(productId);
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  const toggleSelectAllVisible = (e) => {
    e?.stopPropagation?.();
    if (allVisibleSelected) {
      setSelectedProductIds(new Set());
    } else {
      setSelectedProductIds(new Set(visibleProducts.map((p) => String(p.id))));
    }
  };

  const loadList = (partial = {}) => {
    const org = partial.organizationId !== undefined ? partial.organizationId : filterOrganizationId;
    const cat = partial.categoryId !== undefined ? partial.categoryId : filterCategoryId;
    const pt = partial.productType !== undefined ? partial.productType : filterProductType;
    const wh = partial.warehouseId !== undefined ? partial.warehouseId : filterWarehouseId;
    const searchRaw = partial.search !== undefined ? partial.search : listSearch;
    const page = partial.page !== undefined ? partial.page : currentPage;
    const search = typeof searchRaw === 'string' ? searchRaw.trim() : '';
    const ptTrim = typeof pt === 'string' ? pt.trim() : '';
    loadProducts({
      organizationId: org || undefined,
      categoryId: cat || undefined,
      productType: ptTrim || undefined,
      search: search || undefined,
      warehouseId: wh || undefined,
      limit: PAGE_SIZE,
      offset: Math.max(0, (page - 1) * PAGE_SIZE),
      silent: true
    });
  };

  loadListRef.current = loadList;

  const activeFiltersCount =
    (filterOrganizationId ? 1 : 0) +
    (filterCategoryId ? 1 : 0) +
    (filterProductType ? 1 : 0) +
    (filterWarehouseId ? 1 : 0);
  const totalProducts = Number.isFinite(Number(meta?.total)) ? Number(meta.total) : visibleProducts.length;
  const totalPages = Math.max(1, Math.ceil(totalProducts / PAGE_SIZE));

  const clearListFilters = () => {
    setCurrentPage(1);
    setFilterOrganizationId('');
    setFilterCategoryId('');
    setFilterProductType('');
    setFilterWarehouseId('');
    try {
      localStorage.removeItem('productsListWarehouseId');
    } catch {
      /* ignore */
    }
    loadList({ organizationId: '', categoryId: '', productType: '', warehouseId: '', page: 1 });
  };

  const ownWarehouses = useMemo(
    () =>
      (warehousesList || []).filter(
        (w) => w && String(w.type || '').toLowerCase() !== 'supplier' && !w.supplierId
      ),
    [warehousesList]
  );

  const handleFilterWarehouseChange = (e) => {
    const v = e.target.value;
    setCurrentPage(1);
    setFilterWarehouseId(v);
    try {
      if (v) localStorage.setItem('productsListWarehouseId', v);
      else localStorage.removeItem('productsListWarehouseId');
    } catch {
      /* ignore */
    }
    loadList({ warehouseId: v, page: 1 });
  };

  const handleListSearchChange = (e) => {
    const v = e.target.value;
    setListSearch(v);
    if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    listSearchDebounceRef.current = setTimeout(() => {
      setCurrentPage(1);
      loadListRef.current({ search: v, page: 1 });
    }, 400);
  };

  useEffect(() => {
    return () => {
      if (listSearchDebounceRef.current) clearTimeout(listSearchDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const goToPage = (page) => {
    const next = Math.min(Math.max(1, page), totalPages);
    setCurrentPage(next);
    loadListRef.current({ page: next });
  };

  useEffect(() => {
    loadListRef.current({ warehouseId: filterWarehouseId, page: currentPage });
  }, []);

  const openProductIdParam = searchParams.get('open');

  useEffect(() => {
    if (!openProductIdParam) return;
    const id = Number(openProductIdParam);
    if (!Number.isInteger(id) || id < 1) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('open');
          return next;
        },
        { replace: true }
      );
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await loadCategories({ silent: categories.length > 0 });
        const response = await productsApi.getById(id);
        const full = response?.data ?? response;
        if (cancelled || !full?.id) return;
        setEditingProduct(full);
        setIsModalOpen(true);
      } catch (err) {
        if (!cancelled) console.error('Open product from URL:', err);
      } finally {
        if (!cancelled) {
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete('open');
              return next;
            },
            { replace: true }
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openProductIdParam, categories.length, setSearchParams]);

  const handleCreate = () => {
    setEditingProduct(null);
    void loadCategories({ silent: categories.length > 0 });
    setIsModalOpen(true);
  };

  const handleEdit = async (product) => {
    try {
      await loadCategories({ silent: categories.length > 0 });
      const response = await productsApi.getById(product.id);
      const fullProduct = response?.data ?? response;
      setEditingProduct(fullProduct || product);
      setIsModalOpen(true);
    } catch (err) {
      console.error('Error loading product details:', err);
      setEditingProduct(product);
      setIsModalOpen(true);
    }
  };

  const handleProductUpdate = (updatedProduct) => {
    // Обновляем editingProduct после синхронизации процента выкупа
    setEditingProduct(updatedProduct);
  };

  const handleSubmit = async (productData) => {
    try {
      if (editingProduct) {
        const updated = await updateProduct(editingProduct.id, productData);
        console.log('[Products] Product updated, returned product:', updated);
        console.log('[Products] Updated product buyout_rate:', updated?.buyout_rate);
        // Обновляем editingProduct с данными, возвращенными с сервера
        if (updated) {
          setEditingProduct(updated);
        }
        // Перезагружаем список товаров, чтобы получить актуальные данные
        await loadList();
      } else {
        const created = await createProduct(productData);
        console.log('[Products] Product created, returned product:', created);
        // Перезагружаем список товаров, чтобы получить актуальные данные с сервера
        await loadList();
      }
      setIsModalOpen(false);
      setEditingProduct(null);
    } catch (error) {
      console.error('Error saving product:', error);
      const message = error.response?.data?.message || error.message || 'Неизвестная ошибка';
      alert('Ошибка сохранения товара: ' + message);
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Вы уверены, что хотите удалить этот товар?')) {
      try {
        await deleteProduct(id);
    } catch (error) {
      console.error('Error deleting product:', error);
      const message = error.response?.data?.message || error.message || 'Неизвестная ошибка';
      alert('Ошибка удаления товара: ' + message);
    }
    }
  };

  const handleRefreshSupplierStocks = async () => {
    if (isRefreshingStocks) return;
    
    const confirmed = window.confirm(
      'Обновить остатки и цены у поставщиков для всех товаров? Это может занять некоторое время.'
    );
    
    if (!confirmed) return;
    
    setIsRefreshingStocks(true);
    try {
      console.log('[Products] Refreshing supplier stocks for all products...');
      console.log('[Products] Calling API: POST /products/refresh-supplier-stocks');
      const result = await productsApi.refreshSupplierStocks();
      console.log('[Products] API response:', result);
      
      if (result?.ok && result?.data) {
        const { success, failed, total } = result.data;
        alert(
          `Обновление завершено!\n\n` +
          `Всего товаров: ${total}\n` +
          `Успешно обновлено: ${success}\n` +
          `Ошибок: ${failed}`
        );
        
        // Перезагружаем список товаров, чтобы отобразить обновленные остатки и себестоимость
        console.log('[Products] Reloading products list after stock refresh...');
        await loadList();
        console.log('[Products] Products list reloaded');
      } else {
        alert('Ошибка обновления остатков: ' + (result?.message || 'Неизвестная ошибка'));
      }
    } catch (error) {
      console.error('[Products] Error refreshing supplier stocks:', error);
      alert('Ошибка обновления остатков: ' + (error.message || 'Неизвестная ошибка'));
    } finally {
      setIsRefreshingStocks(false);
    }
  };

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  if (error) {
    return <div className="error">Ошибка: {error}</div>;
  }

  const handleFilterOrganizationChange = (e) => {
    const v = e.target.value;
    setFilterOrganizationId(v);
    loadList({ organizationId: v });
  };

  const handleFilterCategoryChange = (e) => {
    const v = e.target.value;
    setFilterCategoryId(v);
    loadList({ categoryId: v });
  };

  const handleFilterProductTypeChange = (e) => {
    const v = e.target.value;
    setFilterProductType(v);
    loadList({ productType: v });
  };

  const openExportModal = () => {
    setExportOrgId(filterOrganizationId);
    setExportCatId(filterCategoryId);
    setExportSearch('');
    setExportExcludeMpAttributes(false);
    void loadCategories();
    setExportModalOpen(true);
  };

  const handleExportExcelFromModal = async () => {
    setExportLoading(true);
    try {
      const { buffer: buf, exportedCount } = await productsApi.exportExcel({
        organizationId: exportOrgId || undefined,
        categoryId: exportCatId || undefined,
        search: exportSearch.trim() || undefined,
        includeMp: !exportExcludeMpAttributes
      });
      if (exportedCount === 0) {
        alert(
          'В выгрузку не попало ни одного товара.\n\n' +
            'Частая причина: у товаров не заполнено поле «Организация» в карточке, а у выбранной организации другой профиль.\n' +
            'Попробуйте «Все организации» или укажите организацию у товаров.'
        );
      }
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `products_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportModalOpen(false);
    } catch (err) {
      let msg = err.response?.data?.message || err.response?.data?.error || err.message || 'Ошибка экспорта';
      if (err.response?.data instanceof ArrayBuffer) {
        try {
          const txt = new TextDecoder().decode(err.response.data);
          const j = JSON.parse(txt);
          msg = j.message || j.error || msg;
        } catch (_) {
          /* ignore */
        }
      }
      alert('Экспорт в Excel: ' + msg);
    } finally {
      setExportLoading(false);
    }
  };

  const openImportTemplateModal = () => {
    setImportTemplateCatId(filterCategoryId || '');
    setImportTemplateExcludeMpAttributes(false);
    void loadCategories();
    setImportTemplateModalOpen(true);
  };

  const handleDownloadImportTemplate = async () => {
    setImportTemplateLoading(true);
    try {
      const { buffer: buf, filenameHint } = await productsApi.downloadImportTemplateExcel({
        categoryId: importTemplateCatId || undefined,
        includeMp: !importTemplateExcludeMpAttributes
      });
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameHint || 'products_import_template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setImportTemplateModalOpen(false);
    } catch (err) {
      let msg = err.response?.data?.message || err.message || 'Ошибка';
      if (err.response?.data instanceof ArrayBuffer) {
        try {
          const txt = new TextDecoder().decode(err.response.data);
          const j = JSON.parse(txt);
          msg = j.message || j.error || msg;
        } catch (_) {
          /* ignore */
        }
      }
      alert('Шаблон для импорта: ' + msg);
    } finally {
      setImportTemplateLoading(false);
    }
  };

  const handleImportExcelPick = () => importFileInputRef.current?.click();

  const handleImportExcelFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportExcelLoading(true);
    try {
      const res = await productsApi.importExcel(file);
      const summary = res?.data ?? res;
      await loadList();
      const lines = [
        `Обновлено: ${summary.updated ?? 0}, создано: ${summary.created ?? 0}, пропущено строк: ${summary.skipped ?? 0}.`,
        (summary.warnings && summary.warnings.length > 0 && `Предупреждения:\n${summary.warnings.join('\n')}`) || '',
        summary.errors?.length ? `Ошибок: ${summary.errors.length} (первые 5 ниже).` : ''
      ].filter(Boolean);
      if (summary.errors?.length) {
        lines.push(
          ...summary.errors.slice(0, 5).map((err) => `Строка ${err.row}: ${err.message}`)
        );
      }
      alert(lines.join('\n\n'));
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Ошибка импорта';
      alert('Импорт Excel: ' + msg);
    } finally {
      setImportExcelLoading(false);
    }
  };

  return (
    <div>
      <PageTitle
        iconClass="pe-7s-box2"
        iconBgClass="bg-mean-fruit"
        title="Товары"
        subtitle="Просмотр, добавление и редактирование товаров в системе."
        actions={(
          <>
            <Button className="btn-shadow me-2" variant="primary" size="small" onClick={handleCreate}>
              + Добавить
            </Button>
            <Button
              className="btn-shadow"
              variant="secondary"
              size="small"
              onClick={handleRefreshSupplierStocks}
              disabled={isRefreshingStocks}
            >
              {isRefreshingStocks ? '⏳ Обновление...' : '🔄 Обновить остатки'}
            </Button>
            <input
              ref={importFileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="d-none"
              aria-hidden
              onChange={handleImportExcelFile}
            />
            <Button
              className="btn-shadow me-2"
              variant="secondary"
              size="small"
              onClick={openImportTemplateModal}
              disabled={importTemplateLoading || importExcelLoading || loading}
              title="Скачать пустой файл с колонками как в экспорте; можно выбрать категорию — в справочнике останется только она"
            >
              {importTemplateLoading ? '⏳ …' : '📄 Шаблон импорта'}
            </Button>
            <Button
              className="btn-shadow me-2"
              variant="secondary"
              size="small"
              onClick={handleImportExcelPick}
              disabled={importExcelLoading || loading}
              title="Загрузить .xlsx из системы: строки с колонкой ID обновят товары, без ID — новые (нужны артикул и название)"
            >
              {importExcelLoading ? '⏳ Импорт…' : '📤 Загрузить Excel'}
            </Button>
            <Button
              className="btn-shadow"
              variant="secondary"
              size="small"
              onClick={openExportModal}
              disabled={exportLoading || loading}
              title="Экспорт в Excel: по умолчанию все атрибуты; при необходимости можно исключить атрибуты маркетплейсов"
            >
              📥 Excel
            </Button>
          </>
        )}
      />

      <div className="main-card mb-3 card">
        <div className="card-header d-flex align-items-center justify-content-between flex-wrap gap-2">
          <div className="d-flex flex-column flex-sm-row flex-wrap align-items-sm-center gap-1 gap-sm-3">
            <span>Список товаров</span>
            <span className="text-muted small" aria-live="polite">
              Показано: <strong>{visibleProducts.length}</strong> из <strong>{totalProducts}</strong>
              {selectedProductIds.size > 0 ? (
                <>
                  {' · '}
                  Выбрано: <strong>{selectedProductIds.size}</strong>
                </>
              ) : null}
            </span>
          </div>
          <span className="text-muted small d-none d-md-inline">
            Экспорт в Excel — кнопка «📥 Excel» в шапке страницы
          </span>
        </div>

        <div className="card-body p-0">
          <div className="products-list-toolbar">
            <div className="d-flex flex-wrap align-items-end gap-2 gap-md-3">
              <div className="flex-grow-1" style={{ minWidth: 200, maxWidth: 480 }}>
                <label className="text-muted small mb-1 d-block" htmlFor="products-list-search">
                  Поиск по списку
                </label>
                <input
                  id="products-list-search"
                  type="search"
                  className="form-control form-control-sm products-list-search-input"
                  placeholder="Название, артикул, штрихкод…"
                  value={listSearch}
                  onChange={handleListSearchChange}
                  autoComplete="off"
                  aria-label="Поиск по названию, артикулу или штрихкоду"
                  aria-busy={listRefreshing}
                />
              </div>
              <div className="d-flex align-items-end gap-2 ms-md-auto flex-wrap">
                <span
                  className={`products-list-refresh-hint small ${listRefreshing ? 'is-visible' : ''}`}
                  aria-live="polite"
                >
                  Обновление списка…
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  className="btn-shadow"
                  onClick={() => setFiltersOpen((o) => !o)}
                  aria-expanded={filtersOpen}
                  title="Организация, категория, тип товара"
                >
                  {filtersOpen ? '▼ Фильтры' : '▶ Фильтры'}
                  {activeFiltersCount > 0 ? (
                    <span className="badge bg-primary ms-1 rounded-pill">{activeFiltersCount}</span>
                  ) : null}
                </Button>
              </div>
            </div>
            {filtersOpen ? (
              <div className="products-filters-panel">
                <div className="row g-2 g-md-3 align-items-end">
                  <div className="col-12 col-md-4">
                    <label className="text-muted small mb-1 d-block" htmlFor="products-filter-org">
                      Организация
                    </label>
                    <select
                      id="products-filter-org"
                      className="form-select form-select-sm"
                      value={filterOrganizationId}
                      onChange={handleFilterOrganizationChange}
                    >
                      <option value="">Все организации</option>
                      {organizations.map((org) => (
                        <option key={org.id} value={org.id}>
                          {org.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-12 col-md-4">
                    <label className="text-muted small mb-1 d-block" htmlFor="products-filter-cat">
                      Категория
                    </label>
                    <select
                      id="products-filter-cat"
                      className="form-select form-select-sm"
                      value={filterCategoryId}
                      onChange={handleFilterCategoryChange}
                    >
                      <option value="">Все категории</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-12 col-md-4">
                    <label className="text-muted small mb-1 d-block" htmlFor="products-filter-type">
                      Тип товара
                    </label>
                    <select
                      id="products-filter-type"
                      className="form-select form-select-sm"
                      value={filterProductType}
                      onChange={handleFilterProductTypeChange}
                    >
                      <option value="">Все типы</option>
                      <option value="product">Товар</option>
                      <option value="kit">Комплект</option>
                    </select>
                  </div>
                  <div className="col-12 col-md-6">
                    <label className="text-muted small mb-1 d-block" htmlFor="products-filter-warehouse">
                      Остаток по складу
                    </label>
                    <select
                      id="products-filter-warehouse"
                      className="form-select form-select-sm"
                      value={filterWarehouseId}
                      onChange={handleFilterWarehouseChange}
                    >
                      <option value="">Все склады (сумма)</option>
                      {ownWarehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.address || w.name || `Склад #${w.id}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {activeFiltersCount > 0 ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0 text-decoration-none"
                      onClick={clearListFilters}
                    >
                      Сбросить фильтры
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className={`products-list ${listRefreshing ? 'products-list--refreshing' : ''}`}>
            {!loading && visibleProducts.length === 0 ? (
              <div className="empty-state">
                <p>Товары не найдены</p>
                <Button onClick={handleCreate}>Добавить первый товар</Button>
              </div>
            ) : (
              <div className="products-table-container">
                <div className="d-flex justify-content-between align-items-center px-3 py-2 border-bottom flex-wrap gap-2">
                  <span className="text-muted small">
                    Страница <strong>{currentPage}</strong> из <strong>{totalPages}</strong>
                  </span>
                  <div className="d-flex gap-2">
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => goToPage(currentPage - 1)}
                      disabled={currentPage <= 1 || listRefreshing}
                    >
                      Назад
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => goToPage(currentPage + 1)}
                      disabled={currentPage >= totalPages || listRefreshing}
                    >
                      Вперёд
                    </Button>
                  </div>
                </div>
                <div className="table-responsive">
                  <table className="products-table align-middle mb-0 table table-borderless table-striped table-hover">
                    <thead>
                      <tr>
                        <th className="products-table-select-cell" scope="col">
                          <input
                            ref={selectAllCheckboxRef}
                            type="checkbox"
                            className="form-check-input"
                            checked={allVisibleSelected}
                            onChange={toggleSelectAllVisible}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Выбрать все товары в текущем списке"
                          />
                        </th>
                        <th className="product-thumb-cell">Фото</th>
                        <th>Тип</th>
                        <th>Название</th>
                        <th>Артикул</th>
                        <th>
                          Себестоимость / Остаток
                          <div className="text-muted fw-normal" style={{ fontSize: 10 }}>
                            {filterWarehouseId
                              ? ownWarehouses.find((w) => String(w.id) === filterWarehouseId)?.address ||
                                'выбранный склад'
                              : 'сумма по складам'}
                          </div>
                        </th>
                        <th>Маркетплейсы</th>
                        <th>Габариты</th>
                        <th className="text-end">Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleProducts.map((product) => {
                  const buyoutRate = product.buyout_rate || 100;
                  const buyoutRateColor = buyoutRate === 100 ? 'var(--muted)' : (buyoutRate >= 80 ? '#f59e0b' : '#ef4444');
                  
                  // Формируем информацию о габаритах
                  const packagingParts = [];
                  if (product.weight) {
                    const weight = typeof product.weight === 'number' ? product.weight : parseFloat(product.weight);
                    if (!isNaN(weight) && weight > 0) {
                      packagingParts.push(`${weight}г`);
                    }
                  }
                  // Безопасная обработка volume - может быть числом, строкой, null, undefined или объектом
                  if (product.volume != null && product.volume !== '') {
                    let volume = null;
                    try {
                      if (typeof product.volume === 'number' && isFinite(product.volume)) {
                        volume = product.volume;
                      } else if (typeof product.volume === 'string') {
                        const trimmed = product.volume.trim();
                        if (trimmed !== '' && trimmed !== 'null' && trimmed !== 'undefined') {
                          const parsed = parseFloat(trimmed);
                          if (!isNaN(parsed) && isFinite(parsed)) {
                            volume = parsed;
                          }
                        }
                      }
                      if (volume !== null && volume > 0) {
                        packagingParts.push(`${volume.toFixed(2)}л`);
                      }
                    } catch (e) {
                      // Игнорируем ошибки при обработке volume
                      console.warn('Error processing volume for product:', product.id, e);
                    }
                  }
                  if (product.length && product.width && product.height) {
                    const length = typeof product.length === 'number' ? product.length : parseFloat(product.length);
                    const width = typeof product.width === 'number' ? product.width : parseFloat(product.width);
                    const height = typeof product.height === 'number' ? product.height : parseFloat(product.height);
                    if (!isNaN(length) && !isNaN(width) && !isNaN(height)) {
                      packagingParts.push(`${length}×${width}×${height}мм`);
                    }
                  }
                  
                  const productTypeLabel = product.product_type === 'kit' ? 'Комплект' : 'Товар';
                  const addExpRaw = product.additionalExpenses ?? product.additional_expenses;
                  const addExpNum =
                    addExpRaw != null && addExpRaw !== '' && !isNaN(Number(addExpRaw)) ? Number(addExpRaw) : null;
                  const addExpTitle = addExpNum != null ? `${addExpNum.toFixed(2)}₽` : '—';
                  const thumbUrl = getPrimaryProductImageUrl(product);
                  const rowSelected = selectedProductIds.has(String(product.id));
                  return (
                    <tr
                      key={product.id}
                      className={`product-row-editable${rowSelected ? ' products-table-row--selected' : ''}`}
                      title="Открыть карточку товара"
                      onClick={() => handleEdit(product)}
                    >
                      <td
                        className="products-table-select-cell"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="form-check-input"
                          checked={rowSelected}
                          onChange={(e) => toggleProductSelected(product.id, e)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Выбрать товар ${product.sku || product.name || product.id}`}
                        />
                      </td>
                      <td className="product-thumb-cell">
                        <div className="product-thumb" title={thumbUrl ? 'Изображение товара' : 'Нет изображения'}>
                          {thumbUrl ? (
                            <img src={thumbUrl} alt="" loading="lazy" decoding="async" />
                          ) : (
                            <span className="product-thumb--empty" aria-hidden>
                              ◻
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${product.product_type === 'kit' ? 'bg-info' : 'bg-secondary'}`}>
                          {productTypeLabel}
                        </span>
                      </td>
                      <td>
                        <div className="product-name">{product.name || 'Без названия'}</div>
                        <div style={{fontSize: '11px', color: 'var(--muted)', marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center'}}>
                          {product.brand && (
                            <span>{product.brand}</span>
                          )}
                          {(() => {
                            // Ищем категорию по categoryId или user_category_id
                            const categoryId = product.user_category_id || product.categoryId;
                            if (categoryId) {
                              const category = categories.find(cat => 
                                String(cat.id) === String(categoryId)
                              );
                              if (category) {
                                return (
                                  <span style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                                    {product.brand && <span style={{color: 'var(--muted)'}}>•</span>}
                                    <span style={{fontWeight: 600}}>📦 {category.name}</span>
                                  </span>
                                );
                              }
                            }
                            return null;
                          })()}
                        </div>
                      </td>
                      <td>
                        <div className="product-sku">{product.sku || '—'}</div>
                      </td>
                      <td>
                        <div className="product-price" title={`Товар: ${product.name}\nСебестоимость: ${product.cost != null ? `${Number(product.cost).toFixed(2)}₽` : 'не указана'}\nДоп. расходы: ${addExpTitle}\nКоличество: ${product.quantity ?? 0}`}>
                          {product.cost != null && product.cost !== '' && !isNaN(Number(product.cost)) ? (
                            <span style={{color: '#10b981', fontWeight: 600}}>{Number(product.cost).toFixed(2)}₽</span>
                          ) : (
                            <span style={{color: 'var(--muted)'}}>—</span>
                          )}
                        </div>
                        <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px'}}>
                          {addExpNum != null ? (
                            <>доп. расходы: <span style={{ fontWeight: 600, color: '#64748b' }}>{addExpNum.toFixed(2)}₽</span></>
                          ) : (
                            <>доп. расходы: —</>
                          )}
                        </div>
                        <div style={{fontSize: '10px', color: '#f59e0b', marginTop: '2px'}}>
                          мин. чистая прибыль: {product.minPrice != null && product.minPrice !== '' && !isNaN(Number(product.minPrice)) ? Number(product.minPrice) : 50}₽
                        </div>
                        <div style={{fontSize: '10px', color: 'var(--muted)', marginTop: '2px'}}>
                          {product.quantity ?? 0}
                        </div>
                        <div style={{fontSize: '10px', color: buyoutRateColor, marginTop: '2px', fontWeight: 600}}>
                          📊 {buyoutRate === 100 ? '100%' : `${buyoutRate}%`} {buyoutRate !== 100 && <span style={{fontSize: '9px', color: 'var(--muted)'}}>(средний)</span>}
                        </div>
                      </td>
                      <td>
                        <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                          {product.sku_ozon && (
                            <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                              <span className="mp-badge ozon">OZ</span>
                              <span style={{fontSize: '11px'}}>{product.sku_ozon}</span>
                              {product.buyout_rate_ozon !== null && product.buyout_rate_ozon !== undefined && (
                                <span style={{
                                  fontSize: '10px', 
                                  color: product.buyout_rate_ozon === 100 ? 'var(--muted)' : (product.buyout_rate_ozon >= 80 ? '#f59e0b' : '#ef4444'),
                                  fontWeight: 600
                                }}>
                                  ({product.buyout_rate_ozon}%)
                                </span>
                              )}
                            </div>
                          )}
                          {product.sku_wb && (
                            <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                              <span className="mp-badge wb">WB</span>
                              <span style={{fontSize: '11px'}}>{product.sku_wb}</span>
                              {product.buyout_rate_wb !== null && product.buyout_rate_wb !== undefined && (
                                <span style={{
                                  fontSize: '10px', 
                                  color: product.buyout_rate_wb === 100 ? 'var(--muted)' : (product.buyout_rate_wb >= 80 ? '#f59e0b' : '#ef4444'),
                                  fontWeight: 600
                                }}>
                                  ({product.buyout_rate_wb}%)
                                </span>
                              )}
                            </div>
                          )}
                          {product.sku_ym && (
                            <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                              <span className="mp-badge ym">YM</span>
                              <span style={{fontSize: '11px'}}>{product.sku_ym}</span>
                              {product.buyout_rate_ym !== null && product.buyout_rate_ym !== undefined && (
                                <span style={{
                                  fontSize: '10px', 
                                  color: product.buyout_rate_ym === 100 ? 'var(--muted)' : (product.buyout_rate_ym >= 80 ? '#f59e0b' : '#ef4444'),
                                  fontWeight: 600
                                }}>
                                  ({product.buyout_rate_ym}%)
                                </span>
                              )}
                            </div>
                          )}
                          {!product.sku_ozon && !product.sku_wb && !product.sku_ym && (
                            <span style={{color: 'var(--muted)', fontSize: '11px'}}>—</span>
                          )}
                        </div>
                      </td>
                      <td>
                        {packagingParts.length > 0 ? (
                          <div style={{fontSize: '11px', lineHeight: '1.6'}}>
                            {packagingParts.map((part, idx) => (
                              <div key={idx}>{part}</div>
                            ))}
                          </div>
                        ) : (
                          <span style={{color: 'var(--muted)', fontSize: '11px'}}>—</span>
                        )}
                      </td>
                      <td className="product-actions-cell" onClick={(e) => e.stopPropagation()}>
                        <div className="product-actions">
                          <Button 
                            variant="secondary" 
                            size="small"
                            onClick={() => handleEdit(product)}
                            title="Редактировать"
                            className="btn-icon btn-icon-only"
                          >
                            ✏️
                          </Button>
                          <Button 
                            variant="danger" 
                            size="small"
                            onClick={() => handleDelete(product.id)}
                            title="Удалить"
                            className="btn-icon btn-icon-only"
                          >
                            🗑️
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <Modal
        isOpen={importTemplateModalOpen}
        onClose={() => setImportTemplateModalOpen(false)}
        title="Шаблон для импорта (Excel)"
        size="medium"
        closeOnBackdropClick
      >
        <p className="text-muted small mb-3">
          Пустой лист <strong>Товары</strong> (заголовки и скрытая строка ключей) и лист <strong>Словари</strong>, как при экспорте.
          Заполните строки с 3-й и загрузите файл через «Загрузить Excel».
        </p>
        <div className="mb-3">
          <label className="form-label small mb-1">Категория в справочнике</label>
          <select
            className="form-select form-select-sm"
            value={importTemplateCatId}
            onChange={(e) => setImportTemplateCatId(e.target.value)}
          >
            <option value="">Все категории (полный список на листе «Словари»)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-muted small mt-1 mb-0">
            Если выбрать одну категорию, в выпадающем списке колонки «Категория» будет только она — удобно для массового ввода в одной категории. Тип товара — колонка F на листе «Словари».
          </p>
        </div>
        <div className="mb-3 p-2 border rounded bg-light">
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              role="switch"
              id="tplExcludeMpAttrs"
              checked={importTemplateExcludeMpAttributes}
              onChange={(e) => setImportTemplateExcludeMpAttributes(e.target.checked)}
            />
            <label className="form-check-label" htmlFor="tplExcludeMpAttrs">
              Не выгружать атрибуты маркетплейсов
            </label>
          </div>
          <p className="text-muted small mb-0 mt-2">
            По умолчанию в шаблоне есть все атрибуты. Включите тумблер, чтобы оставить только атрибуты системы (ERP).
          </p>
        </div>
        <div className="d-flex gap-2 justify-content-end">
          <Button
            variant="secondary"
            size="small"
            onClick={() => setImportTemplateModalOpen(false)}
            disabled={importTemplateLoading}
          >
            Отмена
          </Button>
          <Button variant="primary" size="small" onClick={handleDownloadImportTemplate} disabled={importTemplateLoading}>
            {importTemplateLoading ? '⏳ Формирование…' : 'Скачать шаблон'}
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        title="Экспорт в Excel"
        size="medium"
        closeOnBackdropClick
      >
        <p className="text-muted small mb-3 mb-md-2">
          Файл: листы <strong>Товары</strong> и <strong>Словари</strong>.
        </p>
        <div className="mb-3">
          <label className="form-label small mb-1">Организация</label>
          <select
            className="form-select form-select-sm"
            value={exportOrgId}
            onChange={(e) => setExportOrgId(e.target.value)}
          >
            <option value="">Все организации</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label small mb-1">Категория товара</label>
          <select
            className="form-select form-select-sm"
            value={exportCatId}
            onChange={(e) => setExportCatId(e.target.value)}
          >
            <option value="">Все категории</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mb-3">
          <label className="form-label small mb-1">Поиск по названию / артикулу (необязательно)</label>
          <input
            type="text"
            className="form-control form-control-sm"
            value={exportSearch}
            onChange={(e) => setExportSearch(e.target.value)}
            placeholder="Часть названия или SKU"
          />
        </div>
        <div className="mb-3 p-2 border rounded bg-light">
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              role="switch"
              id="exportExcludeMpAttrs"
              checked={exportExcludeMpAttributes}
              onChange={(e) => setExportExcludeMpAttributes(e.target.checked)}
            />
            <label className="form-check-label" htmlFor="exportExcludeMpAttrs">
              Не выгружать атрибуты маркетплейсов
            </label>
          </div>
          <p className="text-muted small mb-0 mt-2">
            По умолчанию выгружаются все атрибуты. Включите тумблер, чтобы в файле остались только атрибуты системы (ERP),
            без колонок Ozon, Wildberries и Яндекс.Маркета.
          </p>
        </div>
        <div className="d-flex gap-2 justify-content-end">
          <Button variant="secondary" size="small" onClick={() => setExportModalOpen(false)} disabled={exportLoading}>
            Отмена
          </Button>
          <Button variant="primary" size="small" onClick={handleExportExcelFromModal} disabled={exportLoading}>
            {exportLoading ? '⏳ Формирование…' : 'Скачать .xlsx'}
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingProduct(null);
        }}
        title={editingProduct ? 'Редактировать товар' : 'Создать товар'}
        size="full"
        closeOnBackdropClick={false}
      >
        <ProductForm
          product={editingProduct}
          categories={categories}
          brands={brands}
          organizations={organizations}
          products={products}
          onSubmit={handleSubmit}
          onCancel={() => {
            setIsModalOpen(false);
            setEditingProduct(null);
          }}
          onProductUpdate={handleProductUpdate}
        />
      </Modal>
    </div>
  );
}

