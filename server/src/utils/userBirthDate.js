/**
 * Дата рождения пользователя (DATE, YYYY-MM-DD).
 */

export function parseBirthDate(value) {
  if (value == null || value === '') {
    return { value: null };
  }
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { error: 'Укажите дату рождения в формате ГГГГ-ММ-ДД' };
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: 'Некорректная дата рождения' };
  }
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (dt.getTime() > todayUtc) {
    return { error: 'Дата рождения не может быть в будущем' };
  }
  if (y < 1900) {
    return { error: 'Некорректная дата рождения' };
  }
  return { value: s };
}

export function formatBirthDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}
