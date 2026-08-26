/**
 * Приведение фото товара к соотношению 3:4 (портрет).
 * Исходное изображение не уменьшается — только поля цветом фона до 3:4.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET_RATIO = 3 / 4;
const UPLOADS_PRODUCTS_ROOT = path.resolve(__dirname, '../../uploads/products');

function normalizeImageSize(w, h) {
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export async function readImageSizeFromPath(absPath) {
  if (!absPath) return null;
  try {
    const meta = await sharp(absPath).metadata();
    return normalizeImageSize(meta.width, meta.height);
  } catch {
    return null;
  }
}

export async function readImageSizeFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  try {
    const meta = await sharp(buf).metadata();
    return normalizeImageSize(meta.width, meta.height);
  } catch {
    return null;
  }
}

export async function attachImageSizeToRecord(rec, source) {
  if (!rec || typeof rec !== 'object') return rec;
  const size = Buffer.isBuffer(source)
    ? await readImageSizeFromBuffer(source)
    : await readImageSizeFromPath(source);
  if (size) {
    rec.width = size.width;
    rec.height = size.height;
  }
  return rec;
}

/**
 * @param {Buffer} inputBuf
 * @param {{ outLongSide?: number|null }} [opts]
 * @returns {Promise<{ buffer: Buffer, meta: object }>}
 */
export async function fitImageBufferTo3x4(inputBuf, opts = {}) {
  // По умолчанию не меняем разрешение — только дополняем фон.
  const outLongSide = opts.outLongSide === undefined ? null : opts.outLongSide;

  const { data, info } = await sharp(inputBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const idx = (x, y) => (y * w + x) * ch;

  const corner = Math.max(4, Math.min(12, Math.floor(h / 8), Math.floor(w / 8)));
  const samples = [];
  const pushPatch = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = idx(x, y);
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  };
  pushPatch(0, 0, corner, corner);
  pushPatch(w - corner, 0, w, corner);
  pushPatch(0, h - corner, corner, h);
  pushPatch(w - corner, h - corner, w, h);
  const bg = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const vals = samples.map((s) => s[c]).sort((a, b) => a - b);
    bg[c] = vals[Math.floor(vals.length / 2)] ?? 255;
  }

  const srcRatio = w / Math.max(1, h);
  let canvasW;
  let canvasH;
  if (srcRatio > TARGET_RATIO) {
    // Шире 3:4 — добавляем поля сверху/снизу.
    canvasW = w;
    canvasH = Math.round(w / TARGET_RATIO);
  } else {
    // Уже или уже 3:4 — добавляем поля слева/справа.
    canvasH = h;
    canvasW = Math.round(h * TARGET_RATIO);
  }

  const pasteX = Math.round((canvasW - w) / 2);
  const pasteY = Math.round((canvasH - h) / 2);

  let outPipeline = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: bg[0], g: bg[1], b: bg[2] },
    },
  }).composite([{ input: inputBuf, left: pasteX, top: pasteY }]);

  if (outLongSide && Math.max(canvasW, canvasH) !== outLongSide) {
    let nw;
    let nh;
    if (canvasH >= canvasW) {
      nh = outLongSide;
      nw = Math.round(nh * TARGET_RATIO);
    } else {
      nw = outLongSide;
      nh = Math.round(nw / TARGET_RATIO);
    }
    outPipeline = outPipeline.resize(nw, nh, { fit: 'fill' });
  }

  const buffer = await outPipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  const metaOut = await sharp(buffer).metadata();

  return {
    buffer,
    meta: {
      src: { w, h },
      canvas: { w: canvasW, h: canvasH },
      out: { w: metaOut.width, h: metaOut.height },
      ratio: metaOut.width && metaOut.height ? metaOut.width / metaOut.height : null,
      bg,
      paste: { x: pasteX, y: pasteY },
      mode: 'pad-only',
    },
  };
}

function resolveLocalImagePath(productId, image) {
  const filename = String(image?.filename || image?.id || '').trim();
  const url = String(image?.url || '').trim();
  let name = filename;
  if (!name && url.includes('/uploads/products/')) {
    name = url.split('/').pop() || '';
  }
  if (!name) return null;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const abs = path.join(UPLOADS_PRODUCTS_ROOT, String(productId), name);
  if (!abs.startsWith(UPLOADS_PRODUCTS_ROOT)) return null;
  if (!fs.existsSync(abs)) return null;
  return { abs, filename: name };
}

