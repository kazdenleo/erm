/**
 * Политика автоотправки цен на маркетплейсы (организация).
 * По умолчанию выключено: без auto_push_marketplace_prices цены на МП не трогаем.
 */

import repositoryFactory from '../config/repository-factory.js';
import logger from './logger.js';

function parseEnabledFlag(entity) {
  if (!entity) return false;
  const v = entity.auto_push_marketplace_prices ?? entity.autoPushMarketplacePrices;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function normalizeId(id) {
  if (id == null || id === '') return null;
  const n = typeof id === 'string' ? parseInt(id, 10) : Number(id);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/**
 * @param {number|string|null|undefined} organizationId
 * @returns {Promise<boolean>} true — можно пушить цены на МП
 */
export async function isMarketplacePricePushEnabledForOrg(organizationId) {
  const idNum = normalizeId(organizationId);
  if (!idNum) return false;

  const repo = repositoryFactory.getOrganizationsRepository();
  const org = await repo.findById(idNum);
  return parseEnabledFlag(org);
}

/**
 * @param {{ organizationId?: number|string|null, source?: string, meta?: object, productId?: number|string|null }} ctx
 * @returns {Promise<{ allowed: boolean, organizationId?: number, reason?: string }>}
 */
export async function assertMarketplacePricePushAllowed(ctx = {}) {
  const organizationId = ctx.organizationId ?? null;
  const idNum = normalizeId(organizationId);
  if (!idNum) {
    logger.info('[MP Price Push] skipped: product has no organization', {
      productId: ctx.productId ?? null,
      source: ctx.source || null,
      ...(ctx.meta && typeof ctx.meta === 'object' ? { meta: ctx.meta } : {}),
    });
    return { allowed: false, reason: 'no_organization' };
  }

  if (!(await isMarketplacePricePushEnabledForOrg(idNum))) {
    logger.info('[MP Price Push] skipped by organization setting auto_push_marketplace_prices=off', {
      organizationId: idNum,
      productId: ctx.productId ?? null,
      source: ctx.source || null,
      ...(ctx.meta && typeof ctx.meta === 'object' ? { meta: ctx.meta } : {}),
    });
    return { allowed: false, organizationId: idNum, reason: 'org_price_push_disabled' };
  }

  return { allowed: true, organizationId: idNum };
}

export { parseEnabledFlag, normalizeId };
