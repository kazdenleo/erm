/**
 * Синхронизация изображений карточки: МП → products.images (с бейджами)
 * и products.images → МП при push (фильтр по бейджам).
 */

import productsService from './products.service.js';
import { downloadImageToProductFolder } from './productImagesImport.service.js';
import logger from '../utils/logger.js';

const MP_KEYS = ['ozon', 'wb', 'ym'];

function normalizeMpKey(marketplace) {
  const m = String(marketplace || '').toLowerCase();
  if (m === 'wildberries') return 'wb';
  if (m === 'yandex' || m === 'yandexmarket') return 'ym';
  if (MP_KEYS.includes(m)) return m;
  return null;
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function urlKey(url) {
  return String(url || '')
    .trim()
    .split(/[?#]/)[0]
    .toLowerCase();
}

function pushUniqueUrl(out, seen, raw) {
  const u = String(raw || '').trim();
  if (!isHttpUrl(u)) return;
  const k = urlKey(u);
  if (!k || seen.has(k)) return;
  seen.add(k);
  out.push(u);
}

function pickUrlFromPhotoObj(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p.trim();
  if (typeof p !== 'object') return '';
  return String(
    p.big ||
      p.hqUrl ||
      p.hq ||
      p.c516x688 ||
      p.c246x328 ||
      p.square ||
      p.tm ||
      p.url ||
      p.src ||
      p.href ||
      ''
  ).trim();
}

/** URL изображений из ответа Ozon product/info. */
export function extractOzonImageUrls(card) {
  if (!card || typeof card !== 'object') return [];
  const out = [];
  const seen = new Set();
  pushUniqueUrl(out, seen, card.primary_image ?? card.primaryImage ?? card.image);
  const images = card.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (typeof item === 'string') pushUniqueUrl(out, seen, item);
      else if (item && typeof item === 'object') {
        pushUniqueUrl(out, seen, item.url ?? item.file_name ?? item.fileName ?? item.src);
      }
    }
  }
  return out;
}

/** URL изображений из карточки WB Content API (photos / mediaFiles). */
export function extractWbImageUrls(card) {
  if (!card || typeof card !== 'object') return [];
  const out = [];
  const seen = new Set();
  const photos = card.photos ?? card.raw?.photos;
  if (Array.isArray(photos)) {
    for (const p of photos) pushUniqueUrl(out, seen, pickUrlFromPhotoObj(p));
  }
  const media = card.mediaFiles ?? card.raw?.mediaFiles;
  if (Array.isArray(media)) {
    for (const p of media) pushUniqueUrl(out, seen, pickUrlFromPhotoObj(p));
  }
  return out;
}

/** URL изображений из карточки Яндекс.Маркет (pictures). */
export function extractYmImageUrls(card) {
  if (!card || typeof card !== 'object') return [];
  const out = [];
  const seen = new Set();
  const pictures =
    card.pictures ||
    card.offer?.pictures ||
    card.raw?.mapping?.offer?.pictures ||
    card.raw?.offerCard?.pictures ||
    [];
  if (Array.isArray(pictures)) {
    for (const p of pictures) {
      if (typeof p === 'string') pushUniqueUrl(out, seen, p);
      else if (p && typeof p === 'object') pushUniqueUrl(out, seen, p.url ?? p.src ?? p.href);
    }
  }
  return out;
}

export function extractMarketplaceImageUrls(marketplace, card) {
  const mp = normalizeMpKey(marketplace);
  if (mp === 'ozon') return extractOzonImageUrls(card);
  if (mp === 'wb') return extractWbImageUrls(card);
  if (mp === 'ym') return extractYmImageUrls(card);
  return [];
}

function badgesForSourceMp(mp) {
  return {
    ozon: mp === 'ozon',
    wb: mp === 'wb',
    ym: mp === 'ym',
  };
}

function ensurePrimary(images) {
  const arr = Array.isArray(images) ? images.map((x) => ({ ...x })) : [];
  if (arr.length === 0) return arr;
  const hasPrimary = arr.some((img) => img?.primary === true);
  if (!hasPrimary) {
    arr[0] = { ...arr[0], primary: true };
  }
  return arr.map((img, i) => ({
    ...img,
    primary: hasPrimary ? img.primary === true : i === 0,
  }));
}

function publicApiBase() {
  return String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').replace(/\/$/, '');
}

/** Абсолютный URL для отдачи на МП (они качают по HTTP). */
export function absoluteProductImageUrl(relativeOrAbsolute) {
  const u = String(relativeOrAbsolute || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const base = publicApiBase();
  if (!base) return u;
  return u.startsWith('/') ? `${base}${u}` : `${base}/${u}`;
}

/**
 * Изображения товара, помеченные для данного МП (бейдж вкл.).
 * Порядок: primary первым, остальные как в массиве.
 */
export function getProductImageUrlsForMarketplace(product, marketplace) {
  const mp = normalizeMpKey(marketplace);
  if (!mp) return [];
  const images = Array.isArray(product?.images) ? product.images : [];
  const filtered = images.filter((img) => {
    if (!img || typeof img !== 'object') return false;
    const flags = img.marketplaces && typeof img.marketplaces === 'object' ? img.marketplaces : {};
    // Как в UI: undefined / отсутствует = включено
    return flags[mp] !== false;
  });
  const primaryIdx = filtered.findIndex((img) => img.primary === true);
  const ordered =
    primaryIdx > 0
      ? [filtered[primaryIdx], ...filtered.filter((_, i) => i !== primaryIdx)]
      : filtered;
  const out = [];
  const seen = new Set();
  for (const img of ordered) {
    const abs = absoluteProductImageUrl(img.url ?? img.href ?? img.src);
    if (!abs || !isHttpUrl(abs)) continue;
    const k = urlKey(abs);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(abs);
  }
  return out;
}

/**
 * Скачать URL с МП в products.images, проставить бейдж источника.
 * Уже известные source_url не качаем повторно — только включаем бейдж.
 *
 * @returns {Promise<{ images: array, added: number, enabled: number, errors: array }>}
 */
export async function mergeMarketplaceImagesIntoProduct(productId, marketplace, urls) {
  const mp = normalizeMpKey(marketplace);
  if (!mp) {
    const err = new Error('Неизвестный маркетплейс для изображений');
    err.statusCode = 400;
    throw err;
  }
  const list = Array.isArray(urls)
    ? [...new Set(urls.map((u) => String(u || '').trim()).filter(isHttpUrl))]
    : [];
  if (list.length === 0) {
    const product = await productsService.getById(productId);
    return {
      images: Array.isArray(product?.images) ? product.images : [],
      added: 0,
      enabled: 0,
      errors: [],
    };
  }

  const product = await productsService.getById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }

  const existing = Array.isArray(product.images) ? product.images.map((x) => ({ ...x })) : [];
  const bySource = new Map();
  for (const img of existing) {
    const src = img?.source_url ? urlKey(img.source_url) : '';
    if (src) bySource.set(src, img);
  }

  let added = 0;
  let enabled = 0;
  const errors = [];
  const hadImages = existing.length > 0;

  for (const url of list) {
    const key = urlKey(url);
    const found = bySource.get(key);
    if (found) {
      const prev =
        found.marketplaces && typeof found.marketplaces === 'object'
          ? {
              ozon: found.marketplaces.ozon !== false,
              wb: found.marketplaces.wb !== false,
              ym: found.marketplaces.ym !== false,
            }
          : { ozon: true, wb: true, ym: true };
      if (prev[mp] !== true) {
        found.marketplaces = { ...prev, [mp]: true };
        enabled += 1;
      }
      continue;
    }

    try {
      const rec = await downloadImageToProductFolder(productId, url, {
        primary: !hadImages && added === 0,
        marketplaces: badgesForSourceMp(mp),
      });
      if (rec) {
        existing.push(rec);
        bySource.set(key, rec);
        added += 1;
      }
    } catch (e) {
      errors.push({ url, message: e?.message || String(e) });
      logger.warn('[MP Images] download failed', { productId, mp, url: url.slice(0, 120), error: e?.message });
    }
  }

  const next = ensurePrimary(existing);
  if (added > 0 || enabled > 0) {
    await productsService.update(String(productId), { images: next });
  }
  return { images: next, added, enabled, errors };
}

/**
 * Импорт изображений из уже загруженной карточки МП (или по списку URL).
 */
export async function importImagesFromMarketplaceCard(productId, marketplace, cardOrUrls) {
  const mp = normalizeMpKey(marketplace);
  let urls = [];
  if (Array.isArray(cardOrUrls)) {
    urls = cardOrUrls;
  } else if (cardOrUrls && typeof cardOrUrls === 'object' && Array.isArray(cardOrUrls.urls)) {
    urls = cardOrUrls.urls;
  } else {
    urls = extractMarketplaceImageUrls(mp, cardOrUrls);
  }
  return mergeMarketplaceImagesIntoProduct(productId, mp, urls);
}
