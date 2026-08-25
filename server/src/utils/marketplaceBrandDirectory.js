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
  const out = [];
  const seen = new Set();
  for (const b of list) {
    const name = normalizeBrandName(b?.name ?? b?.value ?? b?.brand ?? (typeof b === 'string' ? b : ''));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = b?.id ?? b?.brandId ?? b?.brand_id ?? b?.mp_brand_id ?? b?.dictionary_value_id ?? null;
    out.push({
      name,
      id: id != null && String(id).trim() !== '' ? String(id) : null,
    });
  }
  return out;
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
  const names = list.map((b) => normalizeBrandName(b?.name ?? b?.brand ?? b)).filter(Boolean);
  const exact = names.filter((n) => n.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const wantedName = normalizeBrandName(wanted);
    const withId = list.find((b) => brandNameNorm(b?.name) === q && b?.id);
    if (withId?.name) return normalizeBrandName(withId.name);
    const canonical = exact.find((n) => n !== wantedName);
    return canonical || exact[0];
  }
  return names.find((n) => n.toLowerCase().startsWith(q) || q.startsWith(n.toLowerCase())) || null;
}
