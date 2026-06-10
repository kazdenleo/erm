/**
 * Генерация этикеток товаров по шаблону категории
 */

import bwipjs from 'bwip-js';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { query } from '../config/database.js';
import { categoryLabelTemplatesRepository } from '../repositories/categoryLabelTemplates.repository.pg.js';
import productsService from './products.service.js';
import { pickBarcodeForMarketplace, shouldUseBarcodeDigitFallback } from '../utils/productBarcodes.js';
import {
  getProductFieldDisplayValue,
  labelProductFieldLabel,
} from '../constants/labelProductFields.js';
import {
  formatKitComponentLines,
  getKitComponentsFromProduct,
} from '../constants/labelKitComponents.js';
import { getKitComponents, isKitProductId } from './kitStock.service.js';

const SIZE_PRESETS = {
  '58x40': { widthMm: 58, heightMm: 40 },
  '75x120': { widthMm: 75, heightMm: 120 },
};

const MM_TO_PX = 8;

function resolveMmToPx(previewScale) {
  const s = Number(previewScale);
  if (!Number.isFinite(s) || s <= 1) return MM_TO_PX;
  return MM_TO_PX * Math.min(6, Math.max(2, s));
}

/** fontSize в шаблоне — для этикетки 58×40 при 8px/мм; масштабируется с previewScale. */
function resolveFontSizePx(fontSize, mmToPx, maxPt = 24) {
  const raw = Number(fontSize);
  const base = Math.min(maxPt, Math.max(6, Number.isFinite(raw) ? raw : 11));
  return Math.round(base * (mmToPx / MM_TO_PX));
}

async function loadCategoryAttributeIds(userCategoryId) {
  if (userCategoryId == null || userCategoryId === '') return [];
  const result = await query(
    'SELECT attribute_id FROM category_attributes WHERE user_category_id = $1::bigint',
    [userCategoryId]
  );
  return (result.rows || []).map((r) => String(r.attribute_id));
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Приблизительная ширина символа для Arial (мм → px уже в fontSize). */
function estimateCharWidth(fontSize, char) {
  const code = char.charCodeAt(0);
  if (char === '(' || char === ')') return fontSize * 0.34;
  if (code >= 65 && code <= 90) return fontSize * 0.62;
  if (code >= 97 && code <= 122) return fontSize * 0.5;
  if (code > 127 || code === 45 || code === 47) return fontSize * 0.58;
  if (code >= 48 && code <= 57) return fontSize * 0.52;
  return fontSize * 0.48;
}

function measureTextWidth(text, fontSize, bold = false) {
  let w = 0;
  for (const ch of String(text)) w += estimateCharWidth(fontSize, ch);
  return w * (bold ? 1.12 : 1.02);
}

/** Слова и фрагменты в скобках — отдельные единицы переноса (чтобы «(БМВ 5)» не рвалось). */
function tokenizeWrapUnits(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const units = [];
  const re = /\([^)]*\)|\S+/gu;
  let m;
  while ((m = re.exec(raw)) !== null) units.push(m[0]);
  return units;
}

const MAX_WORD_LEN_WITHOUT_CHAR_BREAK = 14;

function wrapTextLines(text, maxWidthPx, fontSize, bold = false) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const limit = Math.max(1, Math.floor(maxWidthPx * 0.97));
  if (measureTextWidth(raw, fontSize, bold) <= limit) return [raw];

  const lines = [];
  const words = tokenizeWrapUnits(raw);

  const pushBrokenWord = (word) => {
    let chunk = '';
    for (const ch of word) {
      const next = chunk + ch;
      if (chunk && measureTextWidth(next, fontSize, bold) > limit) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    if (chunk) lines.push(chunk);
  };

  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureTextWidth(candidate, fontSize, bold) <= limit) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    const wordTooWide = measureTextWidth(word, fontSize, bold) > limit;
    const allowCharBreak =
      wordTooWide && word.length > MAX_WORD_LEN_WITHOUT_CHAR_BREAK;
    if (allowCharBreak) {
      pushBrokenWord(word);
      current = '';
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [raw.slice(0, Math.max(1, Math.floor(limit / (fontSize * 0.55))))];
}

function resolveLineGapPx(template, mmToPx) {
  const lineGapMm = Number(template?.line_gap_mm ?? template?.lineGapMm);
  if (!Number.isFinite(lineGapMm) || lineGapMm < 0) return Math.round(1 * mmToPx);
  return Math.round(lineGapMm * mmToPx);
}

