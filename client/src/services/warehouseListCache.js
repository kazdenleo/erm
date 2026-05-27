/**
 * Общий кэш и дедупликация списка складов (все экземпляры useWarehouses / повторные вызовы).
 */

const CACHE_TTL_MS = 60_000;

/** @type {Map<string, { data: unknown, at: number }>} */
const dataCache = new Map();
/** @type {Map<string, Promise<unknown>>} */
const inflight = new Map();

export function warehouseListCacheKey(organizationId) {
  return organizationId != null && organizationId !== '' ? String(organizationId) : '_all';
}

export function getCachedWarehouseList(key) {
  const entry = dataCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    dataCache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedWarehouseList(key, data) {
  dataCache.set(key, { data, at: Date.now() });
}

export function getInflightWarehouseList(key) {
  return inflight.get(key) ?? null;
}

export function setInflightWarehouseList(key, promise) {
  inflight.set(key, promise);
  promise.finally(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  });
  return promise;
}

export function invalidateWarehouseListCache(organizationId) {
  if (organizationId != null && organizationId !== '') {
    const key = warehouseListCacheKey(organizationId);
    dataCache.delete(key);
    inflight.delete(key);
    return;
  }
  dataCache.clear();
  inflight.clear();
}
