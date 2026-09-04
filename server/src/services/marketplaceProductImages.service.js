/**
 * Синхронизация изображений карточки: МП → products.images (с бейджами)
 * и products.images → МП при push (фильтр по бейджам).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import productsService from './products.service.js';
import {
  fetchAndNormalizeImageBuffer,
  saveNormalizedImageToProductFolder,
  computeImagePerceptualHash,
  perceptualHashDistance,
  PERCEPTUAL_HASH_MATCH_THRESHOLD,
  isWeakPerceptualHash,
} from './productImagesImport.service.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MP_KEYS = ['ozon', 'wb', 'ym'];
const UPLOADS_PRODUCTS_ROOT = path.resolve(__dirname, '../../uploads/products');

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

function readMarketplacesFlags(img) {
  const flags = img?.marketplaces && typeof img.marketplaces === 'object' ? img.marketplaces : null;
  if (!flags) return { ozon: true, wb: true, ym: true };
  return {
    ozon: flags.ozon !== false && flags.ozon !== 0 && flags.ozon !== '0' && flags.ozon !== 'false',
    wb: flags.wb !== false && flags.wb !== 0 && flags.wb !== '0' && flags.wb !== 'false',
    ym: flags.ym !== false && flags.ym !== 0 && flags.ym !== '0' && flags.ym !== 'false',
  };
}

/**
 * Включить бейдж МП на существующем фото.
 * @returns {boolean} true если флаги реально изменились
 */
function enableMarketplaceBadge(img, mp) {
  const prev = readMarketplacesFlags(img);
  if (prev[mp] === true) return false;
  img.marketplaces = { ...prev, [mp]: true };
  return true;
}

