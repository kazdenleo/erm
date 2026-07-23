/**
 * Очередь тяжёлых задач планировщика — одна за раз, чтобы не исчерпывать пул PostgreSQL.
 * Поддержка coalesce (не копить дубликаты) и priority (срочно в голову очереди).
 */

import logger from './logger.js';

let running = false;
let currentJobName = null;
/** @type {{ name: string, execute: () => void }[]} */
const waitQueue = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPoolConnectTimeout(error) {
  const msg = String(error?.message || '');
  return (
    error?.statusCode === 503 ||
    /timeout exceeded when trying to connect|too many clients/i.test(msg)
  );
}

export function isSchedulerDbJobRunning() {
  return running;
}

export function getSchedulerDbJobName() {
  return currentJobName;
}

function hasJobNamed(name) {
  const n = String(name || '');
  if (!n) return false;
  if (currentJobName === n) return true;
  return waitQueue.some((q) => q.name === n);
}

/**
 * @param {string} name — для логов
 * @param {() => Promise<unknown>} fn
 * @param {{ retries?: number, coalesce?: boolean, priority?: boolean }} [opts]
 *   coalesce — если такая задача уже выполняется/в очереди, не ставить ещё одну
 *   priority — поставить в голову очереди (для автозакупки/отправки поставщику)
 */
export function runSchedulerDbJob(name, fn, { retries = 3, coalesce = false, priority = false } = {}) {
  const jobName = String(name || 'job');

  if (coalesce && hasJobNamed(jobName)) {
    logger.info(`[Scheduler] DB job coalesced: ${jobName} (running/queued: ${currentJobName || 'queue'})`);
    return Promise.resolve({ skipped: true, reason: 'coalesced' });
  }

  return new Promise((resolve, reject) => {
    const execute = () => {
      running = true;
      currentJobName = jobName;
      (async () => {
        logger.info(`[Scheduler] DB job start: ${jobName}`);
        let lastErr;
        for (let attempt = 1; attempt <= retries; attempt += 1) {
          try {
            const result = await fn();
            resolve(result);
            return;
          } catch (e) {
            lastErr = e;
            if (!isPoolConnectTimeout(e) || attempt >= retries) {
              reject(e);
              return;
            }
            const waitSec = 20 * attempt;
            logger.warn(
              `[Scheduler] ${jobName}: пул БД занят, повтор ${attempt}/${retries} через ${waitSec} с`
            );
            await sleep(waitSec * 1000);
          }
        }
        reject(lastErr);
      })()
        .catch(reject)
        .finally(() => {
          running = false;
          currentJobName = null;
          const next = waitQueue.shift();
          if (next) next.execute();
        });
    };

    if (!running) {
      execute();
    } else {
      logger.info(`[Scheduler] DB job queued: ${jobName} (running: ${currentJobName})`);
      const entry = { name: jobName, execute };
      if (priority) waitQueue.unshift(entry);
      else waitQueue.push(entry);
    }
  });
}
