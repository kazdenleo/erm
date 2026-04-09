/**
 * Единообразное преобразование profile_id из PostgreSQL (int8 / bigint / string) в number | null
 */

export function profileIdFromDb(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Плоская строка из pg → безопасно для JSON.stringify (BigInt нельзя сериализовать) */
export function jsonSafeRow(row) {
  if (row == null || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}
