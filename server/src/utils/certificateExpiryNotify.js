/**
 * Расписание уведомлений об окончании сертификата:
 * - за 6 месяцев (≤180 дн.) — первое уведомление;
 * - далее раз в месяц (~28+ дней между уведомлениями);
 * - последний месяц (≤30 дн.) — каждый день;
 * - после истечения — каждый день, пока сертификат не обновят.
 */

export const CERT_EXPIRY_WARN_DAYS = 180;
export const CERT_EXPIRY_DAILY_DAYS = 30;
export const CERT_EXPIRY_MONTHLY_GAP_DAYS = 28;

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Дата сертификата → YYYY-MM-DD. pg отдаёт DATE как Date в локальную полночь,
 * поэтому берём локальные компоненты (как daysUntilDate).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function certificateDateOnly(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw).trim());
  return iso ? iso[1] : null;
}

/**
 * @param {unknown} rawDate YYYY-MM-DD | Date | ISO
 * @param {Date} [now]
 * @returns {number|null} дней до даты (отрицательное = уже прошло)
 */
export function daysUntilDate(rawDate, now = new Date()) {
  if (rawDate == null || rawDate === '') return null;
  let d;
  if (rawDate instanceof Date) {
    if (Number.isNaN(rawDate.getTime())) return null;
    d = startOfDay(rawDate);
  } else {
    const s = String(rawDate).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    } else {
      const parsed = new Date(s);
      if (Number.isNaN(parsed.getTime())) return null;
      d = startOfDay(parsed);
    }
  }
  const today = startOfDay(now);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/**
 * Календарные дни между двумя датами (по полуночи).
 * @param {Date|string|null|undefined} from
 * @param {Date} [to]
 */
export function calendarDaysBetween(from, to = new Date()) {
  if (from == null || from === '') return null;
  const a = from instanceof Date ? startOfDay(from) : startOfDay(new Date(from));
  if (Number.isNaN(a.getTime())) return null;
  const b = startOfDay(to);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Нужно ли показать уведомление сейчас (с учётом последнего показа).
 * @param {{ daysLeft: number|null|undefined, lastNotifiedAt?: Date|string|null, now?: Date }} opts
 */
export function shouldEmitCertificateExpiryNotification({
  daysLeft,
  lastNotifiedAt = null,
  now = new Date(),
} = {}) {
  if (daysLeft == null || !Number.isFinite(Number(daysLeft))) return false;
  const d = Number(daysLeft);
  if (d > CERT_EXPIRY_WARN_DAYS) return false;

  const gap = calendarDaysBetween(lastNotifiedAt, now);

  // Истёк или последний месяц — ежедневно
  if (d < 0 || d <= CERT_EXPIRY_DAILY_DAYS) {
    if (lastNotifiedAt == null || lastNotifiedAt === '') return true;
    return gap == null || gap >= 1;
  }

  // 31…180: раз в месяц (первый раз сразу при входе в окно)
  if (lastNotifiedAt == null || lastNotifiedAt === '') return true;
  return gap == null || gap >= CERT_EXPIRY_MONTHLY_GAP_DAYS;
}

/**
 * Текст для UI / уведомления.
 * @param {number} daysLeft
 */
export function certificateExpiryPhaseLabel(daysLeft) {
  if (daysLeft == null || !Number.isFinite(Number(daysLeft))) return '';
  const d = Number(daysLeft);
  if (d < 0) return 'Истёк';
  if (d === 0) return 'Истекает сегодня';
  if (d <= CERT_EXPIRY_DAILY_DAYS) return `Истекает через ${d} дн.`;
  const months = Math.max(1, Math.round(d / 30));
  return `Истекает через ~${months} мес.`;
}

/**
 * Ключ периода для id уведомления:
 * последний месяц / истёк — день; иначе в окне 6 мес. — календарный месяц.
 * После dismiss тот же id скрыт; новый период = новое уведомление по расписанию.
 * @param {number} daysLeft
 * @param {Date} [now]
 */
export function certificateNotifyPeriodKey(daysLeft, now = new Date()) {
  if (daysLeft == null || !Number.isFinite(Number(daysLeft))) return null;
  const d = Number(daysLeft);
  if (d > CERT_EXPIRY_WARN_DAYS) return null;
  if (d < 0 || d <= CERT_EXPIRY_DAILY_DAYS) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
