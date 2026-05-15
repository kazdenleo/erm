/**
 * Фоновая синхронизация остатков поставщиков (не блокирует HTTP-запрос).
 */
import logger from '../utils/logger.js';

let inProgress = false;
let lastResult = null;
let lastError = null;
let lastStartedAt = null;
let lastFinishedAt = null;

export function getSupplierStocksSyncStatus() {
  return {
    inProgress,
    lastStartedAt,
    lastFinishedAt,
    lastResult,
    lastError
  };
}

/**
 * @returns {{ started: boolean, inProgress: boolean }}
 */
export function startSupplierStocksSyncInBackground() {
  if (inProgress) {
    return { started: false, inProgress: true };
  }
  inProgress = true;
  lastError = null;
  lastResult = null;
  lastStartedAt = new Date().toISOString();
  lastFinishedAt = null;

  setImmediate(async () => {
    try {
      const { default: productsService } = await import('./products.service.js');
      lastResult = await productsService.refreshSupplierStocks(null);
      logger.info('[SupplierStocksSync] Background refresh completed', {
        total: lastResult?.total ?? 0,
        success: lastResult?.success ?? 0,
        failed: lastResult?.failed ?? 0
      });
    } catch (error) {
      lastError = error?.message || String(error);
      logger.warn('[SupplierStocksSync] Background refresh failed:', lastError);
    } finally {
      inProgress = false;
      lastFinishedAt = new Date().toISOString();
    }
  });

  return { started: true, inProgress: true };
}

export async function runSupplierStocksSyncBlocking() {
  if (inProgress) {
    logger.info('[SupplierStocksSync] Skip: already in progress');
    return null;
  }
  inProgress = true;
  lastError = null;
  lastStartedAt = new Date().toISOString();
  try {
    const { default: productsService } = await import('./products.service.js');
    lastResult = await productsService.refreshSupplierStocks(null);
    return lastResult;
  } catch (error) {
    lastError = error?.message || String(error);
    throw error;
  } finally {
    inProgress = false;
    lastFinishedAt = new Date().toISOString();
  }
}
