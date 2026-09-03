/**
 * Шаблон видеообложки Ozon: слайды из фото карточки + эффект перехода.
 * Атрибут Ozon: 21845, complex_id 100002.
 */

export const OZON_VIDEO_COVER_ATTR_ID = 21845;
export const OZON_VIDEO_COVER_COMPLEX_ID = 100002;

export const VIDEO_COVER_TRANSITIONS = Object.freeze([
  { id: 'fade', label: 'Проявление (fade)' },
  { id: 'slide_left', label: 'Сдвиг влево' },
  { id: 'slide_right', label: 'Сдвиг вправо' },
  { id: 'zoom_in', label: 'Приближение' },
  { id: 'zoom_out', label: 'Отдаление' },
  { id: 'none', label: 'Без перехода' },
]);

const TRANSITION_IDS = new Set(VIDEO_COVER_TRANSITIONS.map((t) => t.id));

export function defaultVideoCoverSettings() {
  return {
    maxSlides: 5,
    slideDurationMs: 1800,
    transition: 'fade',
    transitionMs: 500,
    aspectRatio: '3:4',
    width: 900,
    height: 1200,
    skipFirst: false,
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeVideoCoverSettings(raw) {
  const base = defaultVideoCoverSettings();
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const transition = TRANSITION_IDS.has(String(src.transition || ''))
    ? String(src.transition)
    : base.transition;
  return {
    maxSlides: clampInt(src.maxSlides, 1, 10, base.maxSlides),
    slideDurationMs: clampInt(src.slideDurationMs, 400, 8000, base.slideDurationMs),
    transition,
    transitionMs: clampInt(src.transitionMs, 0, 3000, base.transitionMs),
    aspectRatio: src.aspectRatio === '1:1' || src.aspectRatio === '16:9' ? src.aspectRatio : '3:4',
    width: clampInt(src.width, 400, 1600, base.width),
    height: clampInt(src.height, 400, 2000, base.height),
    skipFirst: src.skipFirst === true,
  };
}

/**
 * @param {string[]} imageUrls
 * @param {ReturnType<typeof normalizeVideoCoverSettings>} settings
 * @returns {string[]}
 */
export function pickVideoCoverSlideUrls(imageUrls, settings) {
  const list = (Array.isArray(imageUrls) ? imageUrls : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  const start = settings.skipFirst && list.length > 1 ? 1 : 0;
  return list.slice(start, start + settings.maxSlides);
}

export function isOzonVideoCoverAttrId(id) {
  return Number(id) === OZON_VIDEO_COVER_ATTR_ID;
}
