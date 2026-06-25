/**
 * Фоновая синхронизация статусов FBO-поставок с маркетплейсами (кроме финальных).
 */import logger from '../utils/logger.js';

let inProgress = false;
let lastResult = null;
let lastError = null;
let lastStartedAt = null;
let lastFinishedAt = null;

export function getFboSupplyStatusSyncStatus() {
  return {
    inProgress,
    lastStartedAt,
    lastFinishedAt,
    lastResult,
    lastError,
  };
}

export async function runFboShippedStatusSyncBlocking({ limit = 200 } = {}) {
  if (inProgress) {
    logger.info('[FboSupplyStatusSync] Skip: already in progress');
    return { skipped: true, reason: 'in_progress' };
  }

  inProgress = true;
  lastError = null;
  lastStartedAt = new Date().toISOString();
  try {
    const { default: fboSuppliesImportService } = await import('./fboSuppliesImport.service.js');
    lastResult = await fboSuppliesImportService.syncAllActiveStatusesFromMarketplace({ limit });
    if ((lastResult?.total ?? 0) > 0 || (lastResult?.updated ?? 0) > 0) {
      logger.info('[FboSupplyStatusSync] Completed', lastResult);
    }
    return lastResult;
  } catch (error) {
    lastError = error?.message || String(error);
    logger.warn('[FboSupplyStatusSync] Failed:', lastError);
    throw error;
  } finally {
    inProgress = false;
    lastFinishedAt = new Date().toISOString();
  }
}
