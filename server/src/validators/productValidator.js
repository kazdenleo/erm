/**
 * Product Validator
 * Валидация данных товаров с использованием Zod
 */

import { z } from 'zod';
import { normalizeBarcodeRows } from '../utils/productBarcodes.js';
import { normalizeMpFieldLinks } from '../utils/productMpFieldLinks.js';

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

/** Строковый идентификатор МП с лимитом длины (документация партнёрских API) */
function mpLinkSku(maxLen, label) {
  return z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => {
      if (v == null || v === '') return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    })
    .refine((v) => v == null || v.length <= maxLen, { message: `${label}: не более ${maxLen} символов (см. документацию МП)` });
}

/**
 * Схема валидации для создания товара
 */
export const createProductSchema = z.object({
  name: z.string().min(1, 'Название товара обязательно').max(500),
  sku: z.string().min(1, 'SKU обязательно').max(100),
  /** Ozon Seller API: offer_id, до 50 символов (/v2/product/import и смежные методы) */
  sku_ozon: mpLinkSku(50, 'Ozon offer_id'),
  /** Wildberries API: номенклатура nmId — числовой id, строкой до 20 символов */
  sku_wb: mpLinkSku(20, 'Wildberries nmId'),
  /** Яндекс Маркет Partner API: offerId / shopSku, 1–255 символов */
  sku_ym: mpLinkSku(255, 'Яндекс Маркет offerId'),
  /** Ozon Seller API: product_id (числовой id карточки после создания/импорта) */
  marketplace_ozon_product_id: optionalNum(),
  categoryId: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v === '' || v == null) return null;
    return typeof v === 'number' ? v : (String(v).trim() || null);
  }),
  organizationId: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v === '' || v == null) return null;
    return typeof v === 'number' ? v : (String(v).trim() || null);
  }),
  supplierId: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v === '' || v == null) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }),
  supplier_id: z.union([z.string(), z.number()]).optional().nullable().transform(v => {
    if (v === '' || v == null) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
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
  /** Габариты самого товара (не упаковки), мм / г */
  product_length: optionalNum(),
  product_width: optionalNum(),
  product_height: optionalNum(),
  product_weight: optionalNum(),
  productLength: optionalNum(),
  productWidth: optionalNum(),
  productHeight: optionalNum(),
  productWeight: optionalNum(),
  barcodes: z.array(
    z.union([
      z.string(),
      z.object({
        barcode: z.string(),
        marketplaces: z.array(z.string()).optional(),
      }),
    ])
  ).optional().default([]),
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
  attribute_values_manual: z.record(
    z.string(),
    z.union([z.boolean(), z.string(), z.number()])
  ).optional(),
  attribute_values_tool: z.record(
    z.string(),
    z.union([z.boolean(), z.string(), z.number()])
  ).optional(),
  // Карточка шлёт словарь Ozon как { dictionary_value_id } / { value }, bulk/Excel — скаляры
  ozon_attributes: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z
          .object({
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            dictionary_value_id: z.union([z.string(), z.number()]).optional(),
            id: z.union([z.string(), z.number()]).optional(),
          })
          .passthrough(),
      ])
    )
    .optional(),
  ozon_complex_attributes: z
    .object({
      version: z.number().optional(),
      groups: z.array(z.any()).optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  // Как ozon: допускаем объекты (иначе bulk PUT с габаритами товара падает целиком)
  wb_attributes: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z
          .object({
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            dictionary_value_id: z.union([z.string(), z.number()]).optional(),
            id: z.union([z.string(), z.number()]).optional(),
          })
          .passthrough(),
      ])
    )
    .optional(),
  ym_attributes: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z
          .object({
            value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            dictionary_value_id: z.union([z.string(), z.number()]).optional(),
            id: z.union([z.string(), z.number()]).optional(),
          })
          .passthrough(),
      ])
    )
    .optional(),
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
  /** Связь полей «Основное» с МП: { name: ['ozon','wb'], … } — пустые массивы допустимы */
  mp_field_links: z
    .any()
    .optional()
    .nullable()
    .transform((v) => (v == null || v === '' ? undefined : normalizeMpFieldLinks(v))),
  /** true — на МП уходит 0, фактический остаток не передаётся */
  block_stock_ozon: z.boolean().optional(),
  block_stock_wb: z.boolean().optional(),
  block_stock_ym: z.boolean().optional(),
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
    const raw = { ...(req.body || {}) };
    if ('barcodes' in raw) raw.barcodes = normBarcodes(raw.barcodes);
    req.body = createProductSchema.parse(raw);
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
  return normalizeBarcodeRows(v);
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
    const rawId = req.params.id ?? req.params.productId;
    productIdSchema.parse({ id: rawId });
    if (rawId != null && req.params.id == null) req.params.id = rawId;
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

