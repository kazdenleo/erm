/**
 * useWarehouses Hook
 * Custom hook для работы со складами
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { warehousesApi } from '../services/warehouses.api';
import {
  clearWarehousesCache,
  fetchWarehousesShared,
  warehouseCacheKey,
} from './warehousesSharedCache.js';

export function useWarehouses() {
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const activeKeyRef = useRef('_all');
  const fetchSeqRef = useRef(0);

  const loadWarehouses = useCallback(async (organizationId, options = {}) => {
    const key = warehouseCacheKey(organizationId);
    activeKeyRef.current = key;
    const seq = ++fetchSeqRef.current;
    try {
      setLoading(true);
      setError(null);
      const list = await fetchWarehousesShared(key, options);
      if (seq !== fetchSeqRef.current) return list;
      setWarehouses(list);
      return list;
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      const status = err?.response?.status ?? err?.status;
      if (status !== 429) {
        console.error('Error loading warehouses:', err);
      }
      setError(
        err.response?.data?.message ||
          err.message ||
          'Ошибка загрузки складов'
      );
      setWarehouses([]);
      throw err;
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadWarehouses().catch(() => {});
  }, [loadWarehouses]);

  const createWarehouse = async (warehouseData) => {
    try {
      const response = await warehousesApi.create(warehouseData);
      const created = response?.data ?? response;
      clearWarehousesCache();
      setWarehouses((prev) => [...prev, created]);
      return created;
    } catch (err) {
      console.error('Error creating warehouse:', err);
      throw err;
    }
  };

  const updateWarehouse = async (id, updates) => {
    try {
      const response = await warehousesApi.update(id, updates);
      const updated = response?.data ?? response;
      clearWarehousesCache();
      setWarehouses((prev) => prev.map((w) => (w.id === id ? updated : w)));
      return updated;
    } catch (err) {
      console.error('Error updating warehouse:', err);
      throw err;
    }
  };

  const deleteWarehouse = async (id) => {
    try {
      await warehousesApi.delete(id);
      clearWarehousesCache();
      setWarehouses((prev) => prev.filter((w) => w.id !== id));
    } catch (err) {
      console.error('Error deleting warehouse:', err);
      throw err;
    }
  };

  return {
    warehouses,
    loading,
    error,
    loadWarehouses,
    createWarehouse,
    updateWarehouse,
    deleteWarehouse,
  };
}

