/**
 * Brands Repository
 * Репозиторий для работы с брендами
 */

import { storage } from '../utils/storage.js';

const STORAGE_KEY = 'brands';

export const brandsRepository = {
  async getAll() {
    const data = await storage.read(STORAGE_KEY);
    return Array.isArray(data) ? data : [];
  },

  async getById(id) {
    const brands = await this.getAll();
    return brands.find(brand => brand.id === id || brand.id === parseInt(id));
  },

  async create(brandData) {
    const brands = await this.getAll();
    const newBrand = {
      id: Date.now() + Math.random(),
      name: brandData.name,
      description: brandData.description || '',
      website: brandData.website || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    brands.push(newBrand);
    await storage.write(STORAGE_KEY, brands);
    return newBrand;
  },

  async update(id, updates) {
    const brands = await this.getAll();
    const index = brands.findIndex(brand => brand.id === id || brand.id === parseInt(id));
    if (index === -1) return null;
    
    brands[index] = {
      ...brands[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    await storage.write(STORAGE_KEY, brands);
    return brands[index];
  },

  async delete(id) {
    const brands = await this.getAll();
    const numericId = parseInt(id);
    const initialLength = brands.length;
    const filtered = brands.filter(brand => brand.id !== numericId);
    
    if (filtered.length === initialLength) return false;
    
    await storage.write(STORAGE_KEY, filtered);
    return true;
  }
};

