/**
 * Локальные этикетки грузомест WB: QR с полным `$Ts;…;TAS`, читаемый номер короба под ним.
 */

import bwipjs from 'bwip-js';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';
import fboSuppliesService from './fboSupplies.service.js';
import {
  decodeWbCargoTechCode,
  formatCargoBarcodeLabel,
  isWbCargoQrPayload,
} from '../utils/wbCargoQr.js';
import { getLabelSvgFontFaceCss, LABEL_FONT_FAMILY } from '../utils/labelFonts.js';

const PX_PER_MM = 12;
const LABEL_W_MM = 58;
const LABEL_H_MM = 40;

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderWbCargoLabelPng(barcode) {
  const W = Math.round(LABEL_W_MM * PX_PER_MM);
  const H = Math.round(LABEL_H_MM * PX_PER_MM);
  const pad = Math.round(2 * PX_PER_MM);
  const title = formatCargoBarcodeLabel(barcode);
  const tech = isWbCargoQrPayload(barcode) ? decodeWbCargoTechCode(barcode) : null;
  const qrPayload = String(barcode || '').trim();
  if (!qrPayload) {
    const err = new Error('Пустой штрихкод грузоместа');
    err.statusCode = 400;
    throw err;
  }

  const titleH = Math.round(H * 0.22);
  const techH = tech && tech !== title ? Math.round(H * 0.1) : 0;
  const qrAvail = H - pad * 2 - titleH - techH;
  const qrSide = Math.min(W - pad * 2, qrAvail);

  const qrBuf = await bwipjs.toBuffer({
    bcid: 'qrcode',
    text: qrPayload,
    scale: 4,
    paddingwidth: 0,
    paddingheight: 0,
    includetext: false,
  });
  const qrFitted = await sharp(qrBuf)
    .resize({ width: qrSide, height: qrSide, fit: 'fill', kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  const qrX = Math.round((W - qrSide) / 2);
  const qrY = pad + titleH;
  const titleFs = Math.min(36, Math.max(18, Math.floor((W - pad * 2) / Math.max(1, title.length) * 1.4)));
  const techFs = Math.max(10, Math.floor(techH * 0.75));
  const fontCss = getLabelSvgFontFaceCss();

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><style type="text/css"><![CDATA[
${fontCss}
  ]]></style></defs>
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="${W / 2}" y="${pad + titleH * 0.78}" font-family="${LABEL_FONT_FAMILY}" font-size="${titleFs}"
        font-weight="700" text-anchor="middle" fill="#000">${escXml(title)}</text>
  ${
    techH
      ? `<text x="${W / 2}" y="${qrY + qrSide + techH * 0.75}" font-family="${LABEL_FONT_FAMILY}" font-size="${techFs}"
        text-anchor="middle" fill="#333">${escXml(tech)}</text>`
      : ''
  }
</svg>`;

  return sharp(Buffer.from(svg))
    .composite([{ input: qrFitted, left: qrX, top: qrY }])
    .png()
    .toBuffer();
}

class FboWbCargoLabelsService {
  /**
   * PDF этикеток коробов WB по штрихкодам из сборки.
   * @param {string|number} supplyId
   * @param {string[]} cargoBarcodes
   * @param {{ profileId?: number }} [opts]
   */
  async buildCargoLabelsPdf(supplyId, cargoBarcodes, { profileId } = {}) {
    const supply = await fboSuppliesService.getById(supplyId, { profileId });
    if (!supply) {
      const err = new Error('Поставка не найдена');
      err.statusCode = 404;
      throw err;
    }
    const mp = String(supply.marketplace || '').toLowerCase();
    if (mp !== 'wb' && mp !== 'wildberries') {
      const err = new Error('Локальные этикетки QR доступны только для поставок Wildberries');
      err.statusCode = 400;
      throw err;
    }

    const packing = await fboSuppliesPackingService.getPackingState(supplyId, { profileId });
    const byBarcode = new Map(
      (packing?.cargoUnits || [])
        .filter((u) => u?.barcode)
        .map((u) => [String(u.barcode).trim(), u])
    );

    const requested = [...new Set((cargoBarcodes || []).map((b) => String(b).trim()).filter(Boolean))];
    if (!requested.length) {
      const err = new Error('Укажите штрихкоды грузомест');
      err.statusCode = 400;
      throw err;
    }

    const missing = requested.filter((b) => !byBarcode.has(b));
    if (missing.length) {
      const err = new Error(
        `Грузоместа не найдены в сборке: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`
      );
      err.statusCode = 400;
      throw err;
    }

    const pdf = await PDFDocument.create();
    const pageW = (LABEL_W_MM / 25.4) * 72;
    const pageH = (LABEL_H_MM / 25.4) * 72;

    for (const barcode of requested) {
      const png = await renderWbCargoLabelPng(barcode);
      const img = await pdf.embedPng(png);
      const page = pdf.addPage([pageW, pageH]);
      page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
    }

    const buffer = Buffer.from(await pdf.save());
    return { buffer, cargoIds: requested };
  }
}

export default new FboWbCargoLabelsService();
