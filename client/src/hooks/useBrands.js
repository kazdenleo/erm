/**
 * useBrands Hook
 * Custom hook для работы с брендами
 */

import { useState, useEffect } from 'react';
import { brandsApi } from '../services/brands.api';

export function useBrands() {
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadBrands();
  }, []);

  const loadBrands = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await brandsApi.getAll();
      setBrands(response.data || []);
    } catch (err) {
      console.error('Error loading brands:', err);
      setError(err.message || 'Ошибка загрузки брендов');
    } finally {
      setLoading(false);
    }
  };

  const createBrand = async (brandData) => {
    try {
      const response = await brandsApi.create(brandData);
      setBrands(prev => [...prev, response.data]);
      return response.data;
    } catch (err) {
      console.error('Error creating brand:', err);
      throw err;
    }
  };

  const updateBrand = async (id, updates) => {
    try {
      const response = await brandsApi.update(id, updates);
      setBrands(prev => prev.map(brand => brand.id === id ? response.data : brand));
      return response.data;
    } catch (err) {
      console.error('Error updating brand:', err);
      throw err;
    }
  };

  const deleteBrand = async (id) => {
    try {
      await brandsApi.delete(id);
      setBrands(prev => prev.filter(brand => brand.id !== id));
    } catch (err) {
      console.error('Error deleting brand:', err);
      throw err;
    }
  };

  return {
    brands,
    loading,
    error,
    loadBrands,
    createBrand,
    updateBrand,
    deleteBrand
  };
}

