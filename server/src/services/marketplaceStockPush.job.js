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

const STALE_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.MP_STOCK_PUSH_STALE_MS || String(90 * 60 * 1000), 10) || 90 * 60 * 1000
);

export function isMpStockPushStale() {
  if (!inProgress || !lastStartedAt) return false;
  const t = new Date(lastStartedAt).getTime();
  return Number.isFinite(t) && Date.now() - t > STALE_MS;
}

export function resetMpStockPushJob() {
  inProgress = false;
}

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
  if (inProgress && isMpStockPushStale()) {
    logger.warn('[MP Stock Push] Сброс зависшего флага inProgress (превышен таймаут ожидания)');
    inProgress = false;
  }
  if (inProgress && opts.force !== true) {
    return { started: false, inProgress: true, organizationId: lastOrganizationId };
  }
  if (opts.force === true) {
    inProgress = false;
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
