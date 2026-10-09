export const SETTLEMENT_OPERATION_LABELS = {
  receipt: 'Приёмка товара',
  return: 'Возврат поставщику',
  payment: 'Оплата поставщику',
  adjustment: 'Корректировка',
};

export function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

/** Баланс > 0 — мы должны поставщику, < 0 — переплата (поставщик должен нам). */
export function describeBalance(balance) {
  const n = Number(balance) || 0;
  if (Math.abs(n) < 0.005) return { label: 'Расчёты закрыты', amount: 0, tone: 'neutral' };
  if (n > 0) return { label: 'Наш долг', amount: n, tone: 'debt' };
  return { label: 'Переплата', amount: -n, tone: 'credit' };
}

/** «1 234,5» / «-100» → число; пустая строка → NaN. */
export function parseMoneyInput(value) {
  const s = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
}

export function todayIsoDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