function textBlockHeight(lineCount, fontSize, lineGapPx) {
  if (lineCount <= 0) return 0;
  const lineStep = fontSize + Math.max(0, lineGapPx);
  return fontSize + (lineCount - 1) * lineStep;
}

function trimLineWithEllipsis(line, maxWidthPx, fontSize, bold) {
  const ell = '…';
  const raw = String(line || '');
  if (measureTextWidth(`${raw}${ell}`, fontSize, bold) <= maxWidthPx) return `${raw}${ell}`;
  let s = raw;
  while (s.length > 0 && measureTextWidth(`${s}${ell}`, fontSize, bold) > maxWidthPx) {
    s = s.slice(0, -1);
  }
  return `${s}${ell}`;
}

function maxTextLinesForHeight(y, maxY, fontSize, lineGapPx) {
  const lineStep = fontSize + Math.max(0, lineGapPx);
  if (maxY <= y + fontSize) return 0;
  return Math.max(1, Math.floor((maxY - y - fontSize) / lineStep) + 1);
}

/**
 * Минимальная высота блока (px) для планирования раскладки этикетки.
 */
function estimateElementMinHeight(el, ctx) {
  const { mmToPx, lineGapPx, blockGap, innerW, barcodeValue, product, attrValues, attributeNames, catAttrSet } =
    ctx;
  const gap = blockGap;

  if (el.type === 'barcode') {
    if (!barcodeValue) return 0;
    const hMm = Number(el.heightMm) || 12;
    const hPx = Math.round(hMm * mmToPx);
    const digitFs = resolveFontSizePx(el.textFontSize ?? el.fontSize, mmToPx, 14);
    const textUnderH = el.showText !== false ? digitFs + 4 : 0;
    return hPx + (textUnderH ? 2 + textUnderH : 0) + gap;
  }

  if (el.type === 'sku') {
    const sku = String(product?.sku || '').trim();
    if (!sku) return 0;
    const fs = resolveFontSizePx(el.fontSize, mmToPx, 20);
    return textBlockHeight(1, fs, lineGapPx) + gap;
  }

  if (el.type === 'attribute' && el.attributeId != null) {
    const aid = String(el.attributeId);
    if (catAttrSet && !catAttrSet.has(aid)) return 0;
    const val = attrValues[aid] ?? attrValues[Number(aid)];
    if (val == null || String(val).trim() === '') return 0;
    const fs = resolveFontSizePx(el.fontSize, mmToPx);
    const attrName = attributeNames[aid] || attributeNames[Number(aid)] || '';
    const label = el.showName !== false && attrName ? `${attrName}: ` : '';
    const lines = wrapTextLines(label + String(val), innerW, fs, false);
    return textBlockHeight(lines.length, fs, lineGapPx) + gap;
  }

  if (el.type === 'product_field' && el.fieldKey) {
    const val = getProductFieldDisplayValue(product, el.fieldKey);
    if (!val) return 0;
    const fs = resolveFontSizePx(el.fontSize, mmToPx);
    const fieldLabel = labelProductFieldLabel(el.fieldKey);
    const prefix = el.showName !== false && fieldLabel ? `${fieldLabel}: ` : '';
    const lines = wrapTextLines(prefix + val, innerW, fs, false);
    return textBlockHeight(lines.length, fs, lineGapPx) + gap;
  }

  if (el.type === 'kit_components') {
    const lines = formatKitComponentLines(product, el);
    if (!lines.length) return 0;
    const fs = resolveFontSizePx(el.fontSize, mmToPx);
    const titleFs = resolveFontSizePx(el.titleFontSize ?? fs, mmToPx, 20);
    let h = 0;
    if (el.showTitle !== false) {
      h += textBlockHeight(1, titleFs, lineGapPx) + gap;
    }
    for (const line of lines) {
      const wrapped = wrapTextLines(line, innerW, fs, Boolean(el.bold));
      h += textBlockHeight(wrapped.length, fs, lineGapPx);
    }
    return h + gap;
  }

  return 0;
}

function reserveHeightBelow(elements, startIdx, ctx) {
  let total = 0;
  for (let i = startIdx + 1; i < elements.length; i += 1) {
    total += estimateElementMinHeight(elements[i], ctx);
  }
  return total;
}

