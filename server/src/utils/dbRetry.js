/**
 * Повтор при занятом пуле БД или lock timeout (инвентаризация, закупки и т.д.).
 */

import logger from './logger.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isDbLockOrPoolBusy(error) {
  const msg = String(error?.message || '');
  return (
    error?.statusCode === 503 ||
    String(error?.code) === '55P03' ||
    /timeout exceeded when trying to connect|too many clients|lock timeout|база данных занята/i.test(
      msg
    )
  );
}

/**
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delayMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function runWithDbRetry(fn, { attempts = 4, delayMs = 8000, label = 'db-op' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isDbLockOrPoolBusy(e) || attempt >= attempts) throw e;
      const waitSec = Math.round((delayMs * attempt) / 1000);
      logger.warn(`[DB retry] ${label}: занято, повтор ${attempt}/${attempts} через ${waitSec} с`);
      await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}
