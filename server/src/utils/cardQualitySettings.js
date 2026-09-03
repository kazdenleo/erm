/**
 * Настройки качества карточек маркетплейсов (на уровне profile).
 */

export const CARD_QUALITY_MARKETPLACES = ['ozon', 'wb', 'ym'];
export const CARD_QUALITY_DEFAULT_THRESHOLD = 70;
export const CARD_QUALITY_MIN = 0;
export const CARD_QUALITY_MAX = 100;

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

function parseBoolFlag(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return defaultValue;
}

function clampThreshold(value, fallback = CARD_QUALITY_DEFAULT_THRESHOLD) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CARD_QUALITY_MAX, Math.max(CARD_QUALITY_MIN, Math.round(n)));
}

export function parseCardQualitySettings(raw) {
  const src = parseObject(raw);
  const th = parseObject(src.thresholds ?? src.threshold);
  return {
    showInCardWork: parseBoolFlag(src.showInCardWork ?? src.show_in_card_work, false),
    thresholds: {
      ozon: clampThreshold(th.ozon, CARD_QUALITY_DEFAULT_THRESHOLD),
      wb: clampThreshold(th.wb, CARD_QUALITY_DEFAULT_THRESHOLD),
      ym: clampThreshold(th.ym, CARD_QUALITY_DEFAULT_THRESHOLD),
    },
  };
}

export function mergeCardQualitySettings(current, incoming) {
  const base = parseCardQualitySettings(current);
  const patch = incoming && typeof incoming === 'object' ? incoming : {};
  const next = {
    showInCardWork: base.showInCardWork,
    thresholds: { ...base.thresholds },
  };
  if (patch.showInCardWork !== undefined || patch.show_in_card_work !== undefined) {
    next.showInCardWork = parseBoolFlag(patch.showInCardWork ?? patch.show_in_card_work, next.showInCardWork);
  }
  const th = patch.thresholds ?? patch.threshold;
  if (th && typeof th === 'object') {
    for (const mp of CARD_QUALITY_MARKETPLACES) {
      if (th[mp] !== undefined && th[mp] !== null && th[mp] !== '') {
        next.thresholds[mp] = clampThreshold(th[mp], next.thresholds[mp]);
      }
    }
  }
  for (const mp of CARD_QUALITY_MARKETPLACES) {
    const flat = patch[`threshold_${mp}`] ?? patch[`threshold${mp[0].toUpperCase()}${mp.slice(1)}`];
    if (flat !== undefined && flat !== null && flat !== '') {
      next.thresholds[mp] = clampThreshold(flat, next.thresholds[mp]);
    }
  }
  return next;
}

export function isCardQualityBelowThreshold(score, threshold) {
  const s = Number(score);
  const t = Number(threshold);
  if (!Number.isFinite(s) || !Number.isFinite(t)) return false;
  return s < t;
}