/**
 * Многострочный текст в SVG (tspan); не выходит за maxY.
 * @returns {number} y после блока (до отступа между полями)
 */
function appendWrappedTextSvg(blocks, {
  text,
  x,
  y,
  fontSize,
  fontWeight = 'normal',
  fill = '#000',
  maxWidthPx,
  maxY,
  lineGapPx = 0,
  textAnchor = 'start',
}) {
  const bold = fontWeight === 'bold';
  const allLines = wrapTextLines(text, maxWidthPx, fontSize, bold);
  if (!allLines.length) return y;

  const lineStep = fontSize + Math.max(0, lineGapPx);
  const xAttr = textAnchor === 'middle' ? x + maxWidthPx / 2 : x;
  const anchorAttr = textAnchor !== 'start' ? ` text-anchor="${textAnchor}"` : '';
  const firstBaseline = y + fontSize;

  if (firstBaseline > maxY) return y;

  const maxLines = maxTextLinesForHeight(y, maxY, fontSize, lineGapPx);
  let lines = allLines.slice(0, maxLines);
  if (allLines.length > lines.length && lines.length > 0) {
    lines = [...lines.slice(0, -1), trimLineWithEllipsis(lines[lines.length - 1], maxWidthPx, fontSize, bold)];
  }

  let lineCount = 0;
  const tspans = [];
  for (let i = 0; i < lines.length; i++) {
    const baseline = firstBaseline + i * lineStep;
    if (baseline > maxY) break;
    const dy = i === 0 ? 0 : lineStep;
    tspans.push(`<tspan x="${xAttr}" dy="${dy}">${escapeXml(lines[i])}</tspan>`);
    lineCount++;
  }
  if (!lineCount) return y;

  const fontFamily =
    textAnchor === 'middle'
      ? "Consolas, 'Courier New', monospace"
      : 'Arial, sans-serif';
  blocks.push(
    `<text x="${xAttr}" y="${firstBaseline}" font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}"${anchorAttr}>${tspans.join('')}</text>`
  );

  return y + fontSize + (lineCount - 1) * lineStep;
}

function parseSize(template) {
  const preset = SIZE_PRESETS[template?.size_preset || template?.sizePreset] || SIZE_PRESETS['58x40'];
  const w = template?.width_mm ?? template?.widthMm ?? preset.widthMm;
  const h = template?.height_mm ?? template?.heightMm ?? preset.heightMm;
  return {
    widthMm: Number(w) || preset.widthMm,
    heightMm: Number(h) || preset.heightMm,
    marginTopMm: Number(template?.margin_top_mm ?? template?.marginTopMm ?? 2),
    marginRightMm: Number(template?.margin_right_mm ?? template?.marginRightMm ?? 2),
    marginBottomMm: Number(template?.margin_bottom_mm ?? template?.marginBottomMm ?? 2),
    marginLeftMm: Number(template?.margin_left_mm ?? template?.marginLeftMm ?? 2),
  };
}

export function defaultLabelElements() {
  return [
    { id: 'name', type: 'name', enabled: true, fontSize: 11, bold: true },
    { id: 'sku', type: 'sku', enabled: true, fontSize: 9 },
    { id: 'barcode', type: 'barcode', enabled: true, widthMm: 54, heightMm: 14, showText: true, textFontSize: 8 },
  ];
}

function normalizeElements(elements) {
  const list = Array.isArray(elements) && elements.length ? elements : defaultLabelElements();
  return list.filter((el) => el && el.enabled !== false);
}

async function loadAttributeNames(attributeIds) {
  if (!attributeIds.length) return {};
  const result = await query(
    `SELECT id, name FROM product_attributes WHERE id = ANY($1::bigint[])`,
    [attributeIds]
  );
  const map = {};
  for (const row of result.rows || []) {
    map[row.id] = row.name;
  }
  return map;
}

