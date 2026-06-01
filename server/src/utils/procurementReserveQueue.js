/**
 * Очередь фонового дозарезервирования после закупки — одна задача за раз,
 * чтобы не забивать пул PostgreSQL параллельно с синхронизацией заказов.
 */

import logger from './logger.js';

let running = false;
const waitQueue = [];

export function enqueueProcurementReserveJob(fn, { label = 'procurement-reserve' } = {}) {
  return new Promise((resolve, reject) => {
    const job = { fn, label, resolve, reject };
    const run = () => {
      running = true;
      (async () => {
        logger.debug(`[Procurement reserve] start: ${label}`);
        await fn();
        job.resolve();
      })()
        .catch((e) => {
          logger.warn(`[Procurement reserve] failed: ${label}`, {
            message: e?.message || String(e),
          });
          job.reject(e);
        })
        .finally(() => {
          running = false;
          const next = waitQueue.shift();
          if (next) next();
        });
    };

    if (!running) {
      run();
    } else {
      waitQueue.push(run);
    }
  }).catch(() => {});
}
