/**
 * Warehouse Validator
 * Валидация данных складов с использованием Zod
 */

import { z } from 'zod';

/**
 * Базовая схема валидации для склада (без transform)
 */
const baseWarehouseSchema = z.object({
  type: z.enum(['main', 'supplier', 'marketplace', 'warehouse']),
  address: z.string().min(1, 'Адрес обязателен').max(500).optional().nullable(),
  organizationId: z.union([z.string(), z.number()]).optional().nullable(),
  supplierId: z.string().optional().nullable(),
  mainWarehouseId: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  orderAcceptanceTime: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Неверный формат времени (HH:MM)').optional().nullable(),
  wbWarehouseName: z.string().optional().nullable(),
});

/**
 * Схема валидации для создания склада
 */
export const createWarehouseSchema = baseWarehouseSchema.transform((data) => {
  const orgIdVal = data.organizationId == null || data.organizationId === '' || (typeof data.organizationId === 'string' && data.organizationId.trim() === '')
    ? null
    : (typeof data.organizationId === 'string' ? data.organizationId.trim() : data.organizationId);
  return {
    ...data,
    organizationId: orgIdVal,
    supplierId: data.supplierId && data.supplierId.trim() !== '' ? data.supplierId : null,
    mainWarehouseId: data.mainWarehouseId && data.mainWarehouseId.trim() !== '' ? data.mainWarehouseId : null,
    address: data.address && data.address.trim() !== '' ? data.address.trim() : null,
    orderAcceptanceTime: data.orderAcceptanceTime && data.orderAcceptanceTime.trim() !== '' ? data.orderAcceptanceTime.trim() : null,
    wbWarehouseName: data.wbWarehouseName && data.wbWarehouseName.trim() !== '' ? data.wbWarehouseName.trim() : null,
  };
});

/**
 * Схема валидации для обновления склада
 */
export const updateWarehouseSchema = baseWarehouseSchema.partial().transform((data) => {
  const orgIdVal = data.organizationId == null || data.organizationId === '' || (typeof data.organizationId === 'string' && data.organizationId.trim() === '')
    ? null
    : (typeof data.organizationId === 'string' ? data.organizationId.trim() : data.organizationId);
  const out = {
    ...data,
    supplierId: data.supplierId && data.supplierId.trim() !== '' ? data.supplierId : null,
    mainWarehouseId: data.mainWarehouseId && data.mainWarehouseId.trim() !== '' ? data.mainWarehouseId : null,
    address: data.address && data.address.trim() !== '' ? data.address.trim() : null,
    orderAcceptanceTime: data.orderAcceptanceTime && data.orderAcceptanceTime.trim() !== '' ? data.orderAcceptanceTime.trim() : null,
    wbWarehouseName: data.wbWarehouseName && data.wbWarehouseName.trim() !== '' ? data.wbWarehouseName.trim() : null,
  };
  if (data.hasOwnProperty('organizationId')) out.organizationId = orgIdVal;
  return out;
});

/**
 * Схема валидации ID склада
 */
export const warehouseIdSchema = z.object({
  id: z.string().min(1, 'ID склада обязательно'),
});

/**
 * Middleware для валидации создания склада
 */
export function validateCreateWarehouse(req, res, next) {
  try {
    req.body = createWarehouseSchema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        details: error.errors,
      });
    }
    next(error);
  }
}

/**
 * Middleware для валидации обновления склада
 */
export function validateUpdateWarehouse(req, res, next) {
  try {
    req.body = updateWarehouseSchema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        details: error.errors,
      });
    }
    next(error);
  }
}

/**
 * Middleware для валидации ID склада
 */
export function validateWarehouseId(req, res, next) {
  try {
    warehouseIdSchema.parse({ id: req.params.id });
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid warehouse ID',
        details: error.errors,
      });
    }
    next(error);
  }
}