function rememberSourceUrl(img, url, bySource) {
  const key = urlKey(url);
  if (!key) return;
  const trimmed = String(url || '').trim();
  if (!img.source_url) img.source_url = trimmed;
  const alts = Array.isArray(img.source_urls) ? img.source_urls.map(String) : [];
  if (trimmed && urlKey(img.source_url) !== key && !alts.some((u) => urlKey(u) === key)) {
    alts.push(trimmed);
    img.source_urls = alts;
  }
  bySource.set(key, img);
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
  return String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
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
 * Локальный путь uploads по публичному/относительному URL.
 * @returns {{ productId: string, filename: string, absPath: string }|null}
 */
function resolveLocalUploadPath(urlOrPath) {
  const u = String(urlOrPath || '').trim();
  const m = u.match(/\/uploads\/products\/([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  const productId = m[1];
  const filename = m[2];
  const absPath = path.join(UPLOADS_PRODUCTS_ROOT, productId, filename);
  return { productId, filename, absPath };
}

function hashFileSha256(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return '';
  }
}

function buildSourceAndHashIndexes(existing) {
  const bySource = new Map();
  const byHash = new Map();
  for (const img of existing) {
    if (!img || typeof img !== 'object') continue;
    const src = img.source_url ? urlKey(img.source_url) : '';
    if (src) bySource.set(src, img);
    if (Array.isArray(img.source_urls)) {
      for (const u of img.source_urls) {
        const k = urlKey(u);
        if (k) bySource.set(k, img);
      }
    }
    let h = img.content_hash ? String(img.content_hash).trim().toLowerCase() : '';
    if (!h) {
      const local = resolveLocalUploadPath(img.url ?? img.href ?? img.src);
      h = local ? hashFileSha256(local.absPath) : '';
      if (h) img.content_hash = h;
    }
    if (h && !byHash.has(h)) byHash.set(h, img);
  }
  return { bySource, byHash };
}

/**
 * Найти уже сохранённое фото с близким perceptual hash (одна картинка, разный CDN/сжатие).
 * @param {string} phash
 * @param {object[]} existing
 * @param {number} [threshold]
 * @returns {object|null}
 */
function findByPerceptualHash(phash, existing, threshold = PERCEPTUAL_HASH_MATCH_THRESHOLD) {
  const needle = String(phash || '')
    .trim()
    .toLowerCase();
  if (isWeakPerceptualHash(needle)) return null;
  let best = null;
  let bestDist = threshold + 1;
  for (const img of existing) {
    if (!img || typeof img !== 'object') continue;
    const h = String(img.perceptual_hash || '')
      .trim()
      .toLowerCase();
    if (isWeakPerceptualHash(h)) continue;
    const d = perceptualHashDistance(needle, h);
    if (d < bestDist) {
      bestDist = d;
      best = img;
    }
  }
  return bestDist <= threshold ? best : null;
}

function mergeImageMetaInto(target, donor, bySource) {
  if (!target || !donor) return false;
  let changed = false;
  for (const mp of MP_KEYS) {
    if (readMarketplacesFlags(donor)[mp] && enableMarketplaceBadge(target, mp)) changed = true;
  }
  if (donor.primary === true && target.primary !== true) {
    target.primary = true;
    changed = true;
  }
  if (donor.source_url) {
    rememberSourceUrl(target, donor.source_url, bySource);
    changed = true;
  }
  if (Array.isArray(donor.source_urls)) {
    for (const u of donor.source_urls) {
      rememberSourceUrl(target, u, bySource);
      changed = true;
    }
  }
  if (!target.perceptual_hash && donor.perceptual_hash) {
    target.perceptual_hash = donor.perceptual_hash;
    changed = true;
  }
  if (!target.content_hash && donor.content_hash) {
    target.content_hash = donor.content_hash;
    changed = true;
  }
  return changed;
}

function unlinkLocalImageFile(img) {
  const local = resolveLocalUploadPath(img?.url ?? img?.href ?? img?.src);
  if (!local?.absPath) return;
  try {
    if (fs.existsSync(local.absPath)) fs.unlinkSync(local.absPath);
  } catch {
    /* ignore */
  }
}

/**
 * Досчитать perceptual_hash с диска и схлопнуть визуальные дубликаты
 * (OZON+YM и отдельный WB одной картинки → одна запись с тремя бейджами).
 * @returns {Promise<{ images: object[], changed: boolean, collapsed: number }>}
 */
async function backfillAndCollapseVisualDuplicates(existing) {
  const images = Array.isArray(existing) ? existing : [];
  let changed = false;
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    if (img.perceptual_hash) continue;
    const local = resolveLocalUploadPath(img.url ?? img.href ?? img.src);
    if (!local?.absPath || !fs.existsSync(local.absPath)) continue;
    try {
      const buf = fs.readFileSync(local.absPath);
      const ph = await computeImagePerceptualHash(buf);
      if (ph) {
        img.perceptual_hash = ph;
        changed = true;
      }
    } catch {
      /* ignore */
    }
  }

  const bySource = new Map();
  const keep = [];
  let collapsed = 0;
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const match = img.perceptual_hash
      ? findByPerceptualHash(img.perceptual_hash, keep)
      : null;
    if (match) {
      if (mergeImageMetaInto(match, img, bySource)) changed = true;
      unlinkLocalImageFile(img);
      collapsed += 1;
      changed = true;
      continue;
    }
    keep.push(img);
    if (img.source_url) rememberSourceUrl(img, img.source_url, bySource);
    if (Array.isArray(img.source_urls)) {
      for (const u of img.source_urls) rememberSourceUrl(img, u, bySource);
    }
  }
  return { images: keep, changed, collapsed };
}

function isOzonFriendlyImageUrl(url) {
  const base = String(url || '')
    .split(/[?#]/)[0]
    .toLowerCase();
  return base.endsWith('.jpg') || base.endsWith('.jpeg') || base.endsWith('.png');
}

/**
 * Ozon не принимает WebP — конвертируем в JPEG рядом с исходником и отдаём публичный URL.
 * @param {string} absUrl
 * @returns {Promise<string>}
 */
async function ensureJpegUrlForOzon(absUrl) {
  const abs = String(absUrl || '').trim();
  if (!abs || !isHttpUrl(abs)) return '';
  if (isOzonFriendlyImageUrl(abs)) return abs;

  const local = resolveLocalUploadPath(abs);
  if (!local || !fs.existsSync(local.absPath)) {
    logger.warn('[MP Images] Ozon: нет локального файла для конвертации WebP', {
      url: abs.slice(0, 160),
    });
    return abs;
  }

  const stem = local.filename.replace(/\.[^.]+$/, '');
  const jpgName = `${stem}.ozon.jpg`;
  const jpgPath = path.join(UPLOADS_PRODUCTS_ROOT, local.productId, jpgName);
  try {
    const srcStat = fs.statSync(local.absPath);
    const need =
      !fs.existsSync(jpgPath) || fs.statSync(jpgPath).mtimeMs < srcStat.mtimeMs;
    if (need) {
      await sharp(local.absPath).jpeg({ quality: 90, mozjpeg: true }).toFile(jpgPath);
    }
    return absoluteProductImageUrl(`/uploads/products/${local.productId}/${jpgName}`);
  } catch (e) {
    logger.warn('[MP Images] Ozon JPEG convert failed', {
      file: local.filename,
      error: e?.message || String(e),
    });
    return abs;
  }
}

/**
 * Изображения товара, помеченные для данного МП (бейдж вкл.).
 * Порядок: primaryFor[mp] → global primary → как в массиве.
 */
export function getProductImageUrlsForMarketplace(product, marketplace) {
  const mp = normalizeMpKey(marketplace);
  if (!mp) return [];
  let images = product?.images;
  if (typeof images === 'string') {
    try {
      images = JSON.parse(images);
    } catch {
      images = [];
    }
  }
  if (!Array.isArray(images)) images = [];
  const filtered = images.filter((img) => {
    if (!img || typeof img !== 'object') return false;
    const flags = img.marketplaces && typeof img.marketplaces === 'object' ? img.marketplaces : null;
    // Нет объекта marketplaces → как в UI: все МП включены
    if (!flags) return true;
    const v = flags[mp];
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return true;
  });
  const primaryForIdx = filtered.findIndex(
    (img) => img?.primaryFor && typeof img.primaryFor === 'object' && img.primaryFor[mp] === true
  );
  const primaryIdx = filtered.findIndex((img) => img.primary === true);
  const preferredIdx = primaryForIdx >= 0 ? primaryForIdx : primaryIdx;
  const ordered =
    preferredIdx > 0
      ? [filtered[preferredIdx], ...filtered.filter((_, i) => i !== preferredIdx)]
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
 * URL для push: для Ozon WebP/GIF → JPEG.
 * @param {object} product
 * @param {string} marketplace
 * @returns {Promise<string[]>}
 */
export async function getProductImageUrlsForMarketplacePush(product, marketplace) {
  const mp = normalizeMpKey(marketplace);
  const urls = getProductImageUrlsForMarketplace(product, mp);
  if (mp !== 'ozon' || urls.length === 0) return urls;
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    const jpegUrl = await ensureJpegUrlForOzon(u);
    if (!jpegUrl || !isHttpUrl(jpegUrl)) continue;
    const k = urlKey(jpegUrl);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(jpegUrl);
  }
  return out;
}

/**
 * Скачать URL с МП в products.images, проставить бейдж источника.
 * Не дублируем: тот же source_url, content_hash или близкий perceptual hash
 * (одна картинка с разных CDN) — только включаем бейдж МП.
 *
 * @returns {Promise<{ images: array, added: number, enabled: number, collapsed: number, errors: array }>}
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

  const product = await productsService.getById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }

  let existing = Array.isArray(product.images) ? product.images.map((x) => ({ ...x })) : [];
  const collapsedState = await backfillAndCollapseVisualDuplicates(existing);
  existing = collapsedState.images;
  const collapsed = collapsedState.collapsed || 0;

  if (list.length === 0) {
    if (collapsedState.changed) {
      const next = ensurePrimary(existing);
      await productsService.update(String(productId), { images: next });
      return { images: next, added: 0, enabled: 0, collapsed, errors: [] };
    }
    return {
      images: existing,
      added: 0,
      enabled: 0,
      collapsed,
      errors: [],
    };
  }

  const { bySource, byHash } = buildSourceAndHashIndexes(existing);

  let added = 0;
  let enabled = 0;
  const errors = [];
  const hadImages = existing.length > 0;

  for (const url of list) {
    const key = urlKey(url);
    const foundByUrl = bySource.get(key);
    if (foundByUrl) {
      if (enableMarketplaceBadge(foundByUrl, mp)) enabled += 1;
      rememberSourceUrl(foundByUrl, url, bySource);
      continue;
    }

    try {
      const { buf, ext, contentHash, perceptualHash } = await fetchAndNormalizeImageBuffer(url);
      const foundByHash = contentHash ? byHash.get(String(contentHash).toLowerCase()) : null;
      if (foundByHash) {
        if (enableMarketplaceBadge(foundByHash, mp)) enabled += 1;
        rememberSourceUrl(foundByHash, url, bySource);
        if (!foundByHash.content_hash) foundByHash.content_hash = contentHash;
        if (!foundByHash.perceptual_hash && perceptualHash) {
          foundByHash.perceptual_hash = perceptualHash;
        }
        continue;
      }

      const foundByVisual = perceptualHash
        ? findByPerceptualHash(perceptualHash, existing)
        : null;
      if (foundByVisual) {
        if (enableMarketplaceBadge(foundByVisual, mp)) enabled += 1;
        rememberSourceUrl(foundByVisual, url, bySource);
        if (!foundByVisual.perceptual_hash && perceptualHash) {
          foundByVisual.perceptual_hash = perceptualHash;
        }
        if (!foundByVisual.content_hash && contentHash) {
          foundByVisual.content_hash = contentHash;
          byHash.set(String(contentHash).toLowerCase(), foundByVisual);
        }
        continue;
      }

      const rec = saveNormalizedImageToProductFolder(productId, url, buf, ext, {
        primary: !hadImages && added === 0,
        marketplaces: badgesForSourceMp(mp),
        contentHash,
        perceptualHash,
      });
      if (rec) {
        try {
          const { attachImageSizeToRecord } = await import('./productImageAspect.service.js');
          await attachImageSizeToRecord(rec, buf);
        } catch {
          /* ignore */
        }
        existing.push(rec);
        rememberSourceUrl(rec, url, bySource);
        if (contentHash) byHash.set(String(contentHash).toLowerCase(), rec);
        added += 1;
      }
    } catch (e) {
      errors.push({ url, message: e?.message || String(e) });
      logger.warn('[MP Images] download failed', {
        productId,
        mp,
        url: url.slice(0, 120),
        error: e?.message || String(e),
      });
    }
  }

  const next = ensurePrimary(existing);
  if (added > 0 || enabled > 0 || collapsedState.changed) {
    await productsService.update(String(productId), { images: next });
  }
  return { images: next, added, enabled, collapsed, errors };
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

/**
 * Схлопнуть уже сохранённые визуальные дубликаты галереи (бейджи МП объединяются).
 * Можно вызвать без нового импорта с МП.
 */
export async function collapseProductImageDuplicates(productId) {
  const product = await productsService.getById(productId);
  if (!product) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }
  const existing = Array.isArray(product.images) ? product.images.map((x) => ({ ...x })) : [];
  const collapsedState = await backfillAndCollapseVisualDuplicates(existing);
  if (!collapsedState.changed) {
    return {
      images: existing,
      collapsed: 0,
      changed: false,
    };
  }
  const next = ensurePrimary(collapsedState.images);
  await productsService.update(String(productId), { images: next });
  return {
    images: next,
    collapsed: collapsedState.collapsed || 0,
    changed: true,
  };
}
