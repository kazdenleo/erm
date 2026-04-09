/**
 * useWarehouses Hook
 * Custom hook для работы со складами
 */

import { useState, useEffect } from 'react';
import { warehousesApi } from '../services/warehouses.api';

export function useWarehouses() {
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadWarehouses();
  }, []);

  const loadWarehouses = async (organizationId) => {
    try {
      setLoading(true);
      setError(null);
      const response = await warehousesApi.getAll(
        organizationId != null && organizationId !== '' ? { organizationId } : {}
      );
      setWarehouses(response.data || []);
    } catch (err) {
      console.error('Error loading warehouses:', err);
      setError(err.message || 'Ошибка загрузки складов');
    } finally {
      setLoading(false);
    }
  };

  const createWarehouse = async (warehouseData) => {
    try {
      const response = await warehousesApi.create(warehouseData);
      setWarehouses(prev => [...prev, response.data]);
      return response.data;
    } catch (err) {
      console.error('Error creating warehouse:', err);
      throw err;
    }
  };

  const updateWarehouse = async (id, updates) => {
    try {
      console.log('[useWarehouses] updateWarehouse called with id:', id);
      console.log('[useWarehouses] updates:', updates);
      console.log('[useWarehouses] updates keys:', Object.keys(updates));
      console.log('[useWarehouses] updates.wbWarehouseName:', updates.wbWarehouseName);
      console.log('[useWarehouses] updates JSON:', JSON.stringify(updates, null, 2));
      const response = await warehousesApi.update(id, updates);
      setWarehouses(prev => prev.map(w => w.id === id ? response.data : w));
      return response.data;
    } catch (err) {
      console.error('Error updating warehouse:', err);
      throw err;
    }
  };

  const deleteWarehouse = async (id) => {
    try {
      await warehousesApi.delete(id);
      setWarehouses(prev => prev.filter(w => w.id !== id));
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
    deleteWarehouse
  };
}


