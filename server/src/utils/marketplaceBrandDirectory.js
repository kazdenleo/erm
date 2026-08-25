/**
 * Нормализация и ранжирование брендов из справочников МП.
 */

export const MP_BRAND_MARKETPLACES = ['ozon', 'wb', 'ym'];

export function normalizeMpBrandMarketplace(marketplace) {
  const m = String(marketplace || '').trim().toLowerCase();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex' || m === 'yandexmarket') return 'ym';
  return m;
}

export function normalizeBrandName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function brandNameNorm(value) {
  return normalizeBrandName(value).toLowerCase();
}

function uppercaseLetterCount(value) {
  return String(value || '').replace(/[^A-ZА-ЯЁ]/g, '').length;
}

function hasBrandId(entry) {
  return entry?.id != null && String(entry.id).trim() !== '';
}

/** Среди одинаковых имён без учёта регистра предпочитаем запись с id и канонический регистр WB (MILES, не Miles). */
export function preferDirectoryBrandEntry(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const nextHasId = hasBrandId(next);
  const prevHasId = hasBrandId(prev);
  if (nextHasId && !prevHasId) return next;
  if (prevHasId && !nextHasId) return prev;
  if (uppercaseLetterCount(next.name) > uppercaseLetterCount(prev.name)) return next;
  return prev;
}

export function normalizeDirectoryBrandEntries(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.brands)
        ? data.brands
        : Array.isArray(data?.result)
          ? data.result
          : [];
  const byKey = new Map();
  for (const b of list) {
    const name = normalizeBrandName(b?.name ?? b?.value ?? b?.brand ?? (typeof b === 'string' ? b : ''));
    if (!name) continue;
    const key = name.toLowerCase();
    const id = b?.id ?? b?.brandId ?? b?.brand_id ?? b?.mp_brand_id ?? b?.dictionary_value_id ?? null;
    const entry = {
      name,
      id: id != null && String(id).trim() !== '' ? String(id) : null,
    };
    byKey.set(key, preferDirectoryBrandEntry(byKey.get(key), entry));
  }
  return [...byKey.values()];
}

export function rankDirectoryBrands(list, q, limit = 50) {
  const nq = brandNameNorm(q);
  const src = Array.isArray(list) ? list : [];
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 80);
  if (!nq) return src.slice(0, cap);
  const scored = [];
  for (const b of src) {
    const ln = String(b?.name || '').toLowerCase();
    if (!ln) continue;
    let score = 0;
    if (ln === nq) score = 3;
    else if (ln.startsWith(nq)) score = 2;
    else if (ln.includes(nq)) score = 1;
    else continue;
    scored.push({ ...b, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), 'ru'));
  return scored.map(({ score, ...rest }) => rest).slice(0, cap);
}

export function pickDirectoryBrandName(list, wanted) {
  const q = brandNameNorm(wanted);
  if (!q || !Array.isArray(list) || !list.length) return null;
  const entries = list
    .map((b) => ({
      name: normalizeBrandName(b?.name ?? b?.brand ?? (typeof b === 'string' ? b : '')),
      id: b?.id ?? b?.brandId ?? b?.mp_brand_id ?? null,
    }))
    .filter((b) => b.name);
  let best = null;
  for (const entry of entries) {
    if (brandNameNorm(entry.name) !== q) continue;
    best = preferDirectoryBrandEntry(best, {
      name: entry.name,
      id: entry.id != null && String(entry.id).trim() !== '' ? String(entry.id) : null,
    });
  }
  if (best?.name) return best.name;
  return (
    entries
      .map((b) => b.name)
      .find((n) => n.toLowerCase().startsWith(q) || q.startsWith(n.toLowerCase())) || null
  );
}