async function loadKitComponentsWithDetails(kitProductId) {
  const kitId = Number(kitProductId);
  if (!Number.isFinite(kitId) || kitId < 1) return [];
  const rows = await getKitComponents(kitId);
  if (!rows.length) return [];

  const ids = [...new Set(rows.map((r) => Number(r.component_product_id)).filter((id) => id >= 1))];
  if (!ids.length) return rows.map((r) => ({
    productId: r.component_product_id,
    component_product_id: r.component_product_id,
    quantity: r.quantity,
  }));

  const result = await query(
    `SELECT id, sku, name FROM products WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  const byId = new Map();
  for (const row of result.rows || []) {
    byId.set(Number(row.id), { sku: row.sku, name: row.name });
  }

  return rows.map((r) => {
    const cid = Number(r.component_product_id);
    const p = byId.get(cid);
    return {
      productId: cid,
      component_product_id: cid,
      quantity: r.quantity,
      component_sku: p?.sku ?? null,
      product_name: p?.name ?? null,
    };
  });
}

/** Подгружает состав комплекта, если в шаблоне есть блок «комплектующие». */
async function enrichProductForLabel(product, template) {
  const elements = template?.elements || [];
  const needsKit = elements.some((el) => el?.type === 'kit_components' && el.enabled !== false);
  if (!needsKit || !product) return product;

  if (getKitComponentsFromProduct(product).length > 0) return product;

  const id = Number(product.id);
  if (!Number.isFinite(id) || !(await isKitProductId(id))) return product;

  const kit_components = await loadKitComponentsWithDetails(id);
  return { ...product, product_type: product.product_type || 'kit', kit_components };
}

/** Тип штрихкода и нормализованный текст (EAN-13 — только цифры; DT-000023 — Code128 целиком). */
function resolveBarcodeSpec(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  if (!shouldUseBarcodeDigitFallback(trimmed)) {
    return { bcid: 'code128', text: trimmed };
  }

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 12 || digits.length === 13) {
    return {
      bcid: 'ean13',
      text: digits.length === 12 ? `0${digits}` : digits.slice(0, 13),
    };
  }
  return { bcid: 'code128', text: digits };
}

/** Ширина символа в модулях (для подбора целочисленного scale). */
function estimateBarcodeModules(bcid, text) {
  if (bcid === 'ean13') return 95;
  const len = String(text || '').length;
  return 35 + 11 * Math.max(1, len);
}

/**
 * Целочисленный scale: штрихкод ~90–94% ширины этикетки (как в этикеточных программах).
 */
/** Ширина и смещение области штрихкода (px); widthMm — из конструктора, иначе на всю ширину. */
function resolveBarcodeSlot(el, innerW, mmToPx) {
  const wMm = Number(el.widthMm);
  const widthPx =
    Number.isFinite(wMm) && wMm > 0
      ? Math.min(innerW, Math.round(Math.min(120, Math.max(15, wMm)) * mmToPx))
      : innerW;
  return {
    widthPx,
    offsetX: Math.max(0, Math.round((innerW - widthPx) / 2)),
  };
}

function pickBarcodeScale(bcid, text, targetWidthPx) {
  const quietModules = 10;
  const modules = estimateBarcodeModules(bcid, text);
  const scale = Math.floor((targetWidthPx * 0.94) / (modules + 2 * quietModules));
  return Math.max(2, Math.min(8, scale));
}

async function renderBarcodePngForSpec(spec, { targetW, barMm }) {
  let scale = pickBarcodeScale(spec.bcid, spec.text, targetW);

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const buf = await bwipjs.toBuffer({
        bcid: spec.bcid,
        text: spec.text,
        scale,
        height: barMm,
        paddingwidth: 10,
        paddingheight: 2,
        includetext: false,
        inkspread: 0,
      });
      const meta = await sharp(buf).metadata();
      if (!meta.width) return buf;
      if (meta.width >= targetW * 0.9 || scale >= 8) return buf;
      scale += 1;
    }
    return await bwipjs.toBuffer({
      bcid: spec.bcid,
      text: spec.text,
      scale,
      height: barMm,
      paddingwidth: 10,
      paddingheight: 2,
      includetext: false,
      inkspread: 0,
    });
  } catch {
    return null;
  }
}

async function generateBarcodePng(text, { widthPx, barHeightMm }) {
  const spec = resolveBarcodeSpec(text);
  if (!spec) return null;

  const targetW = Math.max(80, Number(widthPx) || 200);
  const barMm = Math.min(40, Math.max(4, Number(barHeightMm) || 12));
  const renderOpts = { targetW, barMm };

  const primary = await renderBarcodePngForSpec(spec, renderOpts);
  if (primary) return primary;

  if (spec.bcid === 'ean13') {
    const digits = String(text || '').trim().replace(/\D/g, '');
    if (digits) {
      return renderBarcodePngForSpec({ bcid: 'code128', text: digits }, renderOpts);
    }
  }

  return null;
}

/** Вписать в слот: сначала по ширине (~100% innerW), затем ограничить высотой heightMm. */
async function fitBarcodePngToSlot(pngBuffer, innerW, hPx) {
  const slotW = Math.max(10, Math.round(innerW));
  const slotH = Math.max(10, Math.round(hPx));
  const img = sharp(pngBuffer);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return null;

  const maxW = slotW - 2;
  const maxH = slotH - 2;

  let w = maxW;
  let h = Math.round(meta.height * (w / meta.width));
  if (h > maxH) {
    h = maxH;
    w = Math.round(meta.width * (h / meta.height));
  }
  w = Math.max(1, w);
  h = Math.max(1, h);

  const resized = await img.resize({ width: w, height: h, kernel: sharp.kernel.nearest }).png().toBuffer();
  const left = Math.max(0, Math.round((slotW - w) / 2));
  const top = Math.max(0, Math.round((slotH - h) / 2));

  return sharp({
    create: { width: slotW, height: slotH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();
}

function mmToPt(mm) {
  return (mm / 25.4) * 72;
}

async function pngToPdfBuffer(pngBuffer, widthMm, heightMm) {
  const widthPt = mmToPt(widthMm);
  const heightPt = mmToPt(heightMm);
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(pngBuffer);
  const page = doc.addPage([widthPt, heightPt]);
  page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
  return Buffer.from(await doc.save());
}

async function duplicateLabelPdf(pdfBuffer, copies) {
  const count = Math.min(99, Math.max(1, parseInt(copies, 10) || 1));
  if (count <= 1) return pdfBuffer;

  const src = await PDFDocument.load(pdfBuffer);
  const out = await PDFDocument.create();
  const indices = src.getPageIndices();

  for (let c = 0; c < count; c += 1) {
    const pages = await out.copyPages(src, indices);
    for (const page of pages) {
      out.addPage(page);
    }
  }

  return Buffer.from(await out.save());
}

async function buildLabelSvg({ template, product, attributeNames, categoryAttributeIds = null, mmToPx = MM_TO_PX, marketplace = null }) {
  const { widthMm, heightMm, marginTopMm, marginRightMm, marginBottomMm, marginLeftMm } = parseSize(template);
  const widthPx = Math.round(widthMm * mmToPx);
  const heightPx = Math.round(heightMm * mmToPx);
  const padL = Math.round(marginLeftMm * mmToPx);
  const padR = Math.round(marginRightMm * mmToPx);
  const padT = Math.round(marginTopMm * mmToPx);
  const padB = Math.round(marginBottomMm * mmToPx);
  const maxContentY = heightPx - padB;
  const catAttrSet =
    categoryAttributeIds && categoryAttributeIds.length
      ? new Set(categoryAttributeIds.map(String))
      : null;
  const innerW = Math.max(10, widthPx - padL - padR);
  const elements = normalizeElements(template.elements);
  const attrValues = product.attribute_values || product.attributeValues || {};
  const barcodeValue =
    pickBarcodeForMarketplace(product.barcodes, marketplace) ||
    String(product.sku || '').trim() ||
    '';

  const lineGapPx = resolveLineGapPx(template, mmToPx);
  const blockGap = lineGapPx;

  const layoutCtx = {
    mmToPx,
    lineGapPx,
    blockGap,
    innerW,
    barcodeValue,
    product,
    attrValues,
    attributeNames,
    catAttrSet,
  };

  const blocks = [];
  let y = padT;

  for (let elIndex = 0; elIndex < elements.length; elIndex += 1) {
    const el = elements[elIndex];
    if (y >= maxContentY) break;

    const reservedBelow = reserveHeightBelow(elements, elIndex, layoutCtx);
    const slotMaxY = maxContentY - reservedBelow;

    if (el.type === 'name') {
      const fs = resolveFontSizePx(el.fontSize, mmToPx);
      const name = String(product.name || product.mp_ozon_name || '').trim() || '—';
      const weight = el.bold ? 'bold' : 'normal';
      y = appendWrappedTextSvg(blocks, {
        text: name,
        x: padL,
        y,
        fontSize: fs,
        fontWeight: weight,
        fill: '#000',
        maxWidthPx: innerW,
        maxY: Math.max(y + fs, slotMaxY),
        lineGapPx,
      });
      y += blockGap;
    } else if (el.type === 'sku') {
      const fs = resolveFontSizePx(el.fontSize, mmToPx, 20);
      const sku = String(product.sku || '').trim();
      if (sku && y < slotMaxY) {
        y = appendWrappedTextSvg(blocks, {
          text: `SKU: ${sku}`,
          x: padL,
          y,
          fontSize: fs,
          fill: '#333',
          maxWidthPx: innerW,
          maxY: slotMaxY,
          lineGapPx,
        });
        y += blockGap;
      }
    } else if (el.type === 'barcode' && barcodeValue) {
      const hMm = Number(el.heightMm) || 12;
      let hPx = Math.round(hMm * mmToPx);
      const { widthPx: barWidthPx, offsetX: barOffsetX } = resolveBarcodeSlot(el, innerW, mmToPx);
      const barX = padL + barOffsetX;
      const digitFs = resolveFontSizePx(el.textFontSize ?? el.fontSize, mmToPx, 14);
      const textUnderH = el.showText !== false ? digitFs + 4 : 0;
      const textGap = textUnderH ? 2 + textUnderH : 0;
      const minBarcodePx = Math.round(8 * mmToPx);
      const available = slotMaxY - y - textGap - blockGap;
      if (available < minBarcodePx) continue;

      hPx = Math.min(hPx, Math.max(minBarcodePx, Math.floor(available)));
      const barHeightMm = hPx / mmToPx;

      const barcodePng = await generateBarcodePng(barcodeValue, {
        widthPx: barWidthPx,
        barHeightMm,
      });
      if (barcodePng) {
        const fitted = await fitBarcodePngToSlot(barcodePng, barWidthPx, hPx);
        if (fitted) {
          const b64 = fitted.toString('base64');
          blocks.push(
            `<image x="${barX}" y="${y}" width="${barWidthPx}" height="${hPx}" href="data:image/png;base64,${b64}" />`
          );
        }
      }
      y += hPx;
      if (el.showText !== false) {
        y += Math.max(2, Math.round(lineGapPx * 0.25));
        y = appendWrappedTextSvg(blocks, {
          text: barcodeValue,
          x: barX,
          y,
          fontSize: digitFs,
          fill: '#000',
          maxWidthPx: barWidthPx,
          maxY: slotMaxY,
          lineGapPx,
          textAnchor: 'middle',
        });
      }
      y += blockGap;
    } else if (el.type === 'attribute' && el.attributeId != null) {
      const aid = String(el.attributeId);
      if (catAttrSet && !catAttrSet.has(aid)) continue;
      const val = attrValues[aid] ?? attrValues[Number(aid)];
      if (val == null || String(val).trim() === '') continue;
      const fs = resolveFontSizePx(el.fontSize, mmToPx);
      const attrName = attributeNames[aid] || attributeNames[Number(aid)] || '';
      const label = el.showName !== false && attrName ? `${attrName}: ` : '';
      y = appendWrappedTextSvg(blocks, {
        text: label + String(val),
        x: padL,
        y,
        fontSize: fs,
        fill: '#222',
        maxWidthPx: innerW,
        maxY: slotMaxY,
        lineGapPx,
      });
      y += blockGap;
    } else if (el.type === 'product_field' && el.fieldKey) {
      const val = getProductFieldDisplayValue(product, el.fieldKey);
      if (!val) continue;
      const fs = resolveFontSizePx(el.fontSize, mmToPx);
      const fieldLabel = labelProductFieldLabel(el.fieldKey);
      const prefix = el.showName !== false && fieldLabel ? `${fieldLabel}: ` : '';
      y = appendWrappedTextSvg(blocks, {
        text: prefix + val,
        x: padL,
        y,
        fontSize: fs,
        fill: '#222',
        maxWidthPx: innerW,
        maxY: slotMaxY,
        lineGapPx,
      });
      y += blockGap;
    } else if (el.type === 'kit_components') {
      const lines = formatKitComponentLines(product, el);
      if (!lines.length) continue;

      const fs = resolveFontSizePx(el.fontSize, mmToPx);
      const titleFs = resolveFontSizePx(el.titleFontSize ?? fs, mmToPx, 20);
      const weight = el.bold ? 'bold' : 'normal';

      if (el.showTitle !== false && y < slotMaxY) {
        y = appendWrappedTextSvg(blocks, {
          text: 'Состав:',
          x: padL,
          y,
          fontSize: titleFs,
          fontWeight: 'bold',
          fill: '#000',
          maxWidthPx: innerW,
          maxY: slotMaxY,
          lineGapPx,
        });
        y += blockGap;
      }

      for (const line of lines) {
        if (y >= slotMaxY) break;
        y = appendWrappedTextSvg(blocks, {
          text: line,
          x: padL,
          y,
          fontSize: fs,
          fontWeight: weight,
          fill: '#222',
          maxWidthPx: innerW,
          maxY: slotMaxY,
          lineGapPx,
        });
      }
      y += blockGap;
    }
  }

  const clipId = 'label-content-clip';
  return {
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">
  <defs>
    <clipPath id="${clipId}">
      <rect x="${padL}" y="${padT}" width="${innerW}" height="${Math.max(0, maxContentY - padT)}" />
    </clipPath>
  </defs>
  <rect width="100%" height="100%" fill="white"/>
  <g clip-path="url(#${clipId})">
  ${blocks.join('\n  ')}
  </g>
</svg>`,
    widthMm,
    heightMm,
  };
}

