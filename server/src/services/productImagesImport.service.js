/**
 * Импорт изображений товара по HTTP(S) URL (колонки Excel).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

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
 * @param {string|number} productId
 * @param {string} url
 * @param {{ primary?: boolean }} [opts]
 */
export async function downloadImageToProductFolder(productId, url, opts = {}) {
  const trimmed = String(url || '').trim();
  if (!isHttpUrl(trimmed)) return null;
  const res = await fetch(trimmed, {
    redirect: 'follow',
    headers: { 'User-Agent': 'ERM-ProductImport/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.toLowerCase().startsWith('image/')) throw new Error(`Не изображение: ${ct}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Файл слишком большой');
  const ext = extFromContentType(ct, trimmed) || '.jpg';
  const uploadsRoot = path.resolve(__dirname, '../../uploads/products');
  const dir = path.join(uploadsRoot, String(productId));
  ensureDirSync(dir);
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const filename = `${id}${ext}`;
  fs.writeFileSync(path.join(dir, filename), buf);
  const rel = `/uploads/products/${String(productId)}/${filename}`;
  return {
    id: filename,
    url: rel,
    filename,
    originalname: trimmed.slice(0, 240),
    source_url: trimmed,
    primary: opts.primary === true,
    marketplaces: { ozon: true, wb: true, ym: true },
    created_at: new Date().toISOString()
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
