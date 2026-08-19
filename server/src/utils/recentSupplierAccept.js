/**
 * Кратковременный антидубль автозакупки после успешного Basket_Add / API.
 * Нужен, если локальную строку закупки успели откатить, а позиция у поставщика осталась:
 * следующий тик крона снова видит дефицит и дублирует корзину.
 *
 * In-memory (один процесс Node/pm2). TTL покрывает типичный цикл до ручной чистки.
 */

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12ч
const _recent = new Map(); // key -> expiresAtMs

function keyOf(profileId, orderDbId, productId) {
  return `${Number(profileId)}|${Number(orderDbId)}|${Number(productId)}`;
}

function pruneExpired(now = Date.now()) {
  if (_recent.size < 200) return;
  for (const [k, exp] of _recent) {
    if (exp <= now) _recent.delete(k);
  }
}

export function rememberSupplierAccept(profileId, orderDbId, productId, ttlMs = DEFAULT_TTL_MS) {
  const pid = Number(profileId);
  const oid = Number(orderDbId);
  const prod = Number(productId);
  if (!Number.isFinite(pid) || !Number.isFinite(oid) || oid < 1 || !Number.isFinite(prod) || prod < 1) {
    return;
  }
  const now = Date.now();
  pruneExpired(now);
  _recent.set(keyOf(pid, oid, prod), now + Math.max(60_000, ttlMs));
}

export function hasRecentSupplierAccept(profileId, orderDbId, productId) {
  const pid = Number(profileId);
  const oid = Number(orderDbId);
  const prod = Number(productId);
  if (!Number.isFinite(pid) || !Number.isFinite(oid) || !Number.isFinite(prod)) return false;
  const key = keyOf(pid, oid, prod);
  const exp = _recent.get(key);
  if (exp == null) return false;
  if (Date.now() > exp) {
    _recent.delete(key);
    return false;
  }
  return true;
}

/** Для тестов. */
export function _clearRecentSupplierAcceptsForTests() {
  _recent.clear();
}
