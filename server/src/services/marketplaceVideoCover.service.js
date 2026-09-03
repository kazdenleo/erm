/**
 * Генерация слайдов видеообложки Ozon из фото карточки.
 * Результат: JPEG-слайды + метаданные эффекта; URL обложки для атрибута 21845.
 * Превью переходов — на клиенте (CSS); при пуше URL уходит в complex_attributes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { categoryVideoCoverTemplatesRepository } from '../repositories/categoryVideoCoverTemplates.repository.pg.js';
import productsService from './products.service.js';
import {
  absoluteProductImageUrl,
  getProductImageUrlsForMarketplace,
} from './marketplaceProductImages.service.js';
import {
  normalizeVideoCoverSettings,
  pickVideoCoverSlideUrls,
  OZON_VIDEO_COVER_ATTR_ID,
} from '../utils/videoCoverTemplate.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_COVERS_ROOT = path.resolve(__dirname, '../../uploads/video-covers');

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) return { ...o };
    } catch {
      /* ignore */
    }
  }
  return {};
}

async function loadImageBuffer(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('Пустой URL изображения');
  const local = u.match(/\/uploads\/products\/([^/]+)\/([^/?#]+)/i);
  if (local) {
    const abs = path.resolve(__dirname, '../../uploads/products', local[1], local[2]);
    if (fs.existsSync(abs)) return fs.readFileSync(abs);
  }
  const coverLocal = u.match(/\/uploads\/video-covers\/([^/]+)\/([^/?#]+)/i);
  if (coverLocal) {
    const abs = path.resolve(UPLOADS_COVERS_ROOT, coverLocal[1], coverLocal[2]);
    if (fs.existsSync(abs)) return fs.readFileSync(abs);
  }
  const res = await fetch(u, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Не удалось скачать изображение (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {object} product
 * @param {object|null} draftSettings
 * @param {number|null} profileId
 */
export async function resolveVideoCoverSettingsForProduct(product, draftSettings, profileId) {
  if (draftSettings != null) return normalizeVideoCoverSettings(draftSettings);
  if (product?.video_cover_template != null) {
    return normalizeVideoCoverSettings(product.video_cover_template);
  }
  const categoryId = product?.user_category_id ?? product?.category_id ?? null;
  const tpl = await categoryVideoCoverTemplatesRepository.findEffectiveForCategory(
    categoryId,
    profileId
  );
  if (tpl?.settings) {
    return {
      ...normalizeVideoCoverSettings(tpl.settings),
      _source: tpl.source || 'category',
    };
  }
  return null;
}

/**
 * Есть ли шаблон у товара или его категории (для кнопок в UI).
 */
export async function hasVideoCoverTemplateForProduct(product, profileId) {
  const s = await resolveVideoCoverSettingsForProduct(product, null, profileId);
  return Boolean(s);
}

/**
 * @returns {Promise<object>}
 */
export async function generateProductVideoCover(productId, options = {}) {
  const profileId = options.profileId ?? null;
  const productPatch =
    options.productPatch && typeof options.productPatch === 'object' ? options.productPatch : {};

  const product = await productsService.getById(productId, { profileId });
  if (!product?.id) {
    const err = new Error('Товар не найден');
    err.statusCode = 404;
    throw err;
  }

  const merged = {
    ...product,
    ...productPatch,
    images: productPatch.images !== undefined ? productPatch.images : product.images,
    video_cover_template:
      productPatch.video_cover_template !== undefined
        ? productPatch.video_cover_template
        : product.video_cover_template,
  };

  const settings = await resolveVideoCoverSettingsForProduct(
    merged,
    options.settings ?? null,
    profileId
  );
  if (!settings) {
    const err = new Error(
      'Шаблон видеообложки не задан. Настройте шаблон для категории или этого товара.'
    );
    err.statusCode = 400;
    throw err;
  }

  const imageUrls = getProductImageUrlsForMarketplace(merged, 'ozon');
  const slideUrls = pickVideoCoverSlideUrls(imageUrls, settings);
  if (!slideUrls.length) {
    const err = new Error('У товара нет изображений для видеообложки (вкл. для Ozon)');
    err.statusCode = 400;
    throw err;
  }

  const outDir = path.join(UPLOADS_COVERS_ROOT, String(product.id));
  ensureDir(outDir);

  const savedSlideRels = [];
  for (let i = 0; i < slideUrls.length; i++) {
    try {
      const buf = await loadImageBuffer(slideUrls[i]);
      const name = `slide_${String(i + 1).padStart(2, '0')}.jpg`;
      const abs = path.join(outDir, name);
      await sharp(buf)
        .rotate()
        .resize(settings.width, settings.height, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90, mozjpeg: true })
        .toFile(abs);
      savedSlideRels.push(`/uploads/video-covers/${product.id}/${name}`);
    } catch (e) {
      logger.warn('[VideoCover] slide save failed', {
        productId: product.id,
        i,
        error: e?.message || String(e),
      });
    }
  }
  if (!savedSlideRels.length) {
    const err = new Error('Не удалось подготовить слайды обложки');
    err.statusCode = 500;
    throw err;
  }

  // Обложка для атрибута: первый слайд (webp). Переходы — в превью ERP; Ozon ждёт URL файла.
  const coverName = 'cover.webp';
  const coverAbs = path.join(outDir, coverName);
  await sharp(path.join(outDir, path.basename(savedSlideRels[0])))
    .webp({ quality: 88 })
    .toFile(coverAbs);
  const coverRel = `/uploads/video-covers/${product.id}/${coverName}`;
  const coverPublicUrl = absoluteProductImageUrl(coverRel);

  const slidesPayload = {
    settings: normalizeVideoCoverSettings(settings),
    slides: savedSlideRels.map((url, index) => ({
      index,
      url,
      publicUrl: absoluteProductImageUrl(url),
    })),
    coverUrl: coverRel,
    coverPublicUrl,
    generatedAt: new Date().toISOString(),
    source: product.video_cover_template != null ? 'product' : settings._source || 'category_or_shared',
  };

  const ozonAttrs = parseJsonObject(merged.ozon_attributes);
  const attrValue =
    coverPublicUrl && /^https?:\/\//i.test(coverPublicUrl) ? coverPublicUrl : coverRel;
  ozonAttrs[String(OZON_VIDEO_COVER_ATTR_ID)] = attrValue;

  const updated = await productsService.update(
    product.id,
    {
      video_cover_slides: slidesPayload,
      ozon_attributes: ozonAttrs,
    },
    { profileId }
  );

  return {
    settings: slidesPayload.settings,
    slides: slidesPayload,
    ozonAttributeValue: attrValue,
    coverUrl: coverRel,
    coverPublicUrl,
    product: updated,
    source: slidesPayload.source,
  };
}