/**
 * Привести одно локальное изображение товара к 3:4, перезаписать файл (jpg).
 * @returns {Promise<{ images: array, meta: object }>}
 */
export async function fitProductImageTo3x4(productId, imageId, images, opts = {}) {
  const list = Array.isArray(images) ? images.map((x) => ({ ...x })) : [];
  const idStr = String(imageId || '');
  const idx = list.findIndex(
    (img) => String(img?.id || '') === idStr || String(img?.filename || '') === idStr
  );
  if (idx < 0) {
    const err = new Error('Изображение не найдено');
    err.statusCode = 404;
    throw err;
  }
  const local = resolveLocalImagePath(productId, list[idx]);
  if (!local) {
    const err = new Error('Локальный файл изображения не найден (нужен файл в uploads)');
    err.statusCode = 400;
    throw err;
  }

  const inputBuf = fs.readFileSync(local.abs);
  const { buffer, meta } = await fitImageBufferTo3x4(inputBuf, opts);

  const originalName = String(list[idx].aspect_3x4_from || '').trim() || local.filename;
  const base = path.parse(local.filename).name.replace(/_3x4$/i, '');
  const newName = `${base}_3x4_${crypto.randomBytes(3).toString('hex')}.jpg`;
  const newAbs = path.join(UPLOADS_PRODUCTS_ROOT, String(productId), newName);
  fs.writeFileSync(newAbs, buffer);

  try {
    const originalAbs = path.join(UPLOADS_PRODUCTS_ROOT, String(productId), originalName);
    if (local.abs !== newAbs && local.abs !== originalAbs && fs.existsSync(local.abs)) {
      fs.unlinkSync(local.abs);
    }
  } catch (_) {
    /* ignore */
  }

  const rel = `/uploads/products/${String(productId)}/${newName}`;
  const outSize = normalizeImageSize(meta?.out?.w, meta?.out?.h);
  list[idx] = {
    ...list[idx],
    id: newName,
    filename: newName,
    url: rel,
    updated_at: new Date().toISOString(),
    aspect_3x4: true,
    aspect_3x4_from: originalName,
    ...(outSize || {}),
  };

  return { images: list, meta, image: list[idx] };
}

/**
 * Вернуть исходный файл после приведения к 3:4.
 */
export async function restoreProductImageFrom3x4(productId, imageId, images) {
  const list = Array.isArray(images) ? images.map((x) => ({ ...x })) : [];
  const idStr = String(imageId || '');
  const idx = list.findIndex(
    (img) => String(img?.id || '') === idStr || String(img?.filename || '') === idStr
  );
  if (idx < 0) {
    const err = new Error('Изображение не найдено');
    err.statusCode = 404;
    throw err;
  }
  const originalName = String(list[idx].aspect_3x4_from || '').trim();
  if (!originalName) {
    const err = new Error('Нет сохранённого оригинала для отката 3:4');
    err.statusCode = 400;
    throw err;
  }
  const original = resolveLocalImagePath(productId, { filename: originalName });
  if (!original) {
    const err = new Error('Файл оригинала не найден');
    err.statusCode = 400;
    throw err;
  }
  const current = resolveLocalImagePath(productId, list[idx]);
  const rel = `/uploads/products/${String(productId)}/${original.filename}`;
  const next = { ...list[idx] };
  delete next.aspect_3x4;
  delete next.aspect_3x4_from;
  delete next.width;
  delete next.height;
  const originalSize = await readImageSizeFromPath(original.abs);
  list[idx] = {
    ...next,
    id: original.filename,
    filename: original.filename,
    url: rel,
    updated_at: new Date().toISOString(),
    ...(originalSize || {}),
  };
  try {
    if (current && current.abs !== original.abs && fs.existsSync(current.abs)) {
      fs.unlinkSync(current.abs);
    }
  } catch (_) {
    /* ignore */
  }
  return { images: list, image: list[idx] };
}

export default {
  fitImageBufferTo3x4,
  fitProductImageTo3x4,
  restoreProductImageFrom3x4,
  readImageSizeFromPath,
  readImageSizeFromBuffer,
  attachImageSizeToRecord,
};
