/**
 * Фоновая архивация старых завершённых заказов.
 */
import logger from '../utils/logger.js';
import repositoryFactory from '../config/repository-factory.js';

const ARCHIVE_AFTER_DAYS = Math.max(
  1,
  parseInt(process.env.ORDERS_ARCHIVE_AFTER_DAYS || '30', 10) || 30
);
const BATCH_SIZE = Math.max(
  100,
  parseInt(process.env.ORDERS_ARCHIVE_BATCH_SIZE || '5000', 10) || 5000
);

let inProgress = false;
let lastResult = null;
let lastError = null;
let lastStartedAt = null;
let lastFinishedAt = null;

export function getOrdersArchiveStatus() {
  return {
    inProgress,
    archiveAfterDays: ARCHIVE_AFTER_DAYS,
    batchSize: BATCH_SIZE,
    lastStartedAt,
    lastFinishedAt,
    lastResult,
    lastError,
  };
}

/**
 * @param {{ profileId?: number|string|null, maxBatches?: number }} [options]
 */
export async function runOrdersArchiveBlocking(options = {}) {
  if (!repositoryFactory.isUsingPostgreSQL()) {
    return { archived: 0, batches: 0, skipped: true, reason: 'not_postgresql' };
  }
  const ordersRepo = repositoryFactory.getOrdersRepository();
  if (typeof ordersRepo.archiveOldTerminalOrders !== 'function') {
    return { archived: 0, batches: 0, skipped: true, reason: 'method_missing' };
  }

  const maxBatches = Math.max(1, parseInt(options.maxBatches || '20', 10) || 20);
  let totalArchived = 0;
  let batches = 0;

  for (let i = 0; i < maxBatches; i += 1) {
    const archived = await ordersRepo.archiveOldTerminalOrders({
      olderThanDays: ARCHIVE_AFTER_DAYS,
      batchSize: BATCH_SIZE,
      profileId: options.profileId ?? null,
    });
    if (!archived) break;
    totalArchived += archived;
    batches += 1;
  }

  return { archived: totalArchived, batches, archiveAfterDays: ARCHIVE_AFTER_DAYS };
}

/**
 * @returns {{ started: boolean, inProgress: boolean }}
 */
export function startOrdersArchiveInBackground(options = {}) {
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
      lastResult = await runOrdersArchiveBlocking(options);
      logger.info('[OrdersArchive] Completed', lastResult);
    } catch (error) {
      lastError = error?.message || String(error);
      logger.warn('[OrdersArchive] Failed:', lastError);
    } finally {
      inProgress = false;
      lastFinishedAt = new Date().toISOString();
    }
  });

  return { started: true, inProgress: true };
}
