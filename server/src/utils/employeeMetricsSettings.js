/**
 * Настройки показателей сотрудников (на уровне profile): пороги перерыва между сканами, сек.
 * Промежуток между соседними сканами длиннее порога — сотрудник отошёл, время не засчитывается.
 */

export const EMPLOYEE_IDLE_DEFAULTS_SEC = {
  fbs: 180,
  fboCollect: 60,
  packing: 180,
  receipts: 180,
};

export const EMPLOYEE_IDLE_KEYS = Object.keys(EMPLOYEE_IDLE_DEFAULTS_SEC);

const IDLE_MIN_SEC = 10;
const IDLE_MAX_SEC = 60 * 60;

function parseObject(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function clampIdle(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(IDLE_MAX_SEC, Math.max(IDLE_MIN_SEC, Math.round(n)));
}

/** @returns {{ idleSec: { fbs: number, fboCollect: number, packing: number, receipts: number } }} */
export function parseEmployeeMetricsSettings(raw) {
  const src = parseObject(raw);
  const idle = parseObject(src.idleSec ?? src.idle_sec);
  return {
    idleSec: Object.fromEntries(
      EMPLOYEE_IDLE_KEYS.map((k) => [k, clampIdle(idle[k], EMPLOYEE_IDLE_DEFAULTS_SEC[k])])
    ),
  };
}
