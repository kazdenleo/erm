/**
 * Импорт изображений товара по HTTP(S) URL (колонки Excel).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_BYTES = 12 * 1024 * 1024;

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extFromContentType(ct, url) {
  const c = String(ct || '').toLowerCase();
  if (c.includes('jpeg') || c.includes('jpg')) return '.jpg';
  if (c.includes('png')) return '.png';
  if (c.includes('webp')) return '.webp';
  if (c.includes('gif')) return '.gif';
  const base = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (base.endsWith('.jpg') || base.endsWith('.jpeg')) return '.jpg';
  if (base.endsWith('.png')) return '.png';
  if (base.endsWith('.webp')) return '.webp';
  if (base.endsWith('.gif')) return '.gif';
  return '';
}

/**
 * @param {string} cell
 * @returns {string[]}
 */
export function parseSemicolonImageUrls(cell) {
  if (cell == null || cell === '') return [];
  return String(cell)
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

/**
 * Ozon плохо принимает WebP/GIF — при сохранении конвертируем в JPEG.
 * @param {Buffer} buf
 * @param {string} ext
 * @returns {Promise<{ buf: Buffer, ext: string }>}
 */
async function normalizeImageBufferForStorage(buf, ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.jpg' || e === '.jpeg' || e === '.png') {
    return { buf, ext: e === '.jpeg' ? '.jpg' : e };
  }
  try {
    const out = await sharp(buf).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    return { buf: out, ext: '.jpg' };
  } catch {
    return { buf, ext: e || '.jpg' };
  }
}

/**
 * Difference hash (64 bit) — устойчив к перекодированию/разному CDN (WB vs Ozon/YM).
 * Перед хешем берём центральный квадрат, чтобы портретный кроп WB и ландшафт Ozon
 * чаще сходились на одном визуале.
 * @param {Buffer} buf
 * @returns {Promise<string>} hex 16 символов
 */
