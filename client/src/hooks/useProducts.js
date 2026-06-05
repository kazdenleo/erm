/**
 * useProducts Hook
 * Custom hook для работы с товарами
 */

import { useState, useEffect, useRef } from 'react';
import { productsApi } from '../services/products.api';

export function useProducts(options = {}) {
  const autoLoad = options.autoLoad !== false;
  const [products, setProducts] = useState([]);
  const [meta, setMeta] = useState({ total: null, limit: null, offset: 0 });
  const [loading, setLoading] = useState(true);
  /** Фоновое обновление списка (поиск, фильтры) — без полноэкранной «Загрузка…» */
  const [listRefreshing, setListRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef(null);

  useEffect(() => {
    if (autoLoad) {
      loadProducts();
    } else {
      setLoading(false);
    }
  }, [autoLoad]);

  const loadProducts = async (options = {}) => {
    const opts = typeof options === 'object' && options !== null ? options : { organizationId: options };
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const gen = ++loadGenerationRef.current;
    const silent = opts.silent === true;
    try {
      if (!silent) {
        setLoading(true);
      } else {
        setListRefreshing(true);
        // Смена фильтра (склад и т.д.) — не блокируем страницу из‑за зависшего loading от отменённого запроса.
        setLoading(false);
      }
      setError(null);
      const params = { cacheBust: true };
      if (opts.organizationId != null && opts.organizationId !== '') params.organizationId = opts.organizationId;
      if (opts.brandId != null && opts.brandId !== '') params.brandId = String(opts.brandId);
      if (opts.categoryId != null && opts.categoryId !== '') params.categoryId = opts.categoryId;
      if (opts.search != null && String(opts.search).trim() !== '') params.search = String(opts.search).trim();
      if (opts.productType != null && String(opts.productType).trim() !== '') {
        params.productType = String(opts.productType).trim();
      }
      if (opts.warehouseId != null && opts.warehouseId !== '') {
        params.warehouseId = String(opts.warehouseId);
      }
      if (opts.limit != null && opts.limit !== '') {
        params.limit = Number(opts.limit);
      }
      if (opts.page != null && opts.page !== '') {
        params.page = Number(opts.page);
      }
      if (opts.offset != null && opts.offset !== '') {
        params.offset = Number(opts.offset);
      }
      if (opts.includeArchived === true) params.includeArchived = true;
      if (opts.archivedOnly === true) params.archivedOnly = true;
      if (opts.stockList === true) {
        params.stockList = true;
        params.listView = 'stock';
      }
      if (opts.inStockOnly === true || opts.inStockOnly === '1' || opts.inStockOnly === 1) {
        params.inStockOnly = '1';
      }
      if (opts.reservedOnly === true || opts.reservedOnly === '1' || opts.reservedOnly === 1) {
        params.reservedOnly = '1';
      }
      if (opts.availableOnly === true || opts.availableOnly === '1' || opts.availableOnly === 1) {
        params.availableOnly = '1';
      }
      const response = await productsApi.getAll(params, { signal: controller.signal });
      if (gen !== loadGenerationRef.current || controller.signal.aborted) return;
      const list = Array.isArray(response?.data) ? response.data : (response?.data?.data ?? response ?? []);
      const productsList = Array.isArray(list) ? list.filter(Boolean) : [];
      setProducts(productsList);
      setMeta({
        total: response?.meta?.total ?? null,
        limit: response?.meta?.limit ?? params.limit ?? null,
        offset: response?.meta?.offset ?? params.offset ?? 0,
        supplierBreakdown: Array.isArray(response?.supplierBreakdown) ? response.supplierBreakdown : null,
      });
    } catch (err) {
      if (gen !== loadGenerationRef.current || controller.signal.aborted) return;
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
      console.error('Error loading products:', err);
      const msg = err.response?.data?.message || err.message || 'Ошибка загрузки товаров';
      setError(msg);
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
      }
      // Только актуальный запрос сбрасывает индикаторы (отменённый не оставляет loading=true).
      if (gen !== loadGenerationRef.current) return;
      if (!silent) {
        setLoading(false);
      } else {
        setListRefreshing(false);
      }
    }
  };

  const createProduct = async (productData) => {
    try {
      const response = await productsApi.create(productData);
      const created = response?.data ?? response;
      if (created) setProducts(prev => [...prev.filter(Boolean), created]);
      return created;
    } catch (err) {
      console.error('Error creating product:', err);
      throw err;
    }
  };

  const updateProduct = async (id, updates) => {
    try {
      const response = await productsApi.update(id, updates);
      const updated = (response && response.data !== undefined) ? response.data : response;
      const idStr = String(id);
      setProducts(prev => prev.filter(Boolean).map(p => (p && String(p.id) === idStr) ? (updated || p) : p));
      return updated;
    } catch (err) {
      console.error('Error updating product:', err);
      throw err;
    }
  };

  const deleteProduct = async (id) => {
    try {
      await productsApi.delete(id);
      setProducts(prev => prev.filter(p => String(p.id) !== String(id)));
    } catch (err) {
      console.error('Error deleting product:', err);
      throw err;
    }
  };

  const archiveProduct = async (id) => {
    try {
      const response = await productsApi.archive(id);
      const updated = response?.data ?? response;
      const idStr = String(id);
      setProducts((prev) =>
        prev.filter(Boolean).map((p) => (p && String(p.id) === idStr ? { ...p, ...updated, isArchived: true } : p))
      );
      return updated;
    } catch (err) {
      console.error('Error archiving product:', err);
      throw err;
    }
  };

  const unarchiveProduct = async (id) => {
    try {
      const response = await productsApi.unarchive(id);
      const updated = response?.data ?? response;
      const idStr = String(id);
      setProducts((prev) =>
        prev.filter(Boolean).map((p) =>
          p && String(p.id) === idStr ? { ...p, ...updated, isArchived: false } : p
        )
      );
      return updated;
    } catch (err) {
      console.error('Error unarchiving product:', err);
      throw err;
    }
  };

  return {
    products,
    meta,
    loading,
    listRefreshing,
    error,
    loadProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    archiveProduct,
    unarchiveProduct,
  };
}

