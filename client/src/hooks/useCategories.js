/**
 * useCategories Hook
 * Custom hook для работы с пользовательскими категориями
 */

import { useState, useEffect } from 'react';
import { userCategoriesApi } from '../services/userCategories.api';

export function useCategories() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadCategories();
  }, []);

  const loadCategories = async (opts = {}) => {
    const silent = opts.silent === true;
    try {
      if (!silent) setLoading(true);
      setError(null);
      const response = await userCategoriesApi.getAll();
      const list = response?.data ?? (Array.isArray(response) ? response : []);
      setCategories(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Error loading categories:', err);
      setError(err.message || 'Ошибка загрузки категорий');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const createCategory = async (categoryData) => {
    try {
      const response = await userCategoriesApi.create(categoryData);
      const created = response?.data ?? response;
      setCategories(prev => [...prev, created]);
      return created;
    } catch (err) {
      console.error('Error creating category:', err);
      throw err;
    }
  };

  const updateCategory = async (id, updates) => {
    try {
      const response = await userCategoriesApi.update(id, updates);
      const updated = response?.data ?? response;
      setCategories(prev => prev.map(cat => String(cat.id) === String(id) ? updated : cat));
      return updated;
    } catch (err) {
      console.error('Error updating category:', err);
      throw err;
    }
  };

  const deleteCategory = async (id) => {
    try {
      await userCategoriesApi.delete(id);
      setCategories(prev => prev.filter(cat => cat.id !== id && cat.parentId !== id));
    } catch (err) {
      console.error('Error deleting category:', err);
      throw err;
    }
  };

  return {
    categories,
    loading,
    error,
    loadCategories,
    createCategory,
    updateCategory,
    deleteCategory
  };
}

