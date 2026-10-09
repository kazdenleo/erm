/**
 * Код ОКПД2 товара (копия логики server/src/utils/okpd2.js).
 */

export const OKPD2_FORMAT_HINT = 'ОКПД2 — от 2 до 9 цифр в формате 26.20.11.110';

/** Каноническая запись кода или '' (пусто), null — некорректный ввод. */
export function normalizeOkpd2Code(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^[\d.\s]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 2 || digits.length > 9) return null;
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6), digits.slice(6, 9)];
  return parts.filter(Boolean).join('.');
}

export function isOkpd2AttributeName(name) {
  const compact = String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return compact.includes('окпд') || compact.includes('okpd');
}
