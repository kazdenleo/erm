/**
 * Supplier Validator
 * Валидация данных поставщиков с использованием Zod
 */

import { z } from 'zod';

const warehouseTimeSchema = z
  .string()
  .regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'Неверный формат времени (HH:MM)');

/**
 * Схема валидации для создания поставщика
 */
export const createSupplierSchema = z.object({
  name: z.string().min(1, 'Название поставщика обязательно').max(200),
  isActive: z.boolean().optional().default(true),
  type: z.enum(['mikado', 'moskvorechie', 'other']).optional(),
  settings: z.record(z.any()).optional(),
  apiConfig: z.object({
    warehouses: z.array(z.object({
      name: z.string().min(1, 'Название склада обязательно'),
      time: warehouseTimeSchema,
      timeAfter: warehouseTimeSchema.optional().or(z.literal('')),
      time_after: warehouseTimeSchema.optional().or(z.literal('')),
      arrivalDay: z.enum(['today', 'tomorrow']).optional(),
      arrival_day: z.enum(['today', 'tomorrow']).optional(),
    }).transform((w) => {
      const timeAfter = String(w.timeAfter ?? w.time_after ?? '').trim();
      const row = {
        name: w.name,
        time: w.time,
        arrivalDay: w.arrivalDay ?? w.arrival_day ?? 'today',
      };
      if (timeAfter) row.timeAfter = timeAfter;
      return row;
    })).optional(),
    minOrderAmount: z.coerce.number().min(0, 'Минимальная сумма не может быть отрицательной').optional().nullable(),
    isPriority: z.boolean().optional(),
    autoOrdersEnabled: z.boolean().optional(),
  }).passthrough().optional(), // passthrough() позволяет дополнительные поля в apiConfig
  api_config: z.any().optional(), // Также поддерживаем snake_case вариант
});

/**
 * Схема валидации для обновления поставщика
 */
export const updateSupplierSchema = createSupplierSchema.partial();

/**
 * Схема валидации ID поставщика
 */
export const supplierIdSchema = z.object({
  id: z.string().min(1, 'ID поставщика обязательно'),
});

/**
 * Middleware для валидации создания поставщика
 */
export function validateCreateSupplier(req, res, next) {
  try {
    req.body = createSupplierSchema.parse(req.body);
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
 * Middleware для валидации обновления поставщика
 */
export function validateUpdateSupplier(req, res, next) {
  try {
    req.body = updateSupplierSchema.parse(req.body);
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
 * Middleware для валидации ID поставщика
 */
export function validateSupplierId(req, res, next) {
  try {
    supplierIdSchema.parse({ id: req.params.id });
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid supplier ID',
        details: error.errors,
      });
    }
    next(error);
  }
}

