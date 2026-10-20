/**
 * Ozon Seller API: пауза между запросами и повтор при 429.
 * Обычные вызовы (остатки, FBO) уступают priority:'high' (FBS-заказы).
 */
import integrationsService from '../services/integrations.service.js';

/** Минимальный интервал между запросами (лимит Ozon — на секунду). */
export const OZON_SELLER_API_MIN_GAP_MS = 550;

let ozonSellerApiLastAt = 0;
let ozonSellerApiNormalQueue = Promise.resolve();
let ozonSellerApiHighQueue = Promise.resolve();
let ozonSellerApiExecLock = Promise.resolve();
/** Сколько high-запросов в полёте или в high-очереди. */
let ozonSellerApiHighPending = 0;

export function isOzonRateLimitError(err) {
  const msg = String(err?.message ?? '');
  return (
    msg.includes('429') ||
    /rate limit/i.test(msg) ||
    /too_many_requests/i.test(msg) ||
    /too frequently/i.test(msg)
  );
}

/** Ошибки в теле ответа Ozon stocks (HTTP 200, но result[].errors). */
export function isOzonStockRateLimitPayload(errors) {
  const list = Array.isArray(errors) ? errors : [];
  return list.some((e) => {
    const code = String(e?.code ?? '');
    const message = String(e?.message ?? '');
    return (
      /too_many_requests/i.test(code) ||
      /too frequently/i.test(message) ||
      /rate limit/i.test(message)
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rateLimitError(cause) {
  const err = new Error(
    'Ozon временно ограничил частоту запросов. Подождите 10–20 секунд и повторите отправку.'
  );
  err.statusCode = 429;
  err.code = 'OZON_RATE_LIMIT';
  err.cause = cause;
  return err;
}

async function withOzonSellerApiExecLock(fn) {
  let release;
  const prev = ozonSellerApiExecLock;
  ozonSellerApiExecLock = new Promise((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Поставить вызов в очередь. priority:'high' обходит накопленный stock/FBO-трафик.
 * Retry/backoff — вне exec-lock, чтобы high мог проскочить между попытками normal.
 */
function enqueueOzonSellerApi(priority, fn) {
  const isHigh = priority === 'high';
  if (isHigh) ozonSellerApiHighPending += 1;

  const run = async () => {
    try {
      if (!isHigh) {
        while (ozonSellerApiHighPending > 0) {
          await sleep(40);
        }
      }
      return await fn();
    } finally {
      if (isHigh) ozonSellerApiHighPending = Math.max(0, ozonSellerApiHighPending - 1);
    }
  };

  if (isHigh) {
    const p = ozonSellerApiHighQueue.then(run, run);
    ozonSellerApiHighQueue = p.catch(() => {});
    return p;
  }
  const p = ozonSellerApiNormalQueue.then(run, run);
  ozonSellerApiNormalQueue = p.catch(() => {});
  return p;
}

async function runWithGapAndRetry(callFn, { maxAttempts = 6, minGapMs = OZON_SELLER_API_MIN_GAP_MS } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await withOzonSellerApiExecLock(async () => {
        if (minGapMs > 0) {
          const wait = ozonSellerApiLastAt + minGapMs - Date.now();
          if (wait > 0) await sleep(wait);
        }
        ozonSellerApiLastAt = Date.now();
        return await callFn();
      });
    } catch (e) {
      if (!isOzonRateLimitError(e) || attempt >= maxAttempts - 1) {
        if (isOzonRateLimitError(e)) throw rateLimitError(e);
        throw e;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function ozonApiPostWithRetry(path, body, ozonApiOpts, opts = {}) {
  const { priority = 'normal', ...retryOpts } = opts;
  return enqueueOzonSellerApi(priority, () =>
    runWithGapAndRetry(
      () => integrationsService._ozonApiPost(path, body, ozonApiOpts),
      retryOpts
    )
  );
}

export async function ozonApiGetWithRetry(path, ozonApiOpts, opts = {}) {
  const { priority = 'normal', ...retryOpts } = opts;
  return enqueueOzonSellerApi(priority, () =>
    runWithGapAndRetry(() => integrationsService._ozonApiGet(path, ozonApiOpts), retryOpts)
  );
}

export async function ozonApiMultipartPostWithRetry(path, formData, ozonApiOpts, opts = {}) {
  const { priority = 'normal', maxAttempts = 4, minGapMs = OZON_SELLER_API_MIN_GAP_MS } = opts;
  return enqueueOzonSellerApi(priority, () =>
    runWithGapAndRetry(
      () => integrationsService._ozonApiMultipartPost(path, formData, ozonApiOpts),
      { maxAttempts, minGapMs }
    )
  );
}
