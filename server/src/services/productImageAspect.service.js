/**
 * Приведение фото товара к соотношению 3:4 (портрет).
 * Поля по контенту (товар + светлые WM на фоне), фон — цвет углов.
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * @param {Buffer} inputBuf
 * @param {{ marginRatioX?: number, marginRatioY?: number, outLongSide?: number|null }} [opts]
 * @returns {Promise<{ buffer: Buffer, meta: object }>}
 */
export async function fitImageBufferTo3x4(inputBuf, opts = {}) {
  const marginRatioX = opts.marginRatioX ?? 0.03;
  const marginRatioY = opts.marginRatioY ?? 0.05;
  const outLongSide = opts.outLongSide === undefined ? 1600 : opts.outLongSide;

  const { data, info } = await sharp(inputBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels; // 4
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

  const tol = 28;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      const dr = data[i] - bg[0];
      const dg = data[i + 1] - bg[1];
      const db = data[i + 2] - bg[2];
      const diff = Math.sqrt(dr * dr + dg * dg + db * db);
      if (diff > tol) mask[y * w + x] = 1;
    }
  }

  // open/close 5x5 roughly
  const morph = (src, mode) => {
    const out = new Uint8Array(src.length);
    const r = 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let any = 0;
        let all = 1;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const v = src[yy * w + xx];
            if (v) any = 1;
            else all = 0;
          }
        }
        out[y * w + x] = mode === 'dilate' ? any : all;
      }
    }
    return out;
  };
  // open = erode then dilate; close = dilate then erode
  let m = morph(mask, 'erode');
  m = morph(m, 'dilate');
  m = morph(m, 'dilate');
  m = morph(m, 'erode');

  // connected components keep large
  const labels = new Int32Array(w * h);
  let label = 0;
  const areas = [0];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!m[p] || labels[p]) continue;
      label += 1;
      let area = 0;
      stack.length = 0;
      stack.push(p);
      labels[p] = label;
      while (stack.length) {
        const cur = stack.pop();
        area += 1;
        const cx = cur % w;
        const cy = (cur / w) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const np = ny * w + nx;
          if (!m[np] || labels[np]) continue;
          labels[np] = label;
          stack.push(np);
        }
      }
      areas[label] = area;
    }
  }
  const minArea = Math.max(80, Math.floor(w * h * 0.0015));
  const keepLabels = new Set();
  let best = 1;
  for (let i = 1; i <= label; i++) {
    if (areas[i] > areas[best]) best = i;
    if (areas[i] >= minArea) keepLabels.add(i);
  }
  if (keepLabels.size === 0 && label >= 1) keepLabels.add(best);

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lab = labels[y * w + x];
      if (!keepLabels.has(lab)) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) {
    x0 = 0;
    y0 = 0;
    x1 = w - 1;
    y1 = h - 1;
  }
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);

  let pw = x1 - x0 + 1;
  let ph = y1 - y0 + 1;

  const canvasForContent = (cwContent, chContent) => {
    const contentRatio = cwContent / Math.max(1, chContent);
    if (contentRatio > TARGET_RATIO) {
      const canvasW = cwContent;
      const canvasH = Math.round(canvasW / TARGET_RATIO);
      return [canvasW, canvasH];
    }
    const canvasH = chContent;
    const canvasW = Math.round(canvasH * TARGET_RATIO);
    return [canvasW, canvasH];
  };

  let canvasW = pw;
  let canvasH = ph;
  let marginX = 8;
  let marginY = 8;
  for (let i = 0; i < 5; i++) {
    marginX = Math.max(4, Math.round(marginRatioX * Math.min(canvasW, canvasH)));
    marginY = Math.max(4, Math.round(marginRatioY * Math.min(canvasW, canvasH)));
    [canvasW, canvasH] = canvasForContent(pw + 2 * marginX, ph + 2 * marginY);
  }

  // optional crop to content+margins if fits in source
  let cropLeft = 0;
  let cropTop = 0;
  let cropW = w;
  let cropH = h;
  {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let needW = pw + 2 * marginX;
    let needH = ph + 2 * marginY;
    if (needW / needH > TARGET_RATIO) needH = Math.round(needW / TARGET_RATIO);
    else needW = Math.round(needH * TARGET_RATIO);
    const cw = Math.min(w, Math.max(needW, pw + 2 * marginX));
    const chh = Math.min(h, Math.max(needH, ph + 2 * marginY));
    if (cw <= w && chh <= h) {
      let left = Math.round(cx - cw / 2);
      let top = Math.round(cy - chh / 2);
      left = clamp(left, 0, w - cw);
      top = clamp(top, 0, h - chh);
      if (x0 >= left && x1 < left + cw && y0 >= top && y1 < top + chh) {
        cropLeft = left;
        cropTop = top;
        cropW = cw;
        cropH = chh;
        x0 -= left;
        x1 -= left;
        y0 -= top;
        y1 -= top;
        pw = x1 - x0 + 1;
        ph = y1 - y0 + 1;
        canvasW = pw;
        canvasH = ph;
        for (let i = 0; i < 5; i++) {
          marginX = Math.max(4, Math.round(marginRatioX * Math.min(canvasW, canvasH)));
          marginY = Math.max(4, Math.round(marginRatioY * Math.min(canvasW, canvasH)));
          [canvasW, canvasH] = canvasForContent(pw + 2 * marginX, ph + 2 * marginY);
        }
      }
    }
  }

  const extracted = await sharp(inputBuf)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .toBuffer();

  let workBuf = extracted;
  let workW = cropW;
  let workH = cropH;
  let bx = (x0 + x1) / 2;
  let by = (y0 + y1) / 2;
  let scale = 1;
  const maxPw = canvasW - 2 * marginX;
  const maxPh = canvasH - 2 * marginY;
  if (pw > maxPw || ph > maxPh) {
    scale = Math.min(maxPw / pw, maxPh / ph);
    workW = Math.max(1, Math.round(cropW * scale));
    workH = Math.max(1, Math.round(cropH * scale));
    workBuf = await sharp(extracted)
      .resize(workW, workH, { fit: 'fill' })
      .toBuffer();
    x0 = Math.round(x0 * scale);
    y0 = Math.round(y0 * scale);
    x1 = Math.round(x1 * scale);
    y1 = Math.round(y1 * scale);
    bx = (x0 + x1) / 2;
    by = (y0 + y1) / 2;
  }

  let pasteX = Math.round(canvasW / 2 - bx);
  let pasteY = Math.round(canvasH / 2 - by);

  let compInput = workBuf;
  let compLeft = pasteX;
  let compTop = pasteY;
  if (pasteX < 0 || pasteY < 0 || pasteX + workW > canvasW || pasteY + workH > canvasH) {
    const srcX0 = Math.max(0, -pasteX);
    const srcY0 = Math.max(0, -pasteY);
    const dstX0 = Math.max(0, pasteX);
    const dstY0 = Math.max(0, pasteY);
    const srcX1 = Math.min(workW, canvasW - pasteX);
    const srcY1 = Math.min(workH, canvasH - pasteY);
    const ww = srcX1 - srcX0;
    const hh = srcY1 - srcY0;
    if (ww > 0 && hh > 0) {
      compInput = await sharp(workBuf)
        .extract({ left: srcX0, top: srcY0, width: ww, height: hh })
        .toBuffer();
      compLeft = dstX0;
      compTop = dstY0;
    }
  }

  let outPipeline = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: bg[0], g: bg[1], b: bg[2] },
    },
  }).composite([{ input: compInput, left: compLeft, top: compTop }]);

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
      out: { w: metaOut.width, h: metaOut.height },
      ratio: metaOut.width && metaOut.height ? metaOut.width / metaOut.height : null,
      bg,
      marginX,
      marginY,
      scale,
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
  // security: no path traversal
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

  const base = path.parse(local.filename).name.replace(/_3x4$/i, '');
  const newName = `${base}_3x4_${crypto.randomBytes(3).toString('hex')}.jpg`;
  const newAbs = path.join(UPLOADS_PRODUCTS_ROOT, String(productId), newName);
  fs.writeFileSync(newAbs, buffer);

  try {
    if (fs.existsSync(local.abs) && local.abs !== newAbs) fs.unlinkSync(local.abs);
  } catch (_) {
    /* ignore */
  }

  const rel = `/uploads/products/${String(productId)}/${newName}`;
  list[idx] = {
    ...list[idx],
    id: newName,
    filename: newName,
    url: rel,
    updated_at: new Date().toISOString(),
    aspect_3x4: true,
  };

  return { images: list, meta, image: list[idx] };
}

export default {
  fitImageBufferTo3x4,
  fitProductImageTo3x4,
};
