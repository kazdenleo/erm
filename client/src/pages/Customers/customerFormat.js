export function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU');
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

/** Дата рождения YYYY-MM-DD → ДД.ММ.ГГГГ без сдвига часового пояса. */
export function formatBirthday(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
}

export function phoneHref(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  return d ? `tel:${d}` : null;
}
