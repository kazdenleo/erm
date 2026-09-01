/** Клиентская нормализация КИ — держать в синхроне с server/src/utils/chestnyZnak.js */

const GS_CHARS = `${String.fromCharCode(0x1c, 0x1d, 0x1e, 0x1f)}\u241d\u00e8`;
const GS_RE = new RegExp(`[${GS_CHARS}]`, 'g');

export function normalizeCis(raw) {
  return String(raw ?? '')
    .replace(GS_RE, '')
    .replace(/^\u241d/, '')
    .trim();
}

export function looksLikeCis(raw) {
  const s = normalizeCis(raw);
  if (!s) return false;
  if (/^\d{8,14}$/.test(s)) return false;
  if (s.startsWith('01') && s.length >= 16) return true;
  if (s.length >= 20) return true;
  return false;
}

export function extractGtinFromCis(cis) {
  const s = normalizeCis(cis);
  if (s.startsWith('01') && s.length >= 16 && /^\d{14}/.test(s.slice(2, 16))) {
    return s.slice(2, 16);
  }
  return null;
}

export function productLookupCodesFromScan(raw) {
  const s = normalizeCis(raw);
  if (!s) return [];
  if (!looksLikeCis(s)) return [s];
  const gtin = extractGtinFromCis(s);
  if (!gtin) return [s];
  const codes = [gtin];
  if (gtin.length === 14 && gtin.startsWith('0')) codes.push(gtin.slice(1));
  if (gtin.length === 14 && gtin.startsWith('00')) codes.push(gtin.slice(2));
  return [...new Set(codes.filter(Boolean))];
}
