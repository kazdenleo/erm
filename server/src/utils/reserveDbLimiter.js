/**
 * Ограничение параллелизма тяжёлых операций резерва (FBO rebalance, пакетные SUM по stock_movements).
 * Снижает исчерпание пула PostgreSQL при всплесках cron + API.
 */

let active = 0;
const waitQueue = [];

function maxConcurrency() {
  const raw = Number(process.env.RESERVE_DB_CONCURRENCY_MAX);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(10, Math.floor(raw));
  return 2;
}

export function getReserveDbLimiterStats() {
  return { active, queued: waitQueue.length, max: maxConcurrency() };
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runReserveDbLimited(fn) {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      active += 1;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        active -= 1;
        const next = waitQueue.shift();
        if (next) next();
      }
    };

    if (active < maxConcurrency()) {
      execute();
    } else {
      waitQueue.push(execute);
    }
  });
}
