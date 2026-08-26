/**
 * Изображения товара из JSON (поле images): первая картинка в списке = основная для превью.
 */

export function parseProductImages(images) {
  if (!images) return [];
  if (Array.isArray(images)) return images;
  if (typeof images === 'string') {
    try {
      const p = JSON.parse(images);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Порядок в массиве = порядок на карточке; первый элемент — главное фото. */
export function normalizeProductImagesOrder(images) {
  const arr = Array.isArray(images) ? [...images] : [];
  if (arr.length === 0) return [];
  const primIdx = arr.findIndex((i) => i?.primary === true);
  let ordered;
  if (primIdx > 0) {
    const p = arr[primIdx];
    ordered = [...arr.slice(0, primIdx), ...arr.slice(primIdx + 1)];
    ordered.unshift(p);
  } else {
    ordered = [...arr];
  }
  return ordered.map((img, i) => ({ ...img, primary: i === 0 }));
}

/** Ответ { data: Image[] } от upload/delete/getImages или уже массив */
export function extractImagesFromApiPayload(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function filterDroppedImageFiles(fileList) {
  return Array.from(fileList || []).filter(
    (f) => typeof f?.type === 'string' && f.type.startsWith('image/')
  );
}

export function resolveProductImageUrl(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return '';
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('data:')) return t;
  if (t.startsWith('/')) return t;
  return `/${t.replace(/^\//, '')}`;
}

/**
 * URL основного изображения для миниатюры в списке.
 * @param {Record<string, unknown>|null|undefined} product
 * @returns {string} пустая строка, если нет
 */
export function getPrimaryProductImageUrl(product) {
  const list = parseProductImages(product?.images);
  if (list.length === 0) return '';

  const withUrl = (img) => {
    if (!img || typeof img !== 'object') return '';
    const raw = img.url ?? img.src ?? img.link ?? '';
    return typeof raw === 'string' ? raw.trim() : '';
  };

  const primary = list.find(
    (img) => img && (img.primary === true || img.is_main === true) && withUrl(img)
  );
  const chosen = primary || list.find((img) => withUrl(img));
  return resolveProductImageUrl(chosen ? withUrl(chosen) : '');
}

/** Можно вернуть исходный файл после «Сделать 3:4». */
export function canRestoreImageAspect3x4(img) {
  if (!img || typeof img !== 'object') return false;
  if (img.aspect_3x4 !== true) return false;
  return String(img.aspect_3x4_from || '').trim().length > 0;
}

/** Целевое соотношение сторон карточки маркетплейса (ширина / высота). */
export const PRODUCT_IMAGE_ASPECT_3X4 = 3 / 4;
/** Допуск на округление пикселей (~2% от 0.75). */
export const PRODUCT_IMAGE_ASPECT_3X4_TOLERANCE = 0.02;

export function productImageDisplayUrl(img) {
  if (!img || typeof img !== 'object') return '';
  const raw = img.url ?? img.src ?? img.link ?? '';
  return resolveProductImageUrl(typeof raw === 'string' ? raw.trim() : '');
}

/**
 * @param {unknown} width
 * @param {unknown} height
 * @returns {boolean|null} true = 3:4, false = другое, null = неизвестно
 */
export function isSizeRatio3x4(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return Math.abs(w / h - PRODUCT_IMAGE_ASPECT_3X4) <= PRODUCT_IMAGE_ASPECT_3X4_TOLERANCE;
}

/**
 * По метаданным записи изображения (без загрузки файла).
 * @returns {boolean|null}
 */
export function imageMetaIs3x4(img) {
  if (!img || typeof img !== 'object') return null;
  if (img.aspect_3x4 === true) return true;
  return isSizeRatio3x4(img.width, img.height);
}

export function imagesAspectFingerprint(images) {
  return parseProductImages(images)
    .map((img) =>
      [
        img?.id ?? '',
        img?.filename ?? '',
        img?.url ?? img?.src ?? img?.link ?? '',
        img?.width ?? '',
        img?.height ?? '',
        img?.aspect_3x4 === true ? '1' : '0',
      ].join(':')
    )
    .join('|');
}
