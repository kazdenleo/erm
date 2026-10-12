/**
 * PDF этикеток ячеек склада: адрес крупно, расшифровка уровней и Code128.
 * Текст рисуется в SVG → PNG (sharp), т.к. стандартные шрифты pdf-lib без кириллицы.
 */

import bwipjs from 'bwip-js';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { effectiveBarcode } from './addressStorage.service.js';

const PX_PER_MM = 12;
const PT_PER_MM = 72 / 25.4;

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

  // Ширина модуля — целое число пикселей, иначе сканер хуже читает; растягиваем только по высоте.
  const bwipOpts = { bcid: 'code128', text: barcodeText, height: 10, includetext: false, paddingwidth: 0, paddingheight: 0 };
  const unit = await sharp(await bwipjs.toBuffer({ ...bwipOpts, scale: 1 })).metadata();
  const quietModules = 20;
  const scale = Math.max(1, Math.floor((W - pad * 2) / Math.max(1, (unit.width || 1) + quietModules)));
  const raw = await bwipjs.toBuffer({ ...bwipOpts, scale });
  const rawMeta = await sharp(raw).metadata();
  const bc = await sharp(raw)
    .resize({ width: rawMeta.width, height: barH, fit: 'fill', kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  const barLeft = Math.round((W - rawMeta.width) / 2);

  const levels = Array.isArray(settings.levels) ? settings.levels : [];
  const legend = (loc.parts || [])
    .map((p, i) => `${levels[i]?.label || ''} ${p}`.trim())
    .join(' · ');
  const codeFont = fitFontSize(loc.code, W - pad * 2, codeH);
  const legendFont = fitFontSize(legend || ' ', W - pad * 2, legendH);
  const barY = pad + codeH + legendH + Math.round(H * 0.03);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="${W / 2}" y="${pad + codeH * 0.82}" font-family="Arial, 'DejaVu Sans', sans-serif"
        font-size="${codeFont}" font-weight="700" text-anchor="middle" fill="#000">${escXml(loc.code)}</text>
  <text x="${W / 2}" y="${pad + codeH + legendH * 0.8}" font-family="Arial, 'DejaVu Sans', sans-serif"
        font-size="${legendFont}" text-anchor="middle" fill="#000">${escXml(legend)}</text>
  ${
    showBarcodeText
      ? `<text x="${W / 2}" y="${barY + barH + captionH * 0.85}" font-family="Arial, sans-serif" font-size="${Math.round(
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

export async function buildLocationLabelsPdf(locations, settings) {
  const pdf = await PDFDocument.create();
  const wPt = settings.labelWidthMm * PT_PER_MM;
  const hPt = settings.labelHeightMm * PT_PER_MM;
  for (const loc of locations) {
    const png = await renderLabelPng(loc, settings);
    const img = await pdf.embedPng(png);
    const page = pdf.addPage([wPt, hPt]);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  }
  return Buffer.from(await pdf.save());
}
