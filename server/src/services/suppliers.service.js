/**
 * Suppliers Service
 * Бизнес-логика для работы с поставщиками
 */

import repositoryFactory from '../config/repository-factory.js';

class SuppliersService {
  constructor() {
    this.repository = repositoryFactory.getSuppliersRepository();
  }

  async getAll() {
    return await this.repository.findAll();
  }

  async getById(id) {
    const supplier = await this.repository.findById(id);
    if (!supplier) {
      const error = new Error('Поставщик не найден');
      error.statusCode = 404;
      throw error;
    }
    return supplier;
  }

  async getByCode(code) {
    if (repositoryFactory.isUsingPostgreSQL()) {
      return await this.repository.findByCode(code);
    }
    // Для старого хранилища ищем по имени
    const suppliers = await this.repository.findAll();
    return suppliers.find(s => (s.code || s.name) === code);
  }

  async create(data) {
    const name = data?.name ? String(data.name).trim() : '';
    if (!name) {
      const error = new Error('Название поставщика обязательно');
      error.statusCode = 400;
      throw error;
    }

    // Проверка на дубликаты
    if (repositoryFactory.isUsingPostgreSQL()) {
      if (data.code) {
        const existing = await this.repository.findByCode(data.code);
        if (existing) {
          const error = new Error('Поставщик с таким кодом уже существует');
          error.statusCode = 400;
          throw error;
        }
      }
    } else {
      const existing = await this.repository.findByName(name);
      if (existing) {
        const error = new Error('Поставщик с таким названием уже существует');
        error.statusCode = 400;
        throw error;
      }
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      // Объединяем существующий apiConfig с новым, если есть
      const apiConfig = data.apiConfig || data.api_config || {};
      // Если переданы warehouses, добавляем их в apiConfig
      if (data.apiConfig?.warehouses) {
        apiConfig.warehouses = data.apiConfig.warehouses;
      }
      
      console.log('[SuppliersService] Creating supplier with apiConfig:', {
        name,
        warehousesCount: apiConfig.warehouses?.length || 0,
        apiConfigKeys: Object.keys(apiConfig)
      });
      
      return await this.repository.create({
        name,
        code: data.code || name.toLowerCase().replace(/\s+/g, '_'),
        api_config: apiConfig,
        is_active: data.isActive !== undefined ? data.isActive : true
      });
    } else {
      return await this.repository.create({
        name,
        apiConfig: data.apiConfig || {},
        isActive: data.isActive
      });
    }
  }

  async update(id, data) {
    const existing = await this.repository.findById(id);
    if (!existing) {
      const error = new Error('Поставщик не найден');
      error.statusCode = 404;
      throw error;
    }

    if (repositoryFactory.isUsingPostgreSQL()) {
      const updates = {};
      if (data.name) updates.name = data.name.trim();
      if (data.code) updates.code = data.code;
      if (data.apiConfig || data.api_config) {
        // Если переданы warehouses, обновляем их в apiConfig
        const newApiConfig = data.apiConfig || data.api_config;
        // Объединяем с существующим apiConfig, сохраняя другие настройки
        const existingApiConfig = existing.apiConfig || existing.api_config || {};
        
        // Создаем обновленный apiConfig, сохраняя все существующие поля
        const updatedApiConfig = {
          ...existingApiConfig,
          ...newApiConfig
        };
        
        // Если warehouses переданы явно, используем их (перезаписываем полностью)
        if (newApiConfig.warehouses !== undefined) {
          updatedApiConfig.warehouses = newApiConfig.warehouses;
        }
        
        updates.api_config = updatedApiConfig;
        console.log('[SuppliersService] Updating apiConfig:', {
          existingKeys: Object.keys(existingApiConfig),
          newKeys: Object.keys(newApiConfig),
          warehousesCount: updatedApiConfig.warehouses?.length || 0
        });
      }
      if (data.isActive !== undefined) updates.is_active = data.isActive;
      
      const updated = await this.repository.update(id, updates);
      if (!updated) {
        const error = new Error('Поставщик не найден');
        error.statusCode = 404;
        throw error;
      }
      return updated;
    } else {
      if (data.name && data.name.trim() !== existing.name) {
        const duplicate = await this.repository.findByName(data.name);
        if (duplicate && String(duplicate.id) !== String(id)) {
          const error = new Error('Поставщик с таким названием уже существует');
          error.statusCode = 400;
          throw error;
        }
      }

      const updated = await this.repository.update(id, data);
      if (!updated) {
        const error = new Error('Поставщик не найден');
        error.statusCode = 404;
        throw error;
      }
      return updated;
    }
  }

  async delete(id) {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      const error = new Error('Поставщик не найден');
      error.statusCode = 404;
      throw error;
    }
    return deleted;
  }
}

export default new SuppliersService();


