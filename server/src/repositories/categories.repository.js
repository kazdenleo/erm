/**
 * Categories Repository
 * Репозиторий для работы с категориями
 */

import { storage } from '../utils/storage.js';

const STORAGE_KEY = 'categories';

export const categoriesRepository = {
  async getAll() {
    const data = await storage.read(STORAGE_KEY);
    return Array.isArray(data) ? data : [];
  },

  async getById(id) {
    const categories = await this.getAll();
    return categories.find(cat => cat.id === id || cat.id === parseInt(id));
  },

  async create(categoryData) {
    const categories = await this.getAll();
    const newCategory = {
      id: Date.now() + Math.random(),
      name: categoryData.name,
      description: categoryData.description || '',
      parentId: categoryData.parentId || null,
      productsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    categories.push(newCategory);
    await storage.write(STORAGE_KEY, categories);
    return newCategory;
  },

  async update(id, updates) {
    const categories = await this.getAll();
    const index = categories.findIndex(cat => cat.id === id || cat.id === parseInt(id));
    if (index === -1) return null;
    
    categories[index] = {
      ...categories[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    await storage.write(STORAGE_KEY, categories);
    return categories[index];
  },

  async delete(id) {
    const categories = await this.getAll();
    const numericId = parseInt(id);
    const initialLength = categories.length;
    
    // Удаляем категорию и все её подкатегории
    const filtered = categories.filter(cat => {
      if (cat.id === numericId) return false;
      if (cat.parentId === numericId) return false;
      return true;
    });
    
    if (filtered.length === initialLength) return false;
    
    await storage.write(STORAGE_KEY, filtered);
    return true;
  }
};

