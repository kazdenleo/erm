/**
 * Общий кэш и дедупликация запросов списка складов между экземплярами useWarehouses.
 */

import { warehousesApi } from '../services/warehouses.api';
import { extractWarehousesFromApiResponse } from '../utils/deductionWarehouses.js';

const CACHE_TTL_MS = 30_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** @type {Map<string, { data: unknown[], fetchedAt: number }>} */
const cacheByKey = new Map();
/** @type {Map<string, Promise<unknown[]>>} */
const inflightByKey = new Map();

let rateLimitedUntil = 0;

export function warehouseCacheKey(organizationId) {
  return organizationId != null && organizationId !== '' ? String(organizationId) : '_all';
}

export function clearWarehousesCache(key) {
  if (key == null) {
    cacheByKey.clear();
    return;
  }
  cacheByKey.delete(warehouseCacheKey(key));
}

function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const sec = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * @param {string} key
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<unknown[]>}
 */
export async function fetchWarehousesShared(key, options = {}) {
  const { force = false } = options;
  const now = Date.now();

  if (now < rateLimitedUntil) {
    const cached = cacheByKey.get(key);
    if (cached?.data?.length) {
      return cached.data;
    }
    const err = new Error(
      'Слишком много запросов. Подождите минуту и обновите страницу.'
    );
    err.status = 429;
    throw err;
  }

  const cached = cacheByKey.get(key);
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const inflight = inflightByKey.get(key);
  if (!force && inflight) {
    return inflight;
  }

  const params =
    key !== '_all' ? { organizationId: key } : {};

  const request = warehousesApi
    .getAll(key !== '_all' ? params : {})
    .then((response) => {
      const list = extractWarehousesFromApiResponse(response);
      cacheByKey.set(key, { data: list, fetchedAt: Date.now() });
      return list;
    })
    .catch((err) => {
      if (err?.response?.status === 429) {
        rateLimitedUntil = Date.now() + parseRetryAfterMs(err.response?.headers);
      }
      throw err;
    })
    .finally(() => {
      inflightByKey.delete(key);
    });

  inflightByKey.set(key, request);
  return request;
}
