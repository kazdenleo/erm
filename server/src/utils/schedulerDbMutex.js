/**
 * Очередь тяжёлых ночных задач планировщика — одна за раз, чтобы не исчерпывать пул PostgreSQL.
 */

import logger from './logger.js';

let running = false;
let currentJobName = null;
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

/**
 * @param {string} name — для логов
 * @param {() => Promise<unknown>} fn
 * @param {{ retries?: number }} [opts]
 */
export function runSchedulerDbJob(name, fn, { retries = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const execute = () => {
      running = true;
      currentJobName = name;
      (async () => {
        logger.info(`[Scheduler] DB job start: ${name}`);
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
              `[Scheduler] ${name}: пул БД занят, повтор ${attempt}/${retries} через ${waitSec} с`
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
          if (next) next();
        });
    };

    if (!running) {
      execute();
    } else {
      logger.info(`[Scheduler] DB job queued: ${name} (running: ${currentJobName})`);
      waitQueue.push(execute);
    }
  });
}
