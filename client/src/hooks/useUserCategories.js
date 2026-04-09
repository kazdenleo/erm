/**
 * useUserCategories Hook
 * Custom hook для работы с пользовательскими категориями
 */

import { useState, useEffect } from 'react';
import { userCategoriesApi } from '../services/userCategories.api';
import { categoryMappingsApi } from '../services/categoryMappings.api';

export function useUserCategories() {
  const [categories, setCategories] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const categoriesResponse = await userCategoriesApi.getAll();
      const categoriesData = categoriesResponse.data?.data || categoriesResponse.data || [];
      setCategories(Array.isArray(categoriesData) ? categoriesData : []);
    } catch (err) {
      console.error('Error loading user categories:', err);
      setError(err.message || 'Ошибка загрузки категорий');
      setCategories([]);
    } finally {
      setLoading(false);
    }
    try {
      const mappingsResponse = await categoryMappingsApi.getAll();
      const mappingsData = mappingsResponse.data?.data || mappingsResponse.data || [];
      setMappings(Array.isArray(mappingsData) ? mappingsData : []);
    } catch (err) {
      console.error('Error loading category mappings:', err);
      setMappings([]);
    }
  };

  const createCategory = async (categoryData) => {
    try {
      const response = await userCategoriesApi.create(categoryData);
      setCategories(prev => [...prev, response.data]);
      return response.data;
    } catch (err) {
      console.error('Error creating category:', err);
      throw err;
    }
  };

  const updateCategory = async (id, updates) => {
    try {
      const response = await userCategoriesApi.update(id, updates);
      setCategories(prev => prev.map(cat => cat.id === id ? response.data : cat));
      return response.data;
    } catch (err) {
      console.error('Error updating category:', err);
      throw err;
    }
  };

  const deleteCategory = async (id) => {
    try {
      await userCategoriesApi.delete(id);
      setCategories(prev => prev.filter(cat => cat.id !== id && cat.parent_id !== id));
    } catch (err) {
      console.error('Error deleting category:', err);
      throw err;
    }
  };

  const createMapping = async (mappingData) => {
    try {
      const response = await categoryMappingsApi.create(mappingData);
      setMappings(prev => [...prev, response.data]);
      return response.data;
    } catch (err) {
      console.error('Error creating mapping:', err);
      throw err;
    }
  };

  const deleteMapping = async (id) => {
    try {
      await categoryMappingsApi.delete(id);
      setMappings(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      console.error('Error deleting mapping:', err);
      throw err;
    }
  };

  return {
    categories,
    mappings,
    loading,
    error,
    loadData,
    createCategory,
    updateCategory,
    deleteCategory,
    createMapping,
    deleteMapping
  };
}

