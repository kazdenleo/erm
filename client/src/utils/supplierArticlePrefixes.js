/**
 * Префиксы артикула поставщика (api_config.prefixes или устаревший prefix).
 */

export function normalizeSupplierPrefixes(input) {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const p = String(item ?? '').trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.sort((a, b) => b.length - a.length);
}

export function supplierPrefixesFromApiConfig(apiConfig) {
  if (!apiConfig || typeof apiConfig !== 'object') return [];
  if (Array.isArray(apiConfig.prefixes)) {
    return normalizeSupplierPrefixes(apiConfig.prefixes);
  }
  const legacy = apiConfig.prefix ?? apiConfig.article_prefix ?? apiConfig.articlePrefix;
  return normalizeSupplierPrefixes(legacy ? [legacy] : []);
}
