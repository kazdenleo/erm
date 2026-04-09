/**
 * useSuppliers Hook
 * Custom hook для работы с поставщиками
 */

import { useState, useEffect } from 'react';
import { suppliersApi } from '../services/suppliers.api';

export function useSuppliers() {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadSuppliers();
  }, []);

  const loadSuppliers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await suppliersApi.getAll();
      console.log('[useSuppliers] API response:', response);
      // suppliersApi.getAll() возвращает response.data из axios, который является { ok: true, data: [...] }
      // Поэтому нужно использовать response.data для получения массива поставщиков
      const suppliersData = (response && response.ok && response.data) ? response.data : (Array.isArray(response) ? response : []);
      console.log('[useSuppliers] Suppliers data:', suppliersData);
      console.log('[useSuppliers] Suppliers count:', suppliersData.length);
      setSuppliers(Array.isArray(suppliersData) ? suppliersData : []);
    } catch (err) {
      console.error('Error loading suppliers:', err);
      setError(err.message || 'Ошибка загрузки поставщиков');
    } finally {
      setLoading(false);
    }
  };

  const createSupplier = async (supplierData) => {
    try {
      const response = await suppliersApi.create(supplierData);
      setSuppliers(prev => [...prev, response.data]);
      return response.data;
    } catch (err) {
      console.error('Error creating supplier:', err);
      throw err;
    }
  };

  const updateSupplier = async (id, updates) => {
    try {
      const response = await suppliersApi.update(id, updates);
      setSuppliers(prev => prev.map(s => s.id === id ? response.data : s));
      return response.data;
    } catch (err) {
      console.error('Error updating supplier:', err);
      throw err;
    }
  };

  const deleteSupplier = async (id) => {
    try {
      await suppliersApi.delete(id);
      setSuppliers(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      console.error('Error deleting supplier:', err);
      throw err;
    }
  };

  return {
    suppliers,
    loading,
    error,
    loadSuppliers,
    createSupplier,
    updateSupplier,
    deleteSupplier
  };
}


