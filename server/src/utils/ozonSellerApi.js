/**
 * Ozon Seller API: пауза между запросами и повтор при 429.
 */
import integrationsService from '../services/integrations.service.js';

/** Минимальный интервал между запросами (лимит Ozon — на секунду). */
export const OZON_SELLER_API_MIN_GAP_MS = 550;

let ozonSellerApiLastAt = 0;
let ozonSellerApiQueue = Promise.resolve();

export function isOzonRateLimitError(err) {
  const msg = String(err?.message ?? '');
  return msg.includes('429') || /rate limit/i.test(msg);
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ozonApiPostWithRetryInner(
  path,
  body,
  ozonApiOpts,
  { maxAttempts = 6, minGapMs = OZON_SELLER_API_MIN_GAP_MS } = {}
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (minGapMs > 0) {
      const wait = ozonSellerApiLastAt + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    ozonSellerApiLastAt = Date.now();
    try {
      return await integrationsService._ozonApiPost(path, body, ozonApiOpts);
    } catch (e) {
      if (!isOzonRateLimitError(e) || attempt >= maxAttempts - 1) {
        if (isOzonRateLimitError(e)) {
          const err = new Error(
            'Ozon временно ограничил частоту запросов. Подождите 10–20 секунд и повторите отправку.'
          );
          err.statusCode = 429;
          err.code = 'OZON_RATE_LIMIT';
          err.cause = e;
          throw err;
        }
        throw e;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function ozonApiPostWithRetry(
  path,
  body,
  ozonApiOpts,
  opts = {}
) {
  const run = ozonSellerApiQueue.then(() => ozonApiPostWithRetryInner(path, body, ozonApiOpts, opts));
  ozonSellerApiQueue = run.catch(() => {});
  return run;
}
