/**
 * Политика передачи остатков: пользовательские категории.
 * Мастер/каналы МП и исключения — на складе (warehouseMarketplaceStockSyncPolicy).
 */

import { query } from '../config/database.js';
import repositoryFactory from '../config/repository-factory.js';
import logger from './logger.js';

function parseSkipFlag(entity) {
  if (!entity) return false;
  const v = entity.skip_marketplace_stock_sync ?? entity.skipMarketplaceStockSync;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function normalizeId(id) {
  if (id == null || id === '') return null;
  const n = typeof id === 'string' ? parseInt(id, 10) : Number(id);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * @deprecated Настройка перенесена на склад. Оставлено для совместимости (всегда false).
 */
export async function isMarketplaceStockPushDisabled(_organizationId) {
  return false;
}

/**
 * Ищет предка в цепочке user_categories (сама категория + parent_id вверх) с включённым skip.
 * @param {number|string|null|undefined} userCategoryId
 * @returns {Promise<{ id: number, name: string }|null>}
 */
export async function findBlockingUserCategory(userCategoryId) {
  const idNum = normalizeId(userCategoryId);
  if (!idNum) return null;

  const result = await query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, name, skip_marketplace_stock_sync
       FROM user_categories
       WHERE id = $1
       UNION ALL
       SELECT uc.id, uc.parent_id, uc.name, uc.skip_marketplace_stock_sync
       FROM user_categories uc
       INNER JOIN ancestors a ON uc.id = a.parent_id
     )
     SELECT id, name
     FROM ancestors
     WHERE skip_marketplace_stock_sync = true
     LIMIT 1`,
    [idNum]
  );

  const row = result.rows?.[0];
  if (!row) return null;
  return { id: Number(row.id), name: row.name || String(row.id) };
}

/**
 * @param {number|string|null|undefined} productId
 * @returns {Promise<number|null>}
 */
export async function resolveUserCategoryIdForProduct(productId) {
  const idNum = normalizeId(productId);
  if (!idNum) return null;

  const repo = repositoryFactory.getProductsRepository();
  const product = await repo.findById(idNum);
  const cid = product?.user_category_id ?? product?.categoryId ?? product?.userCategoryId ?? null;
  return normalizeId(cid);
}

/**
 * @param {{ organizationId?: number|string|null, source?: string, meta?: object, productId?: number|string|null, userCategoryId?: number|string|null }} ctx
 * @returns {Promise<{ allowed: boolean, organizationId?: number, blockedBy?: 'user_category', userCategoryId?: number, userCategoryName?: string }>}
 */
export async function assertMarketplaceStockPushAllowed(ctx = {}) {
  const organizationId = ctx.organizationId ?? null;

  let userCategoryId = ctx.userCategoryId ?? null;
  if (userCategoryId == null && ctx.productId != null) {
    userCategoryId = await resolveUserCategoryIdForProduct(ctx.productId);
  }

  const blocking = await findBlockingUserCategory(userCategoryId);
  if (blocking) {
    logger.info('[MP Stock Push] skipped by user category setting skip_marketplace_stock_sync', {
      organizationId: organizationId != null ? Number(organizationId) : null,
      userCategoryId: blocking.id,
      userCategoryName: blocking.name,
      blockedBy: 'user_category',
      source: ctx.source || null,
      ...(ctx.meta && typeof ctx.meta === 'object' ? { meta: ctx.meta } : {})
    });
    return {
      allowed: false,
      blockedBy: 'user_category',
      organizationId: organizationId != null ? Number(organizationId) : undefined,
      userCategoryId: blocking.id,
      userCategoryName: blocking.name
    };
  }

  return {
    allowed: true,
    organizationId: organizationId != null ? Number(organizationId) : undefined
  };
}

export { parseSkipFlag };
