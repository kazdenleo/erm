/**
 * Шаблон Excel для импорта поставок FBO и выгрузка состава по грузоместам.
 */

import ExcelJS from 'exceljs';
import fboSuppliesPackingService from './fboSuppliesPacking.service.js';

const SHEET_NAME = 'Товары';

const HEADERS = [
  ['Артикул', 'Количество'],
  ['sku', 'quantity'],
];

const EXAMPLES = [
  ['ART-001', 10],
  ['ART-002', 5],
];

function writeRow(ws, rowIndex, values, font) {
  const row = ws.getRow(rowIndex);
  values.forEach((val, colIndex) => {
    row.getCell(colIndex + 1).value = val;
  });
  if (font) row.font = font;
}

function formatExpiryYmd(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function normalizeMp(marketplace) {
  const m = String(marketplace || 'ozon').toLowerCase();
  if (m === 'wb' || m === 'wildberries') return 'wb';
  return 'ozon';
}

const OZON_PACKING_HEADERS = [
  'Артикул товара',
  'Кол-во товаров',
  'Зона размещения',
  'ШК ГМ',
  'Срок годности ДО',
];

const WB_PACKING_HEADERS = [
  'Баркод товара',
  'Кол-во товаров',
  'ШК короба',
  'Срок годности',
];

class FboSuppliesExportService {
  async buildPackingExportBuffer(supplyId, { profileId } = {}) {
    const { marketplace, rows } = await fboSuppliesPackingService.getPackingExportRows(supplyId, {
      profileId,
    });
    if (!rows.length) {
      const err = new Error('Нет упакованных товаров в грузоместах для выгрузки');
      err.statusCode = 400;
      throw err;
    }

    const mp = normalizeMp(marketplace);
    const headers = mp === 'wb' ? WB_PACKING_HEADERS : OZON_PACKING_HEADERS;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERM';
    const ws = wb.addWorksheet('Состав по грузоместам');

    writeRow(ws, 1, headers, { bold: true });

    rows.forEach((row, i) => {
      const expiry = formatExpiryYmd(row.expiresAt);
      const values =
        mp === 'wb'
          ? [row.productBarcode || '', row.quantity, row.cargoBarcode || '', expiry]
          : [row.article || '', row.quantity, row.placementZone || '', row.cargoBarcode || '', expiry];
      writeRow(ws, i + 2, values);
    });

    headers.forEach((_, colIndex) => {
      ws.getColumn(colIndex + 1).width = colIndex === 0 ? 22 : 16;
    });

    const buffer = await wb.xlsx.writeBuffer();
    return {
      buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      marketplace: mp,
    };
  }

  async buildImportTemplateBuffer() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ERM';
    const ws = wb.addWorksheet(SHEET_NAME);

    HEADERS.forEach((row, i) => {
      writeRow(ws, i + 1, row, i === 0 ? { bold: true } : { italic: true, color: { argb: 'FF666666' } });
    });
    EXAMPLES.forEach((row, i) => {
      writeRow(ws, HEADERS.length + 1 + i, row);
    });

    ws.getColumn(1).width = 24;
    ws.getColumn(2).width = 14;

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  }
}

export default new FboSuppliesExportService();
