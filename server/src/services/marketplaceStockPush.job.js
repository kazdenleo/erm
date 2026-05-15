/**
 * Фоновая отправка остатков на маркетплейсы (массовая по организации / складу).
 */
import logger from '../utils/logger.js';

let inProgress = false;
let lastResult = null;
let lastError = null;
let lastStartedAt = null;
let lastFinishedAt = null;
let lastOrganizationId = null;

export function getMpStockPushStatus() {
  return {
    inProgress,
    lastStartedAt,
    lastFinishedAt,
    lastResult,
    lastError,
    organizationId: lastOrganizationId
  };
}

/**
 * @param {number|string} organizationId
 * @param {object} opts — те же, что у syncOrganizationWarehouseStockToMarketplaces
 * @returns {{ started: boolean, inProgress: boolean, productsTotal?: number }}
 */
export function startMpStockPushInBackground(organizationId, opts = {}) {
  if (inProgress) {
    return { started: false, inProgress: true, organizationId: lastOrganizationId };
  }
  inProgress = true;
  lastError = null;
  lastResult = null;
  lastOrganizationId = organizationId != null ? String(organizationId) : null;
  lastStartedAt = new Date().toISOString();
  lastFinishedAt = null;

  const productsTotal = opts.productsTotal ?? null;

  setImmediate(async () => {
    try {
      const { syncOrganizationWarehouseStockToMarketplaces } = await import(
        './marketplaceWarehouseStockSync.service.js'
      );
      lastResult = await syncOrganizationWarehouseStockToMarketplaces(organizationId, {
        ...opts,
        includeDetails: false
      });
      logger.info('[MP Stock Push] Background bulk completed', {
        organizationId: lastOrganizationId,
        pushed: lastResult?.pushed ?? 0,
        failed: lastResult?.failed ?? 0,
        skipped: lastResult?.skipped ?? 0,
        productsTotal: lastResult?.productsTotal ?? productsTotal
      });
    } catch (error) {
      lastError = error?.message || String(error);
      logger.warn('[MP Stock Push] Background bulk failed:', lastError);
    } finally {
      inProgress = false;
      lastFinishedAt = new Date().toISOString();
    }
  });

  return { started: true, inProgress: true, productsTotal };
}
