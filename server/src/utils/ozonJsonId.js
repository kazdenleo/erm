/**
 * Идентификаторы Ozon (cargo_id, supply_id, …) часто длиннее Number.MAX_SAFE_INTEGER.
 * Number('1000000000064728284') → 1000000000064728300 — порча и коллизии этикеток.
 * В JSON отдаём безопасный number либо строку из цифр без потери точности.
 */

export function toOzonJsonId(raw) {
  if (raw == null || raw === '') return raw;
  const s = String(raw).trim();
  if (!s) return s;
  if (/^-?\d+$/.test(s)) {
    if (s.length <= 15) {
      const n = Number(s);
      if (Number.isSafeInteger(n)) return n;
    }
    return s;
  }
  const n = Number(s);
  return Number.isFinite(n) && Number.isSafeInteger(n) ? n : s;
}
