/**
 * Warehouses Service
 * Бизнес-логика для работы со складами
 */

import repositoryFactory from '../config/repository-factory.js';

class WarehousesService {
  constructor() {
    this.repository = repositoryFactory.getWarehousesRepository();
  }

  async getAll(options = {}) {
    const queryOptions = {};
    if (options.type) queryOptions.type = options.type;
    if (options.supplierId) queryOptions.supplierId = options.supplierId;
    if (options.mainWarehouseId) queryOptions.mainWarehouseId = options.mainWarehouseId;
    if (options.organizationId != null && options.organizationId !== '') queryOptions.organizationId = options.organizationId;
    
    return await this.repository.findAll(queryOptions);
  }

  async getById(id) {
    const warehouse = await this.repository.findById(id);
    if (!warehouse) {
      const error = new Error('Склад не найден');
      error.statusCode = 404;
      throw error;
    }
    return warehouse;
  }

  async create(data) {
    const type = data?.type ? String(data.type).trim() : '';
    if (!type) {
      const error = new Error('Тип склада обязателен');
      error.statusCode = 400;
      throw error;
    }
    
    // Обрабатываем mainWarehouseId: преобразуем пустую строку в null
    let mainWarehouseIdValue = null;
    if (type === 'supplier') {
      const mainWarehouseId = data.mainWarehouseId || data.main_warehouse_id;
      if (mainWarehouseId && mainWarehouseId.trim() !== '') {
        mainWarehouseIdValue = String(mainWarehouseId).trim();
      }
    }
    
    // Обрабатываем orderAcceptanceTime: только для складов поставщиков
    let orderAcceptanceTimeValue = null;
    if (type === 'supplier' && data.orderAcceptanceTime) {
      const time = String(data.orderAcceptanceTime).trim();
      if (time !== '' && /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
        orderAcceptanceTimeValue = time;
      }
    }
    
    // Обрабатываем wbWarehouseName: только для складов типа "warehouse"
    let wbWarehouseNameValue = null;
    if (type === 'warehouse' && data.wbWarehouseName) {
      const name = String(data.wbWarehouseName).trim();
      if (name !== '') {
        wbWarehouseNameValue = name;
      }
    }
    
    const rawOrgId = data.organizationId != null && data.organizationId !== '' ? data.organizationId : (data.organization_id != null && data.organization_id !== '' ? data.organization_id : null);
    const orgId = rawOrgId !== null ? (Number(rawOrgId) || rawOrgId) : null;
    const payload = repositoryFactory.isUsingPostgreSQL() ? {
      type,
      address: data.address && data.address.trim() !== '' ? data.address.trim() : null,
      supplier_id: data.supplierId && data.supplierId.trim() !== '' ? data.supplierId : (data.supplier_id || null),
      main_warehouse_id: mainWarehouseIdValue,
      order_acceptance_time: orderAcceptanceTimeValue,
      wb_warehouse_name: wbWarehouseNameValue,
      organization_id: orgId
    } : {
      ...data,
      type,
      mainWarehouseId: mainWarehouseIdValue,
      orderAcceptanceTime: orderAcceptanceTimeValue,
      wbWarehouseName: wbWarehouseNameValue
    };
    
    console.log('[WarehousesService] Create payload:', payload);
    
    return await this.repository.create(payload);
  }

