/**
 * useProducts Hook
 * Custom hook для работы с товарами
 */

import { useState, useEffect, useRef } from 'react';
import { productsApi } from '../services/products.api';

export function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  /** Фоновое обновление списка (поиск, фильтры) — без полноэкранной «Загрузка…» */
  const [listRefreshing, setListRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async (options = {}) => {
    const opts = typeof options === 'object' && options !== null ? options : { organizationId: options };
    const silent = opts.silent === true;
    const gen = ++loadGenerationRef.current;
    try {
      if (!silent) {
        setLoading(true);
      } else {
        setListRefreshing(true);
      }
      if (!silent) {
        setError(null);
      }
      const params = { cacheBust: true };
      if (opts.organizationId != null && opts.organizationId !== '') params.organizationId = opts.organizationId;
      if (opts.categoryId != null && opts.categoryId !== '') params.categoryId = opts.categoryId;
      if (opts.search != null && String(opts.search).trim() !== '') params.search = String(opts.search).trim();
      if (opts.productType != null && String(opts.productType).trim() !== '') {
        params.productType = String(opts.productType).trim();
      }
      if (opts.warehouseId != null && opts.warehouseId !== '') {
        params.warehouseId = String(opts.warehouseId);
      }
      const response = await productsApi.getAll(params);
      const list = Array.isArray(response?.data) ? response.data : (response?.data?.data ?? response ?? []);
      const productsList = Array.isArray(list) ? list.filter(Boolean) : [];
      console.log(`[useProducts] Loaded ${productsList.length} products`);
      if (productsList.length > 0) {
        const first = productsList[0];
        console.log('[useProducts] First product stored prices:', {
          id: first.id,
          storedMinPriceOzon: first.storedMinPriceOzon,
          storedMinPriceWb: first.storedMinPriceWb,
          storedMinPriceYm: first.storedMinPriceYm
        });
      }
      setProducts(productsList);
    } catch (err) {
      console.error('Error loading products:', err);
      if (!silent) {
        setError(err.message || 'Ошибка загрузки товаров');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
      if (silent && gen === loadGenerationRef.current) {
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
      setProducts(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      console.error('Error deleting product:', err);
      throw err;
    }
  };

  return {
    products,
    loading,
    listRefreshing,
    error,
    loadProducts,
    createProduct,
    updateProduct,
    deleteProduct
  };
}

