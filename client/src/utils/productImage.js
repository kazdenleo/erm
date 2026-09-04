/**
 * Изображения товара из JSON (поле images): первая картинка в списке = основная для превью ERP.
 * Главная на МП — отдельно: `primaryFor: { ozon?, wb?, ym? }` (не больше одной на маркетплейс).
 */

export const PRODUCT_IMAGE_MP_KEYS = ['ozon', 'wb', 'ym'];

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

function mpFlagOn(flags, mp) {
  if (!flags || typeof flags !== 'object') return true;
  const v = flags[mp];
  return !(v === false || v === 0 || v === '0' || v === 'false');
}

/** Бейдж МП включён (нет объекта marketplaces → все включены). */
export function imageHasMarketplace(img, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  if (!PRODUCT_IMAGE_MP_KEYS.includes(mp)) return false;
  if (!img || typeof img !== 'object') return false;
  return mpFlagOn(img.marketplaces, mp);
}

export function imageIsExplicitPrimaryForMp(img, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  if (!img || typeof img !== 'object') return false;
  const pf = img.primaryFor;
  return !!(pf && typeof pf === 'object' && pf[mp] === true);
}

/**
 * У МП уже есть главная: явный primaryFor, иначе глобальная primary (первая) с этим бейджем.
 * Если глобальная без этого МП — главной ещё нет (можно назначить ★ на другом фото).
 */
export function marketplaceHasPrimaryImage(images, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  const list = Array.isArray(images) ? images : [];
  if (list.some((img) => imageHasMarketplace(img, mp) && imageIsExplicitPrimaryForMp(img, mp))) {
    return true;
  }
  const globalPrimary = list.find((img) => img?.primary === true) || list[0];
  return !!(globalPrimary && imageHasMarketplace(globalPrimary, mp));
}

/** Картинка — главная для МП (явная, глобальная с бейджем, иначе первая с бейджем). */
export function imageIsPrimaryForMarketplace(images, imageId, marketplace) {
  const mp = String(marketplace || '').toLowerCase();
  const list = Array.isArray(images) ? images : [];
  const id = String(imageId ?? '');
  const img = list.find((x) => String(x?.id ?? x?.filename ?? '') === id);
  if (!img || !imageHasMarketplace(img, mp)) return false;

  const withMp = list.filter((x) => imageHasMarketplace(x, mp));
  const explicit = withMp.find((x) => imageIsExplicitPrimaryForMp(x, mp));
  if (explicit) {
    return String(explicit?.id ?? explicit?.filename ?? '') === id;
  }
  const globalPrimary = list.find((x) => x?.primary === true) || list[0];
  if (globalPrimary && imageHasMarketplace(globalPrimary, mp)) {
    return String(globalPrimary?.id ?? globalPrimary?.filename ?? '') === id;
  }
  const first = withMp[0];
  return String(first?.id ?? first?.filename ?? '') === id;
}

/** МП этого фото, у которых ещё нет главной на карточке (можно забрать ★). */
export function claimablePrimaryMarketplaces(images, imageId) {
  const list = Array.isArray(images) ? images : [];
  const id = String(imageId ?? '');
  const img = list.find((x) => String(x?.id ?? x?.filename ?? '') === id);
  if (!img) return [];
  return PRODUCT_IMAGE_MP_KEYS.filter(
    (mp) => imageHasMarketplace(img, mp) && !marketplaceHasPrimaryImage(list, mp)
  );
}

/**
 * Сделать фото главным для указанных МП (или для всех «свободных»).
 * Не двигает порядок массива / ERP-primary.
 */
export function assignImagePrimaryForMarketplaces(images, imageId, marketplaces = null) {
  const list = (Array.isArray(images) ? images : []).map((img) => ({
    ...img,
    marketplaces: img?.marketplaces && typeof img.marketplaces === 'object' ? { ...img.marketplaces } : img?.marketplaces,
    primaryFor:
      img?.primaryFor && typeof img.primaryFor === 'object' ? { ...img.primaryFor } : undefined,
  }));
  const id = String(imageId ?? '');
  const target = list.find((x) => String(x?.id ?? x?.filename ?? '') === id);
  if (!target) return Array.isArray(images) ? images : [];

  const mps =
    Array.isArray(marketplaces) && marketplaces.length
      ? marketplaces.map((m) => String(m).toLowerCase()).filter((m) => PRODUCT_IMAGE_MP_KEYS.includes(m))
      : claimablePrimaryMarketplaces(list, id);
  if (!mps.length) return Array.isArray(images) ? images : [];

  for (const mp of mps) {
    if (!imageHasMarketplace(target, mp)) continue;
    if (marketplaceHasPrimaryImage(list, mp) && !imageIsExplicitPrimaryForMp(target, mp)) continue;
    for (const img of list) {
      if (!img.primaryFor) continue;
      if (img.primaryFor[mp]) {
        const next = { ...img.primaryFor };
        delete next[mp];
        img.primaryFor = Object.keys(next).length ? next : undefined;
      }
    }
    target.primaryFor = { ...(target.primaryFor || {}), [mp]: true };
  }
  return list;
}

/** При выключении бейджа МП сбрасываем primaryFor для него. */
export function patchImageMarketplaces(images, imageId, patch) {
  const list = (Array.isArray(images) ? images : []).map((img) => {
    const id = String(img?.id ?? img?.filename ?? '');
    if (id !== String(imageId)) return img;
    const marketplaces = { ...(img.marketplaces || {}), ...(patch || {}) };
    let primaryFor =
      img.primaryFor && typeof img.primaryFor === 'object' ? { ...img.primaryFor } : undefined;
    if (primaryFor) {
      for (const mp of PRODUCT_IMAGE_MP_KEYS) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, mp) && patch[mp] === false) {
          delete primaryFor[mp];
        }
      }
      if (!Object.keys(primaryFor).length) primaryFor = undefined;
    }
    return { ...img, marketplaces, primaryFor };
  });
  return list;
}

export function imageHasAnyExplicitPrimaryFor(img) {
  if (!img?.primaryFor || typeof img.primaryFor !== 'object') return false;
  return PRODUCT_IMAGE_MP_KEYS.some((mp) => img.primaryFor[mp] === true);
}