  async update(id, data) {
    const existing = await this.repository.findById(id);
    if (!existing) {
      const error = new Error('Склад не найден');
      error.statusCode = 404;
      throw error;
    }

    const type = data.type !== undefined
      ? String(data.type).trim()
      : existing.type;

    if (!type) {
      const error = new Error('Тип склада обязателен');
      error.statusCode = 400;
      throw error;
    }

    // Обрабатываем mainWarehouseId: преобразуем пустую строку в null
    let mainWarehouseIdValue = null;
    if (type === 'supplier') {
      // Проверяем, было ли поле явно передано в запросе
      if (data.hasOwnProperty('mainWarehouseId') || data.hasOwnProperty('main_warehouse_id')) {
        const mainWarehouseId = data.mainWarehouseId ?? data.main_warehouse_id;
        // Если передано значение (даже пустая строка), обрабатываем его
        if (mainWarehouseId !== undefined && mainWarehouseId !== null) {
          const trimmed = String(mainWarehouseId).trim();
          mainWarehouseIdValue = trimmed !== '' ? trimmed : null;
        } else {
          mainWarehouseIdValue = null;
        }
      } else {
        // Если поле не передано, сохраняем существующее значение
        mainWarehouseIdValue = existing.main_warehouse_id;
      }
    }

    // Обрабатываем orderAcceptanceTime: только для складов поставщиков
    let orderAcceptanceTimeValue = null;
    if (type === 'supplier') {
      if (data.hasOwnProperty('orderAcceptanceTime') || data.hasOwnProperty('order_acceptance_time')) {
        const time = data.orderAcceptanceTime ?? data.order_acceptance_time;
        if (time !== undefined && time !== null) {
          const timeStr = String(time).trim();
          if (timeStr !== '' && /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(timeStr)) {
            orderAcceptanceTimeValue = timeStr;
          } else if (timeStr === '') {
            orderAcceptanceTimeValue = null;
          } else {
            orderAcceptanceTimeValue = existing.order_acceptance_time;
          }
        } else {
          orderAcceptanceTimeValue = null;
        }
      } else {
        orderAcceptanceTimeValue = existing.order_acceptance_time;
      }
    }

    // Обрабатываем wbWarehouseName: только для складов типа "warehouse"
    let wbWarehouseNameValue = null;
    console.log('[WarehousesService] ========== Processing wbWarehouseName ==========');
    console.log('[WarehousesService] type:', type);
    console.log('[WarehousesService] data:', JSON.stringify(data, null, 2));
    console.log('[WarehousesService] data.wbWarehouseName:', data.wbWarehouseName, 'type:', typeof data.wbWarehouseName);
    console.log('[WarehousesService] data.wb_warehouse_name:', data.wb_warehouse_name, 'type:', typeof data.wb_warehouse_name);
    console.log('[WarehousesService] existing.wb_warehouse_name:', existing.wb_warehouse_name);
    
    if (type === 'warehouse') {
      // Получаем значение из данных (проверяем оба варианта написания)
      // Упрощенная логика: сначала проверяем wbWarehouseName (camelCase), потом wb_warehouse_name (snake_case)
      const nameFromData = data.wbWarehouseName !== undefined ? data.wbWarehouseName : 
                          (data.wb_warehouse_name !== undefined ? data.wb_warehouse_name : undefined);
      
      console.log('[WarehousesService] nameFromData:', nameFromData, 'type:', typeof nameFromData);
      
      if (nameFromData !== undefined) {
        // Если значение явно передано
        if (nameFromData !== null && nameFromData !== '') {
          const nameStr = String(nameFromData).trim();
          wbWarehouseNameValue = nameStr !== '' ? nameStr : null;
          console.log('[WarehousesService] Processed nameStr:', nameStr, '-> wbWarehouseNameValue:', wbWarehouseNameValue);
        } else {
          // Если передано null или пустая строка, очищаем поле
          wbWarehouseNameValue = null;
          console.log('[WarehousesService] Name is empty/null, setting to null');
        }
      } else {
        // Если поле не передано, сохраняем существующее значение
        console.log('[WarehousesService] Field not in data, using existing value');
        wbWarehouseNameValue = existing.wb_warehouse_name || null;
        console.log('[WarehousesService] Using existing value:', wbWarehouseNameValue);
      }
    } else {
      // Если тип не "warehouse", очищаем поле
      wbWarehouseNameValue = null;
      console.log('[WarehousesService] Type is not warehouse, setting to null');
    }
    
    console.log('[WarehousesService] Final wbWarehouseNameValue:', wbWarehouseNameValue);
    console.log('[WarehousesService] ================================================');
    
    // Всегда передаем wb_warehouse_name в payload для складов типа warehouse
    // Это нужно для того, чтобы поле обновлялось в БД
    const payload = repositoryFactory.isUsingPostgreSQL() ? {
      type,
      address: data.address !== undefined ? (data.address && data.address.trim() !== '' ? data.address.trim() : null) : existing.address,
      supplier_id: data.supplierId !== undefined ? (data.supplierId && data.supplierId.trim() !== '' ? data.supplierId : null) : (data.supplier_id !== undefined ? data.supplier_id : existing.supplier_id),
      main_warehouse_id: mainWarehouseIdValue,
      order_acceptance_time: orderAcceptanceTimeValue
    } : {
      ...data,
      type,
      mainWarehouseId: mainWarehouseIdValue,
      orderAcceptanceTime: orderAcceptanceTimeValue
    };
    
    // Организация: всегда передаём в payload (из запроса или текущее значение), чтобы поле сохранялось
    if (data.hasOwnProperty('organizationId') || data.hasOwnProperty('organization_id')) {
      const oid = data.organizationId != null ? data.organizationId : data.organization_id;
      payload.organization_id = (oid !== '' && oid != null) ? (Number(oid) || oid) : null;
    } else if (repositoryFactory.isUsingPostgreSQL()) {
      payload.organization_id = existing.organization_id ?? existing.organizationId ?? null;
    }
    
    // Всегда добавляем wb_warehouse_name для складов типа warehouse
    console.log('[WarehousesService] Before adding to payload - type:', type, 'wbWarehouseNameValue:', wbWarehouseNameValue);
    if (type === 'warehouse') {
      payload.wb_warehouse_name = wbWarehouseNameValue;
      console.log('[WarehousesService] Added wb_warehouse_name to payload for warehouse type:', wbWarehouseNameValue);
      console.log('[WarehousesService] payload.wb_warehouse_name after assignment:', payload.wb_warehouse_name);
    } else if (repositoryFactory.isUsingPostgreSQL()) {
      // Для других типов складов очищаем поле
      payload.wb_warehouse_name = null;
      console.log('[WarehousesService] Type is not warehouse, cleared wb_warehouse_name');
    }

    console.log('[WarehousesService] Update payload:', JSON.stringify(payload, null, 2));
    console.log('[WarehousesService] payload.wb_warehouse_name in final payload:', payload.wb_warehouse_name);
    console.log('[WarehousesService] wbWarehouseNameValue:', wbWarehouseNameValue);
    console.log('[WarehousesService] wbWarehouseNameValue type:', typeof wbWarehouseNameValue);
    console.log('[WarehousesService] type:', type);
    console.log('[WarehousesService] data.wbWarehouseName:', data.wbWarehouseName);
    console.log('[WarehousesService] data.hasOwnProperty("wbWarehouseName"):', data.hasOwnProperty('wbWarehouseName'));
    console.log('[WarehousesService] existing.type:', existing.type);
    console.log('[WarehousesService] existing.wb_warehouse_name:', existing.wb_warehouse_name);

    const updated = await this.repository.update(id, payload);
    if (!updated) {
      const error = new Error('Склад не найден');
      error.statusCode = 404;
      throw error;
    }
    console.log('[WarehousesService] Updated warehouse returned:', JSON.stringify(updated, null, 2));
    console.log('[WarehousesService] Updated warehouse wbWarehouseName:', updated.wbWarehouseName);
    return updated;
  }

  async delete(id) {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      const error = new Error('Склад не найден');
      error.statusCode = 404;
      throw error;
    }
    return deleted;
  }
}

export default new WarehousesService();


