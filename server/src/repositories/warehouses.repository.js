/**
 * Warehouses Repository
 * Слой доступа к данным для складов
 */

import { readData, writeData } from '../utils/storage.js';

class WarehousesRepository {
  async findAll() {
    const warehousesData = await readData('warehouses');
    const warehouses = Array.isArray(warehousesData)
      ? warehousesData
      : (warehousesData.warehouses || []);
    return warehouses;
  }

  async findById(id) {
    const warehouses = await this.findAll();
    return warehouses.find(w => String(w.id) === String(id));
  }

  async create(data) {
    const warehouses = await this.findAll();
    const orgId = data.organizationId != null && data.organizationId !== '' ? data.organizationId : (data.organization_id != null && data.organization_id !== '' ? data.organization_id : null);
    const newWarehouse = {
      id: data.id || Date.now().toString(),
      type: String(data.type || '').trim(),
      address: data.address ? String(data.address).trim() : '',
      organizationId: orgId,
      supplierId: data.supplierId || null,
      mainWarehouseId: data.mainWarehouseId || null,
      wbWarehouseName: data.wbWarehouseName || null,
      orderAcceptanceTime: data.orderAcceptanceTime || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    warehouses.push(newWarehouse);
    const success = await writeData('warehouses', warehouses);
    if (!success) {
      throw new Error('Не удалось сохранить склад');
    }
    return newWarehouse;
  }

  async update(id, data) {
    const warehouses = await this.findAll();
    const index = warehouses.findIndex(w => String(w.id) === String(id));
    if (index === -1) {
      return null;
    }

    const existing = warehouses[index];
    const type = data.type !== undefined ? String(data.type).trim() : existing.type;
    const orgId = (data.hasOwnProperty('organizationId') || data.hasOwnProperty('organization_id'))
      ? (data.organizationId != null && data.organizationId !== '' ? data.organizationId : (data.organization_id != null && data.organization_id !== '' ? data.organization_id : null))
      : (existing.organizationId ?? existing.organization_id ?? null);

    warehouses[index] = {
      ...existing,
      ...data,
      type,
      id: existing.id,
      organizationId: orgId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };

    const success = await writeData('warehouses', warehouses);
    if (!success) {
      throw new Error('Не удалось обновить склад');
    }
    return warehouses[index];
  }

  async delete(id) {
    const warehouses = await this.findAll();
    const index = warehouses.findIndex(w => String(w.id) === String(id));
    if (index === -1) {
      return null;
    }
    const deleted = warehouses.splice(index, 1)[0];
    const success = await writeData('warehouses', warehouses);
    if (!success) {
      throw new Error('Не удалось удалить склад');
    }
    return deleted;
  }
}

export default new WarehousesRepository();