function buildSampleProduct(elements, attributeNames, categoryAttributeIds = []) {
  const catSet = new Set((categoryAttributeIds || []).map(String));
  const attribute_values = {};
  const sampleFields = {
    brand: 'Пример бренда',
    length: '150',
    width: '100',
    height: '50',
    weight: '250',
    product_type: 'product',
    category_name: 'Пример категории',
    organization_name: 'Пример организации',
    country_of_origin: 'Россия',
    barcodes: ['4601234567890'],
  };
  const hasKitBlock = (elements || []).some(
    (el) => el?.type === 'kit_components' && el.enabled !== false
  );
  for (const el of elements || []) {
    if (el.type === 'attribute' && el.attributeId != null && el.enabled !== false) {
      const aid = String(el.attributeId);
      if (catSet.size > 0 && !catSet.has(aid)) continue;
      const an = attributeNames[aid] || attributeNames[Number(el.attributeId)] || 'атрибут';
      attribute_values[aid] = `Пример: ${an}`;
    }
  }
  const sample = {
    name: 'Пример длинного названия товара для проверки переноса строк на этикетке',
    sku: 'ART-KIT-001',
    barcodes: ['4601234567890'],
    attribute_values,
    ...sampleFields,
  };
  if (hasKitBlock) {
    sample.product_type = 'kit';
    sample.kit_components = [
      { productId: 9001, quantity: 2, component_sku: 'PART-L', product_name: 'Комплектующая левая' },
      { productId: 9002, quantity: 2, component_sku: 'PART-R', product_name: 'Комплектующая правая' },
    ];
  }
  return sample;
}

