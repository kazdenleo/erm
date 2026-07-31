/**
 * Часовой пояс профиля (IANA) и локальное время для ночного планировщика.
 */

export const DEFAULT_PROFILE_TIMEZONE = 'Europe/Moscow';

/** Популярные пояса для селекта в настройках. */
export const PROFILE_TIMEZONE_OPTIONS = [
  { value: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
  { value: 'Europe/Moscow', label: 'Москва (UTC+3)' },
  { value: 'Europe/Samara', label: 'Самара (UTC+4)' },
  { value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
  { value: 'Asia/Omsk', label: 'Омск (UTC+6)' },
  { value: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+7)' },
  { value: 'Asia/Irkutsk', label: 'Иркутск (UTC+8)' },
  { value: 'Asia/Yakutsk', label: 'Якутск (UTC+9)' },
  { value: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
  { value: 'Asia/Magadan', label: 'Магадан (UTC+11)' },
  { value: 'Asia/Kamchatka', label: 'Камчатка (UTC+12)' },
  { value: 'Asia/Almaty', label: 'Алматы (UTC+5)' },
  { value: 'Asia/Tashkent', label: 'Ташкент (UTC+5)' },
  { value: 'Asia/Baku', label: 'Баку (UTC+4)' },
  { value: 'Europe/Minsk', label: 'Минск (UTC+3)' },
  { value: 'Europe/Kyiv', label: 'Киев (UTC+2/3)' },
  { value: 'Asia/Tbilisi', label: 'Тбилиси (UTC+4)' },
  { value: 'Asia/Yerevan', label: 'Ереван (UTC+4)' },
];

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeProfileTimezone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return DEFAULT_PROFILE_TIMEZONE;
  try {
    // Throws RangeError for invalid IANA names in modern Node.
    Intl.DateTimeFormat('en-US', { timeZone: s }).format(new Date());
    return s;
  } catch {
    return DEFAULT_PROFILE_TIMEZONE;
  }
}

/**
 * @param {Date} [now]
 * @param {string} timeZone
 * @returns {{ ymd: string, hour: number, minute: number, minutesOfDay: number }}
 */
export function getZonedClockParts(now = new Date(), timeZone = DEFAULT_PROFILE_TIMEZONE) {
  const tz = normalizeProfileTimezone(timeZone);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const ymd = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    ymd,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

/**
 * Извлечь час/минуту из cron вида "M H * * *" (остальное игнорируем).
 * @param {string} cronExpr
 * @param {{ hour: number, minute: number }} fallback
 */
export function parseDailyCronHm(cronExpr, fallback) {
  const parts = String(cronExpr || '')
    .trim()
    .split(/\s+/);
  if (parts.length < 2) return { ...fallback };
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return { ...fallback };
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return { ...fallback };
  return { hour, minute };
}

/**
 * Попадание в окно запуска (по умолчанию 5 минут после целевого HH:MM).
 */
export function isInLocalDailyWindow(clock, targetHm, windowMinutes = 5) {
  const target = targetHm.hour * 60 + targetHm.minute;
  const now = clock.minutesOfDay;
  const win = Math.max(1, Number(windowMinutes) || 5);
  return now >= target && now < target + win;
}
