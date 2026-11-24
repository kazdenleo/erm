/**
 * PDF этикеток ячеек склада: адрес крупно, расшифровка уровней и Code128.
 * Текст рисуется в SVG → PNG (sharp), т.к. стандартные шрифты pdf-lib без кириллицы.
 */

import bwipjs from 'bwip-js';
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { query } from '../config/database.js';
import { effectiveBarcode } from './addressStorage.service.js';
import productLabelsService from './productLabels.service.js';
import { getLabelSvgFontFaceCss, labelSvgFontFamily } from '../utils/labelFonts.js';

/** 8 px/мм ≈ 203 dpi — модули Code128 целыми точками термоголовы. */
const PX_PER_MM = 8;
const PT_PER_MM = 72 / 25.4;
const BARCODE_MODULE_MM = 0.5;
const BARCODE_MIN_SCALE = 3;

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fitFontSize(text, maxWidthPx, maxHeightPx) {
  const len = Math.max(1, String(text).length);
  return Math.max(10, Math.min(maxHeightPx, Math.floor(maxWidthPx / (len * 0.62))));
}

export async function renderLabelPng(loc, settings) {
  const W = Math.round(settings.labelWidthMm * PX_PER_MM);
  const H = Math.round(settings.labelHeightMm * PX_PER_MM);
  const pad = Math.round(2 * PX_PER_MM);
  const barcodeText = effectiveBarcode(loc);

  const showBarcodeText = barcodeText !== loc.code;
  const codeH = Math.round(H * 0.3);
  const legendH = Math.round(H * 0.11);
  const captionH = showBarcodeText ? Math.round(H * 0.08) : 0;
  const barH = H - pad * 2 - codeH - legendH - captionH - Math.round(H * 0.04);

  // X=0.375 мм (3 px @ 203 dpi), quiet zone 10; ширину не растягиваем — только высоту.
  const maxBarW = Math.max(40, W - pad * 2);
  const barHeightMm = Math.max(15, barH / PX_PER_MM);
  const payload = String(barcodeText || '')
    .toUpperCase()
    .replace(/[^0-9A-Z\-.$\/+%\s]/g, '');
  const baseOpts = {
    height: barHeightMm,
    includetext: false,
    paddingwidth: 10,
    paddingheight: 0,
    inkspread: 0,
  };
  let raw = null;
  let drawW = 0;
  outer: for (
    let scale = Math.max(BARCODE_MIN_SCALE, Math.round(BARCODE_MODULE_MM * PX_PER_MM));
    scale >= BARCODE_MIN_SCALE;
    scale -= 1
  ) {
    for (const bcid of ['code128', 'code39']) {
      const buf = await bwipjs.toBuffer({ ...baseOpts, bcid, text: payload || String(barcodeText), scale });
      const meta = await sharp(buf).metadata();
      if (meta.width && meta.width <= maxBarW) {
        raw = buf;
        drawW = meta.width;
        break outer;
      }
    }
  }
  if (!raw) {
    raw = await bwipjs.toBuffer({
      ...baseOpts,
      bcid: 'code128',
      text: payload || String(barcodeText),
      scale: BARCODE_MIN_SCALE,
    });
    drawW = Math.min((await sharp(raw).metadata()).width || maxBarW, maxBarW);
  }
  const bc = await sharp(raw)
    .resize({
      width: drawW,
      height: Math.max(24, barH),
      fit: 'fill',
      kernel: sharp.kernel.nearest,
    })
    .png()
    .toBuffer();
  const barLeft = Math.max(pad, Math.round((W - drawW) / 2));

  const levels = Array.isArray(settings.levels) ? settings.levels : [];
  const legend = (loc.parts || [])
    .map((p, i) => `${levels[i]?.label || ''} ${p}`.trim())
    .join(' · ');
  const codeFont = fitFontSize(loc.code, W - pad * 2, codeH);
  const legendFont = fitFontSize(legend || ' ', W - pad * 2, legendH);
  const barY = pad + codeH + legendH + Math.round(H * 0.03);

  const fontCss = getLabelSvgFontFaceCss();
  const ff = labelSvgFontFamily();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><style type="text/css"><![CDATA[
${fontCss}
  ]]></style></defs>
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="${W / 2}" y="${pad + codeH * 0.82}" font-family="${ff}"
        font-size="${codeFont}" font-weight="700" text-anchor="middle" fill="#000">${escXml(loc.code)}</text>
  <text x="${W / 2}" y="${pad + codeH + legendH * 0.8}" font-family="${ff}"
        font-size="${legendFont}" text-anchor="middle" fill="#000">${escXml(legend)}</text>
  ${
    showBarcodeText
      ? `<text x="${W / 2}" y="${barY + barH + captionH * 0.85}" font-family="${ff}" font-size="${Math.round(
          captionH * 0.85
        )}" text-anchor="middle" fill="#000">${escXml(barcodeText)}</text>`
      : ''
  }
</svg>`;

  return sharp(Buffer.from(svg))
    .composite([{ input: bc, left: barLeft, top: barY }])
    .png()
    .toBuffer();
}

function locationLegend(loc, settings) {
  const levels = Array.isArray(settings?.levels) ? settings.levels : [];
  return (loc.parts || [])
    .map((p, i) => `${levels[i]?.label || ''} ${p}`.trim())
    .filter(Boolean)
    .join(' · ');
}

async function loadAssignedProductsByLocationIds(locationIds) {
  const ids = [...new Set((locationIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const r = await query(
    `SELECT DISTINCT ON (a.location_id)
            a.location_id, p.id AS product_id, p.name, p.sku
     FROM product_storage_assignments a
     JOIN products p ON p.id = a.product_id
     WHERE a.location_id = ANY($1::bigint[])
     ORDER BY a.location_id, p.name NULLS LAST, p.id`,
    [ids]
  );
  const map = new Map();
  for (const row of r.rows || []) {
    map.set(Number(row.location_id), {
      id: Number(row.product_id),
      name: row.name || '',
      sku: row.sku || '',
    });
  }
  return map;
}

export async function buildLocationLabelsPdf(
  locations,
  settings,
  { template = null, warehouseName = '', pageMode = 'single' } = {}
) {
  const mode = pageMode === 'a4' ? 'a4' : 'single';
  const saved = template?.saved === true || template?.id != null;
  if (saved) {
    const list = locations || [];
    const byLoc = await loadAssignedProductsByLocationIds(list.map((l) => l.id));
    const cells = list.map((loc) => ({
      id: loc.id,
      code: loc.code,
      legend: locationLegend(loc, settings),
      barcode: effectiveBarcode(loc),
      warehouseName: warehouseName || '',
      product: byLoc.get(Number(loc.id)) || null,
    }));
    return productLabelsService.renderCellLabelsPdf(template, cells, { pageMode: mode });
  }

  const labelW = Number(settings?.labelWidthMm) || 58;
  const labelH = Number(settings?.labelHeightMm) || 40;
  const list = locations || [];
  const pdf = await PDFDocument.create();

  if (mode !== 'a4') {
    const wPt = labelW * PT_PER_MM;
    const hPt = labelH * PT_PER_MM;
    for (const loc of list) {
      const png = await renderLabelPng(loc, {
        ...settings,
        labelWidthMm: labelW,
        labelHeightMm: labelH,
      });
      const img = await pdf.embedPng(png);
      const page = pdf.addPage([wPt, hPt]);
      page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    }
    return Buffer.from(await pdf.save());
  }

  const A4_W_MM = 210;
  const A4_H_MM = 297;
  const sheetMarginMm = 2;
  const gapMm = 0;
  const usableW = A4_W_MM - sheetMarginMm * 2;
  const usableH = A4_H_MM - sheetMarginMm * 2;
  if (labelW > usableW || labelH > usableH) {
    const err = new Error(
      `Этикетка ${labelW}×${labelH} мм не помещается на лист А4 (доступно ${usableW}×${usableH} мм с полями). Уменьшите размер или печатайте «На этикетках».`
    );
    err.statusCode = 400;
    throw err;
  }
  const cols = Math.max(1, Math.floor((usableW + gapMm) / (labelW + gapMm)));
  const rows = Math.max(1, Math.floor((usableH + gapMm) / (labelH + gapMm)));
  const perPage = cols * rows;
  const pageWPt = A4_W_MM * PT_PER_MM;
  const pageHPt = A4_H_MM * PT_PER_MM;
  const drawW = labelW * PT_PER_MM;
  const drawH = labelH * PT_PER_MM;
  const cutColor = rgb(0.35, 0.35, 0.35);
  let indexOnPage = 0;
  let page = null;

  for (const loc of list) {
    if (indexOnPage === 0) {
      page = pdf.addPage([pageWPt, pageHPt]);
    }
    const png = await renderLabelPng(loc, {
      ...settings,
      labelWidthMm: labelW,
      labelHeightMm: labelH,
    });
    const img = await pdf.embedPng(png);
    const col = indexOnPage % cols;
    const row = Math.floor(indexOnPage / cols);
    const x = (sheetMarginMm + col * (labelW + gapMm)) * PT_PER_MM;
    const y = pageHPt - (sheetMarginMm + row * (labelH + gapMm) + labelH) * PT_PER_MM;
    page.drawImage(img, { x, y, width: drawW, height: drawH });
    page.drawRectangle({
      x,
      y,
      width: drawW,
      height: drawH,
      borderWidth: 0.6,
      borderColor: cutColor,
    });
    indexOnPage += 1;
    if (indexOnPage >= perPage) indexOnPage = 0;
  }

  if (!list.length) {
    pdf.addPage([pageWPt, pageHPt]);
  }
  return Buffer.from(await pdf.save());
}
