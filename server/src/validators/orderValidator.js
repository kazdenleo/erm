/**
 * Order Validator
 * Валидация данных заказов с использованием Zod
 */

import { z } from 'zod';

/**
 * Схема валидации для синхронизации заказов
 */
export const syncOrdersSchema = z.object({
  marketplace: z.enum(['ozon', 'wildberries', 'yandex']).optional(),
  force: z.boolean().optional().default(false),
});

/**
 * Схема валидации ID заказа
 */
export const orderIdSchema = z.object({
  orderId: z.string().min(1, 'ID заказа обязательно'),
});

/**
 * Схема для детальной карточки заказа (marketplace + orderId)
 */
export const orderDetailParamsSchema = z.object({
  marketplace: z.enum(['ozon', 'wildberries', 'wb', 'yandex', 'ym', 'manual']),
  orderId: z.string().min(1, 'ID заказа обязательно'),
});

/**
 * Middleware для валидации синхронизации заказов
 */
export function validateSyncOrders(req, res, next) {
  try {
    req.body = syncOrdersSchema.parse(req.body || {});
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
 * Middleware для валидации ID заказа
 */
export function validateOrderId(req, res, next) {
  try {
    orderIdSchema.parse({ orderId: req.params.orderId });
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
        details: error.errors,
      });
    }
    next(error);
  }
}

/**
 * Middleware для валидации параметров детальной карточки заказа
 */
export function validateOrderDetailParams(req, res, next) {
  try {
    orderDetailParamsSchema.parse({
      marketplace: req.params.marketplace,
      orderId: req.params.orderId,
    });
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid marketplace or order ID',
        details: error.errors,
      });
    }
    next(error);
  }
}