function templateFromPayload(body, categoryId) {
  return {
    user_category_id: categoryId,
    size_preset: body.size_preset || body.sizePreset || '58x40',
    width_mm: body.width_mm ?? body.widthMm ?? null,
    height_mm: body.height_mm ?? body.heightMm ?? null,
    margin_top_mm: Number(body.margin_top_mm ?? body.marginTopMm ?? 2),
    margin_right_mm: Number(body.margin_right_mm ?? body.marginRightMm ?? 2),
    margin_bottom_mm: Number(body.margin_bottom_mm ?? body.marginBottomMm ?? 2),
    margin_left_mm: Number(body.margin_left_mm ?? body.marginLeftMm ?? 2),
    line_gap_mm: Number(body.line_gap_mm ?? body.lineGapMm ?? 1),
    elements: Array.isArray(body.elements) && body.elements.length ? body.elements : defaultLabelElements(),
  };
}

async function renderWithTemplate(template, product, format = 'png', { previewScale = null, marketplace = null } = {}) {
  const categoryId = template.user_category_id ?? template.userCategoryId;
  const categoryAttributeIds = await loadCategoryAttributeIds(categoryId);
  const attrIds = (template.elements || [])
    .filter((el) => el.type === 'attribute' && el.attributeId != null)
    .map((el) => Number(el.attributeId))
    .filter((id) => Number.isFinite(id));
  const attributeNames = await loadAttributeNames(attrIds);
  const mmToPx = resolveMmToPx(previewScale);
  const productForLabel = await enrichProductForLabel(product, template);
  const { svg, widthMm, heightMm } = await buildLabelSvg({
    template,
    product: productForLabel,
    attributeNames,
    categoryAttributeIds,
    mmToPx,
    marketplace,
  });
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  if (format === 'pdf') {
    let pdf = await pngToPdfBuffer(pngBuffer, widthMm, heightMm);
    return { buffer: pdf, contentType: 'application/pdf', widthMm, heightMm, pngBuffer };
  }
  return { buffer: pngBuffer, contentType: 'image/png', widthMm, heightMm, pngBuffer };
}

