/**
 * Product Validator
 * Валидация данных товаров с использованием Zod
 */

import { z } from 'zod';

// Приведение к числу (строка/число с фронта), пусто -> null
const optionalNum = () => z.union([z.string(), z.number()]).optional().nullable().transform(v => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
});

/** Текст карточки по МП (пустая строка → null) */
const optionalMpText = (maxLen) =>
  z.preprocess(
    (val) => {
      if (val == null || val === '') return null;
      const s = String(val).trim();
      if (!s) return null;
      return maxLen != null ? s.slice(0, maxLen) : s;
    },
    z.union([z.string(), z.null()]).optional()
  );

/**
 * Схема валидации для создания товара
 */
export const createProductSchema = z.object({
  name: z.string().min(1, 'Название товара обязательно').max(500),
  sku: z.string().min(1, 'SKU обязательно').max(100),
  sku_ozon: z.union([z.string(), z.number()]).optional().nullable().transform(v => (v == null || v === '' ? null : String(v).trim() || null)),
  sku_wb: z.union([z.string(), z.number()]).optional().nullable().transform(v => (v == null || v === '' ? null : String(v).trim() || null)),
  sku_ym: z.union([z.string(), z.number()]).optional().nullable().transform(v => (v == null || v === '' ? null : String(v).trim() || null)),
  categoryId: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v === '' || v == null) return null;
    return typeof v === 'number' ? v : (String(v).trim() || null);
  }),
  organizationId: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v === '' || v == null) return null;
    return typeof v === 'number' ? v : (String(v).trim() || null);
  }),
  price: optionalNum(),
  cost: optionalNum(),
  additionalExpenses: optionalNum(),
  // snake_case алиас (на случай старых клиентов)
  additional_expenses: optionalNum(),
  minPrice: optionalNum(),
  volume: optionalNum(),
  weight: optionalNum(),
  length: optionalNum(),
  width: optionalNum(),
  height: optionalNum(),
  barcodes: z.array(z.string()).optional().default([]),
  description: z.string().optional().nullable(),
  country_of_origin: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }),
  brand: z.string().optional().nullable(),
  quantity: z.union([z.string(), z.number()]).optional().default(0).transform(v => {
    if (v === '' || v == null) return 0;
    const n = parseInt(Number(v), 10);
    return Number.isNaN(n) ? 0 : Math.max(0, n);
  }),
  unit: z.string().optional().default('шт'),
  buyout_rate: z.union([z.string(), z.number()]).optional().transform(v => {
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : Math.min(100, Math.max(0, n));
  }),
  product_type: z.enum(['product', 'kit']).optional().default('product'),
  kit_components: z.array(z.object({
    productId: z.union([z.string(), z.number()]).transform(v => (v == null ? null : Number(v))),
    quantity: z.union([z.string(), z.number()]).optional().default(1).transform(v => Math.max(1, parseInt(Number(v), 10) || 1)),
  })).optional().default([]),
  attribute_values: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()])
  ).optional().default({}),
  ozon_attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  wb_attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  ym_attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  ozon_draft: z.any().optional().nullable(),
  wb_draft: z.any().optional().nullable(),
  ym_draft: z.any().optional().nullable(),
  images: z.array(z.any()).optional().nullable(),
  mp_ozon_name: optionalMpText(2000),
  mp_ozon_description: optionalMpText(50000),
  mp_ozon_brand: optionalMpText(500),
  mp_wb_vendor_code: optionalMpText(255),
  mp_wb_name: optionalMpText(2000),
  mp_wb_description: optionalMpText(50000),
  mp_wb_brand: optionalMpText(500),
  mp_ym_name: optionalMpText(2000),
  mp_ym_description: optionalMpText(50000),
});

/**
 * Схема валидации для обновления товара
 */
export const updateProductSchema = createProductSchema.partial();

/**
 * Схема валидации ID товара
 */
export const productIdSchema = z.object({
  id: z.string().min(1, 'ID товара обязательно'),
});

/**
 * Middleware для валидации создания товара
 */
export function validateCreateProduct(req, res, next) {
  try {
    req.body = createProductSchema.parse(req.body);
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
 * Middleware для валидации обновления товара
 */
function normSku(v) {
  return (v != null && String(v).trim() !== '') ? String(v).trim() : null;
}

function normBarcodes(v) {
  if (!Array.isArray(v)) return [];
  return v.map(b => (b != null ? String(b).trim() : '')).filter(Boolean);
}

export function validateUpdateProduct(req, res, next) {
  try {
    const raw = req.body || {};
    const toValidate = { ...raw };
    if ('sku_ozon' in raw) toValidate.sku_ozon = normSku(raw.sku_ozon);
    if ('sku_wb' in raw) toValidate.sku_wb = normSku(raw.sku_wb);
    if ('sku_ym' in raw) toValidate.sku_ym = normSku(raw.sku_ym);
    if ('barcodes' in raw) toValidate.barcodes = normBarcodes(raw.barcodes);
    // алиас: additional_expenses -> additionalExpenses
    if ('additional_expenses' in raw && !('additionalExpenses' in raw)) {
      toValidate.additionalExpenses = raw.additional_expenses;
    }
    req.body = updateProductSchema.parse(toValidate);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(`[Product Validator] Validation error:`, error.errors);
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
 * Middleware для валидации ID товара
 */
export function validateProductId(req, res, next) {
  try {
    productIdSchema.parse({ id: req.params.id });
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID',
        details: error.errors,
      });
    }
    next(error);
  }
}

