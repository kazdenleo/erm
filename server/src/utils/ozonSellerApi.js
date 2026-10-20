/**
 * Ozon Seller API: очередь, пауза между запросами, retry при 429, cooldown по Client-Id.
 * priority:'high' (FBS-заказы) обходит накопленный stock/FBO-трафик.
 * Во время окна синка заказов normal-запросы ждут его окончания.
 */
import integrationsService from '../services/integrations.service.js';

/** Мин. интервал между запросами одного Client-Id (Ozon — лимит на секунду). */
export const OZON_SELLER_API_MIN_GAP_MS = Math.max(
  400,
  parseInt(process.env.OZON_SELLER_API_MIN_GAP_MS || '900', 10) || 900
);

/** После 429 не бить этот Client-Id ещё N мс. */
export const OZON_SELLER_API_COOLDOWN_MS = Math.max(
  5_000,
  parseInt(process.env.OZON_SELLER_API_COOLDOWN_MS || '20000', 10) || 20_000
);

let ozonSellerApiNormalQueue = Promise.resolve();
let ozonSellerApiHighQueue = Promise.resolve();
let ozonSellerApiExecLock = Promise.resolve();
let ozonSellerApiHighPending = 0;
/** Глубина «окна» синка FBS-заказов — normal (остатки/FBO) ждёт. */
let ozonOrdersSyncWindowDepth = 0;

/** @type {Map<string, number>} clientId → last request at */
const lastAtByClient = new Map();
/** @type {Map<string, number>} clientId → cooldown until */
const cooldownUntilByClient = new Map();

export function isOzonRateLimitError(err) {
  const msg = String(err?.message ?? '');
  return (
    msg.includes('429') ||
    /rate limit/i.test(msg) ||
    /too_many_requests/i.test(msg) ||
    /too frequently/i.test(msg) ||
    err?.code === 'OZON_RATE_LIMIT'
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

function clientKeyFromOpts(ozonApiOpts) {
  const o = ozonApiOpts?.ozonOverride;
  const id = o?.client_id ?? o?.clientId ?? ozonApiOpts?.client_id ?? ozonApiOpts?.clientId;
  if (id != null && String(id).trim() !== '') return String(id).trim();
  const pid = ozonApiOpts?.profileId ?? ozonApiOpts?.profile_id;
  if (pid != null && String(pid).trim() !== '') return `profile:${pid}`;
  const org = ozonApiOpts?.organizationId ?? ozonApiOpts?.organization_id;
  if (org != null && String(org).trim() !== '') return `org:${org}`;
  return 'default';
}

export function noteOzonClientRateLimited(clientIdOrOpts, cooldownMs = OZON_SELLER_API_COOLDOWN_MS) {
  const key =
    typeof clientIdOrOpts === 'string' || typeof clientIdOrOpts === 'number'
      ? String(clientIdOrOpts)
      : clientKeyFromOpts(clientIdOrOpts || {});
  const until = Date.now() + Math.max(1000, cooldownMs);
  const prev = cooldownUntilByClient.get(key) || 0;
  if (until > prev) cooldownUntilByClient.set(key, until);
}

export function beginOzonOrdersSyncWindow() {
  ozonOrdersSyncWindowDepth += 1;
}

export function endOzonOrdersSyncWindow() {
  ozonOrdersSyncWindowDepth = Math.max(0, ozonOrdersSyncWindowDepth - 1);
}

export function isOzonOrdersSyncWindowActive() {
  return ozonOrdersSyncWindowDepth > 0;
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

function enqueueOzonSellerApi(priority, fn) {
  const isHigh = priority === 'high';
  if (isHigh) ozonSellerApiHighPending += 1;

  const run = async () => {
    try {
      if (!isHigh) {
        while (ozonSellerApiHighPending > 0 || ozonOrdersSyncWindowDepth > 0) {
          await sleep(50);
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

async function waitClientGapAndCooldown(clientKey, minGapMs) {
  for (;;) {
    const coolUntil = cooldownUntilByClient.get(clientKey) || 0;
    const last = lastAtByClient.get(clientKey) || 0;
    const now = Date.now();
    const waitCool = coolUntil - now;
    const waitGap = last + minGapMs - now;
    const wait = Math.max(waitCool, waitGap, 0);
    if (wait <= 0) return;
    await sleep(Math.min(wait, 5_000));
  }
}

async function runWithGapAndRetry(
  callFn,
  { maxAttempts = 6, minGapMs = OZON_SELLER_API_MIN_GAP_MS, clientKey = 'default' } = {}
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await withOzonSellerApiExecLock(async () => {
        await waitClientGapAndCooldown(clientKey, minGapMs);
        lastAtByClient.set(clientKey, Date.now());
        return await callFn();
      });
    } catch (e) {
      if (!isOzonRateLimitError(e) || attempt >= maxAttempts - 1) {
        if (isOzonRateLimitError(e)) {
          noteOzonClientRateLimited(clientKey);
          throw rateLimitError(e);
        }
        throw e;
      }
      noteOzonClientRateLimited(clientKey, Math.min(60_000, OZON_SELLER_API_COOLDOWN_MS * (attempt + 1)));
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function ozonApiPostWithRetry(path, body, ozonApiOpts, opts = {}) {
  const { priority = 'normal', ...retryOpts } = opts;
  const clientKey = clientKeyFromOpts(ozonApiOpts || {});
  return enqueueOzonSellerApi(priority, () =>
    runWithGapAndRetry(
      () => integrationsService._ozonApiPost(path, body, ozonApiOpts),
      { ...retryOpts, clientKey }
    )
  );
}

export async function ozonApiGetWithRetry(path, ozonApiOpts, opts = {}) {
  const { priority = 'normal', ...retryOpts } = opts;
  const clientKey = clientKeyFromOpts(ozonApiOpts || {});
  return enqueueOzonSellerApi(priority, () =>
    runWithGapAndRetry(() => integrationsService._ozonApiGet(path, ozonApiOpts), {
      ...retryOpts,
      clientKey,
    })
  );
}

export async function ozonApiMultipartPostWithRetry(path, formData, ozonApiOpts, opts = {}) {
  const { priority = 'normal', maxAttempts = 4, minGapMs = OZON_SELLER_API_MIN_GAP_MS } = opts;
  const clientKey = clientKeyFromOpts(ozonApiOpts || {});
  return enqueueOzonSellerApi(priority, () =>
    runWithGapAndRetry(
      () => integrationsService._ozonApiMultipartPost(path, formData, ozonApiOpts),
      { maxAttempts, minGapMs, clientKey }
    )
  );
}