export const productLabelsService = {
  SIZE_PRESETS,
  defaultElements: defaultLabelElements,
  templateFromPayload,
  buildSampleProduct,

  async getTemplateForProduct(product, profileId = null) {
    const categoryId = product.user_category_id ?? product.userCategoryId ?? product.categoryId;
    if (!categoryId) return null;
    let tid = profileId;
    if (typeof tid === 'symbol' || tid == null || tid === '') {
      tid = product.profile_id ?? product.profileId ?? null;
    }
    let template = await categoryLabelTemplatesRepository.findByCategoryId(categoryId, tid);
    if (!template && tid != null) {
      template = await categoryLabelTemplatesRepository.findByCategoryId(categoryId, null);
    }
    if (!template) {
      template = {
        user_category_id: categoryId,
        size_preset: '58x40',
        margin_top_mm: 2,
        margin_right_mm: 2,
        margin_bottom_mm: 2,
        margin_left_mm: 2,
        line_gap_mm: 1,
        elements: defaultLabelElements(),
      };
    }
    return template;
  },

  async renderProductLabel(productId, { profileId = null, format = 'png', copies = 1, marketplace = null } = {}) {
    const product = await productsService.getByIdWithDetails(productId);
    if (!product) {
      const err = new Error('Товар не найден');
      err.statusCode = 404;
      throw err;
    }

    const template = await this.getTemplateForProduct(product, profileId);
    if (!template) {
      const err = new Error('У товара не указана категория. Назначьте категорию для печати этикетки.');
      err.statusCode = 400;
      throw err;
    }

    const copyCount = Math.min(99, Math.max(1, parseInt(copies, 10) || 1));
    const rendered = await renderWithTemplate(template, product, format === 'pdf' ? 'pdf' : 'png', {
      marketplace,
    });

    if (format === 'pdf' && copyCount > 1) {
      rendered.buffer = await duplicateLabelPdf(rendered.buffer, copyCount);
    }

    return rendered;
  },

  async renderPreview(templatePayload, { categoryId, productId = null, previewScale = 4 } = {}) {
    const template = templateFromPayload(templatePayload, categoryId);
    let product;

    if (productId != null && String(productId).trim() !== '') {
      product = await productsService.getByIdWithDetails(productId);
      if (!product) {
        const err = new Error('Товар не найден');
        err.statusCode = 404;
        throw err;
      }
      const prodCat = product.user_category_id ?? product.userCategoryId ?? product.categoryId;
      if (prodCat != null && categoryId != null && String(prodCat) !== String(categoryId)) {
        const err = new Error('Товар относится к другой категории');
        err.statusCode = 400;
        throw err;
      }
    } else {
      const categoryAttributeIds = await loadCategoryAttributeIds(categoryId);
      const attrIds = categoryAttributeIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      const attributeNames = await loadAttributeNames(attrIds);
      product = buildSampleProduct(template.elements, attributeNames, categoryAttributeIds);
    }

    return renderWithTemplate(template, product, 'png', { previewScale });
  },

  buildPrintHtml(productId) {
    return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"/>
<title>Этикетка товара</title>
<style>
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; }
  img { max-width: 100%; height: auto; display: block; }
  .err { font-family: system-ui, sans-serif; padding: 24px; color: #b00; }
</style>
</head>
<body>
<img id="label" alt="Этикетка" />
<script>
(function() {
  var img = document.getElementById('label');
  var url = '/api/products/${encodeURIComponent(String(productId))}/label?format=png';
  img.onload = function() {
    setTimeout(function() { try { window.print(); } catch(e) {} }, 300);
  };
  img.onerror = function() {
    document.body.innerHTML = '<p class="err">Не удалось загрузить этикетку</p>';
  };
  img.src = url;
})();
</script>
</body></html>`;
  },
};

export default productLabelsService;
