/**
 * Suppliers Repository
 * Слой доступа к данным для поставщиков
 */

import { readData, writeData } from '../utils/storage.js';

class SuppliersRepository {
  async findAll() {
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData)
      ? suppliersData
      : (suppliersData.suppliers || []);
    return suppliers;
  }

  async findById(id) {
    const suppliers = await this.findAll();
    return suppliers.find(s => String(s.id) === String(id));
  }

  async findByName(name) {
    const suppliers = await this.findAll();
    const lowered = String(name || '').trim().toLowerCase();
    return suppliers.find(s => (s.name || '').toLowerCase() === lowered);
  }

  async create(data) {
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData)
      ? suppliersData
      : (suppliersData.suppliers || []);

    const newSupplier = {
      id: data.id || Date.now().toString(),
      name: String(data.name || '').trim(),
      apiConfig: data.apiConfig || {},
      isActive: data.isActive !== undefined ? !!data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    suppliers.push(newSupplier);

    const success = await writeData('suppliers', { suppliers });
    if (!success) {
      throw new Error('Не удалось сохранить поставщика');
    }

    return newSupplier;
  }

  async update(id, data) {
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData)
      ? suppliersData
      : (suppliersData.suppliers || []);

    const index = suppliers.findIndex(s => String(s.id) === String(id));
    if (index === -1) {
      return null;
    }

    suppliers[index] = {
      ...suppliers[index],
      name: data.name ? String(data.name).trim() : suppliers[index].name,
      apiConfig: data.apiConfig !== undefined ? data.apiConfig : suppliers[index].apiConfig,
      isActive: data.isActive !== undefined ? !!data.isActive : suppliers[index].isActive,
      updatedAt: new Date().toISOString()
    };

    const success = await writeData('suppliers', { suppliers });
    if (!success) {
      throw new Error('Не удалось обновить поставщика');
    }

    return suppliers[index];
  }

  async delete(id) {
    const suppliersData = await readData('suppliers');
    const suppliers = Array.isArray(suppliersData)
      ? suppliersData
      : (suppliersData.suppliers || []);

    const index = suppliers.findIndex(s => String(s.id) === String(id));
    if (index === -1) {
      return null;
    }

    const deleted = suppliers.splice(index, 1)[0];

    const success = await writeData('suppliers', { suppliers });
    if (!success) {
      throw new Error('Не удалось удалить поставщика');
    }

    return deleted;
  }
}

export default new SuppliersRepository();