export async function computeImagePerceptualHash(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  try {
    const meta = await sharp(buf).metadata();
    const w = Number(meta.width) || 0;
    const h = Number(meta.height) || 0;
    let pipeline = sharp(buf);
    if (w >= 8 && h >= 8) {
      const side = Math.min(w, h);
      const left = Math.max(0, Math.floor((w - side) / 2));
      const top = Math.max(0, Math.floor((h - side) / 2));
      pipeline = pipeline.extract({ left, top, width: side, height: side });
    }
    const { data } = await pipeline
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let hash = 0n;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const leftPx = data[y * 9 + x];
        const rightPx = data[y * 9 + x + 1];
        hash = (hash << 1n) | (leftPx < rightPx ? 1n : 0n);
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch {
    return '';
  }
}

/**
 * Hamming distance между двумя 64-bit hex dHash.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function perceptualHashDistance(a, b) {
  const aa = String(a || '')
    .trim()
    .toLowerCase()
    .padStart(16, '0');
  const bb = String(b || '')
    .trim()
    .toLowerCase()
    .padStart(16, '0');
  if (!/^[0-9a-f]{16}$/.test(aa) || !/^[0-9a-f]{16}$/.test(bb)) return 64;
  let x = BigInt(`0x${aa}`) ^ BigInt(`0x${bb}`);
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

/** Порог «одна и та же картинка» после сжатия МП (из 64 бит). */
export const PERCEPTUAL_HASH_MATCH_THRESHOLD = 12;

/** Однотонные/пустые кадры дают вырожденный dHash — по нему не мержим. */
export function isWeakPerceptualHash(hash) {
  const h = String(hash || '')
    .trim()
    .toLowerCase();
  return !/^[0-9a-f]{16}$/.test(h) || h === '0000000000000000' || h === 'ffffffffffffffff';
}

/**
 * @param {string|number} productId
 * @param {string} url
 * @param {{ primary?: boolean, marketplaces?: { ozon?: boolean, wb?: boolean, ym?: boolean } }} [opts]
 */
export async function downloadImageToProductFolder(productId, url, opts = {}) {
  const trimmed = String(url || '').trim();
  if (!isHttpUrl(trimmed)) return null;
  const { buf, ext, contentHash, perceptualHash } = await fetchAndNormalizeImageBuffer(trimmed);
  return saveNormalizedImageToProductFolder(productId, trimmed, buf, ext, {
    ...opts,
    contentHash,
    perceptualHash,
  });
}

/**
 * Скачать и нормализовать буфер изображения (без записи на диск).
 * @returns {Promise<{ buf: Buffer, ext: string, contentHash: string, perceptualHash: string }>}
 */
export async function fetchAndNormalizeImageBuffer(url) {
  const trimmed = String(url || '').trim();
  if (!isHttpUrl(trimmed)) throw new Error('Некорректный URL');
  const res = await fetch(trimmed, {
    redirect: 'follow',
    headers: { 'User-Agent': 'ERM-ProductImport/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.toLowerCase().startsWith('image/')) throw new Error(`Не изображение: ${ct}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Файл слишком большой');
  let ext = extFromContentType(ct, trimmed) || '.jpg';
  ({ buf, ext } = await normalizeImageBufferForStorage(buf, ext));
  const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
  const perceptualHash = await computeImagePerceptualHash(buf);
  return { buf, ext, contentHash, perceptualHash };
}

/**
 * Записать уже скачанный буфер в uploads/products/{id}.
 */
export function saveNormalizedImageToProductFolder(productId, sourceUrl, buf, ext, opts = {}) {
  const trimmed = String(sourceUrl || '').trim();
  const uploadsRoot = path.resolve(__dirname, '../../uploads/products');
  const dir = path.join(uploadsRoot, String(productId));
  ensureDirSync(dir);
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const filename = `${id}${ext || '.jpg'}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  const rel = `/uploads/products/${String(productId)}/${filename}`;
  const mp =
    opts.marketplaces && typeof opts.marketplaces === 'object' && !Array.isArray(opts.marketplaces)
      ? {
          ozon: opts.marketplaces.ozon === true,
          wb: opts.marketplaces.wb === true,
          ym: opts.marketplaces.ym === true,
        }
      : { ozon: true, wb: true, ym: true };
  const contentHash =
    opts.contentHash ||
    (Buffer.isBuffer(buf) ? crypto.createHash('sha256').update(buf).digest('hex') : undefined);
  const perceptualHash =
    opts.perceptualHash != null && String(opts.perceptualHash).trim() !== ''
      ? String(opts.perceptualHash).trim().toLowerCase()
      : undefined;
  return {
    id: filename,
    url: rel,
    filename,
    originalname: trimmed.slice(0, 240),
    source_url: trimmed,
    content_hash: contentHash || undefined,
    perceptual_hash: perceptualHash || undefined,
    primary: opts.primary === true,
    marketplaces: mp,
    created_at: new Date().toISOString(),
  };
}

/**
 * Если в Excel указаны ссылки — скачиваем и заменяем массив images (как при новой выгрузке каталога).
 * @param {string|number} productId
 * @param {{ mainUrl?: unknown, galleryUrls?: unknown }} hints
 */
export async function importProductImagesFromExcelUrls(productId, hints) {
  const mainRaw = String(hints?.mainUrl ?? '').trim();
  const galleryList = parseSemicolonImageUrls(hints?.galleryUrls);

  const jobs = [];
  if (isHttpUrl(mainRaw)) jobs.push({ url: mainRaw, primary: true });
  for (const u of galleryList) {
    if (mainRaw && u === mainRaw) continue;
    jobs.push({ url: u, primary: false });
  }

  if (jobs.length === 0) return { ok: true, skipped: true, images: null };

  const downloaded = [];
  const errors = [];
  for (const { url, primary } of jobs) {
    try {
      const rec = await downloadImageToProductFolder(productId, url, { primary });
      if (rec) downloaded.push(rec);
    } catch (e) {
      errors.push({ url, message: e?.message || String(e) });
    }
  }

  if (downloaded.length === 0) {
    return { ok: false, skipped: false, images: null, errors };
  }

  downloaded.forEach((d, i) => {
    d.primary = i === 0;
  });

  const productsService = (await import('./products.service.js')).default;
  await productsService.update(String(productId), { images: downloaded });
  return { ok: true, skipped: false, images: downloaded, errors };
}
